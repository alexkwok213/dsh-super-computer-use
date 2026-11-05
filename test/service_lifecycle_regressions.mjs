import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import http from "node:http";
import { CuSessionManager } from "../lib/core.mjs";

test("CuSessionManager resolveBinaryPath prefers plugin bin/cu and eliminates legacy app fallbacks", () => {
  const manager = new CuSessionManager();
  const bin = manager.resolveBinaryPath();
  assert.ok(typeof bin === "string" && bin.length > 0, "binary path must be non-empty");
  assert.ok(bin.endsWith("/cu"), `expected path ending with /cu, got ${bin}`);
  // Candidates must NOT contain Computer Use.app or Application Support/cu
  assert.equal(bin.includes("Computer Use.app"), false, "must not resolve to legacy /Applications/Computer Use.app");
  assert.equal(bin.includes("Application Support/cu"), false, "must not resolve to ~/Library/Application Support/cu");
});

test("CuSessionManager openSystemSettings opens correct macOS preference panes", () => {
  const manager = new CuSessionManager();
  assert.equal(manager.openSystemSettings("accessibility"), true);
  assert.equal(manager.openSystemSettings("screenRecording"), true);
});

test("Clean install authentication: manager boots helper and passes authentication without ~/.cu/config.json", async () => {
  const isolatedDir = mkdtempSync(join(tmpdir(), "cu-clean-install-"));
  try {
    const manager = new CuSessionManager({
      stateDir: isolatedDir,
      // Provide an ephemeral port so we don't interfere with any existing dev daemon
      explicitUrl: "http://127.0.0.1:49152",
    });

    // Ensure clean state: isolatedDir has no config.json
    assert.equal(existsSync(join(isolatedDir, "config.json")), false);

    // ensureServiceRunning must successfully boot helper and negotiate auth
    const startResult = await manager.ensureServiceRunning(AbortSignal.timeout(6000));
    assert.equal(startResult.ok, true, `failed to start service: ${JSON.stringify(startResult)}`);

    // Verify manager holds valid auth credentials
    const { token, baseUrl } = manager.readServiceConfig();
    assert.ok(typeof token === "string" && token.length > 0, "token must be populated without legacy config");

    // Authenticated request to /v1/status and /v1/windows must succeed without 401
    const statusRes = await fetch(`${baseUrl}/v1/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(statusRes.status, 200, "status should return 200");

    // Clean up managed process
    manager.stopManagedService();
  } finally {
    rmSync(isolatedDir, { recursive: true, force: true });
  }
});

test("Concurrent ensureServiceRunning launches exactly one managed helper process", async () => {
  const isolatedDir = mkdtempSync(join(tmpdir(), "cu-concurrent-"));
  try {
    const manager = new CuSessionManager({
      stateDir: isolatedDir,
      explicitUrl: "http://127.0.0.1:49153",
    });

    const [r1, r2, r3] = await Promise.all([
      manager.ensureServiceRunning(AbortSignal.timeout(6000)),
      manager.ensureServiceRunning(AbortSignal.timeout(6000)),
      manager.ensureServiceRunning(AbortSignal.timeout(6000)),
    ]);

    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(r3.ok, true);
    assert.ok(manager.managedServiceProcess, "managed service process must exist");
    const pid = manager.managedServiceProcess.pid;
    assert.ok(pid > 0);

    manager.stopManagedService();
    assert.equal(manager.managedServiceProcess, null);
  } finally {
    rmSync(isolatedDir, { recursive: true, force: true });
  }
});

test("Foreign service detection: manager rejects silent reuse of unauthorized foreign service on same port", async () => {
  // Start a dummy HTTP server on an ephemeral port that returns 200 for /v1/status but 401 for /v1/exec
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "foreign-unauthorized" }));
      return;
    }
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
  });

  await new Promise((resolve) => server.listen(49154, "127.0.0.1", resolve));
  const isolatedDir = mkdtempSync(join(tmpdir(), "cu-foreign-"));

  try {
    const manager = new CuSessionManager({
      stateDir: isolatedDir,
      explicitUrl: "http://127.0.0.1:49154",
      explicitToken: "my-expected-token",
    });

    // ensureServiceRunning must detect that this port cannot authenticate with our token
    // and refuse silent reuse
    const res = await manager.ensureServiceRunning(AbortSignal.timeout(1500));
    assert.equal(res.ok, false, "must not report success when existing service rejects authentication");
    assert.match(res.error ?? "", /unauthorized|auth_failed|foreign_service/);
  } finally {
    server.close();
    rmSync(isolatedDir, { recursive: true, force: true });
  }
});

test("Lifecycle reclamation: stopManagedService cleanly terminates child without leaving zombie", async () => {
  const isolatedDir = mkdtempSync(join(tmpdir(), "cu-reclaim-"));
  try {
    const manager = new CuSessionManager({
      stateDir: isolatedDir,
      explicitUrl: "http://127.0.0.1:49155",
    });

    const startRes = await manager.ensureServiceRunning(AbortSignal.timeout(6000));
    assert.equal(startRes.ok, true);
    const child = manager.managedServiceProcess;
    assert.ok(child);
    const pid = child.pid;

    // Check process is alive
    assert.doesNotThrow(() => process.kill(pid, 0));

    // Call stopManagedService
    manager.stopManagedService();
    assert.equal(manager.managedServiceProcess, null);

    // Wait up to 1 second for OS to reap the process
    const deadline = Date.now() + 1500;
    let isDead = false;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        isDead = true;
        break;
      }
    }
    assert.equal(isDead, true, `process ${pid} should have terminated after stopManagedService`);
  } finally {
    rmSync(isolatedDir, { recursive: true, force: true });
  }
});

test("Disposed guard: ensureServiceRunning refuses to launch helper during or after dispose", async () => {
  const isolatedDir = mkdtempSync(join(tmpdir(), "cu-dispose-"));
  try {
    const manager = new CuSessionManager({
      stateDir: isolatedDir,
      explicitUrl: "http://127.0.0.1:49156",
    });

    manager.dispose();
    const res = await manager.ensureServiceRunning(AbortSignal.timeout(1000));
    assert.equal(res.ok, false);
    assert.match(res.error, /disposed/);
    assert.equal(manager.managedServiceProcess, null);
  } finally {
    rmSync(isolatedDir, { recursive: true, force: true });
  }
});

test("Host abnormal exit simulation: helper with watch-parent terminates when parent pipe closes", async () => {
  const manager = new CuSessionManager();
  const bin = manager.resolveBinaryPath();
  assert.ok(existsSync(bin), `binary must exist at ${bin}`);
  const freePort = await manager._findAvailablePort(49158);

  // Spawn helper with pipe for stdin and --watch-parent flag
  const child = spawn(bin, ["service", "--port", String(freePort), "--watch-parent"], {
    stdio: ["pipe", "ignore", "ignore"],
  });

  const pid = child.pid;
  assert.ok(pid > 0);

  // Let it boot and confirm it is alive
  await new Promise((r) => setTimeout(r, 300));
  assert.doesNotThrow(() => process.kill(pid, 0));

  // Simulate parent abnormal exit or host termination: close child stdin pipe
  child.stdin.end();

  // Child should detect EOF and exit on its own within 1.5 seconds
  const deadline = Date.now() + 2000;
  let exited = false;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 60));
    } catch {
      exited = true;
      break;
    }
  }
  assert.equal(exited, true, `helper ${pid} must automatically self-terminate when parent pipe closes`);
});
