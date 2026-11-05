import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CuSessionManager } from "../lib/core.mjs";

async function waitForProcessExit(pid, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      return true;
    }
  }
  return false;
}

test("CuSessionManager can resolve bundled binary in bin/cu", () => {
  const manager = new CuSessionManager();
  const bin = manager.resolveBinaryPath();
  assert.ok(typeof bin === "string" && bin.length > 0, "bin path should be non-empty");
  assert.ok(bin.endsWith("/cu"), `expected path ending with /cu, got ${bin}`);
});

test("CuSessionManager resolvePreviewBinary prefers sibling preview binary", () => {
  const manager = new CuSessionManager();
  const previewBin = manager.resolvePreviewBinary();
  assert.ok(typeof previewBin === "string" && previewBin.length > 0);
  assert.ok(previewBin.includes("cu"), `expected cu preview binary, got ${previewBin}`);
});

test("CuSessionManager ensureServiceRunning reports ok when its own helper responds", async () => {
  // Isolated state and port: this must never borrow the service the person's
  // desk is already using, and must never write the real ~/.cu/config.json.
  const isolatedDir = mkdtempSync(join(tmpdir(), "cu-daemon-"));
  const manager = new CuSessionManager({ stateDir: isolatedDir });
  let pid = null;
  try {
    const status = await manager.ensureServiceRunning(AbortSignal.timeout(4000));
    assert.equal(status.ok, true);
    pid = manager.managedServiceProcess?.pid ?? null;
    assert.ok(pid > 0, "the manager must have started its own helper");
    assert.equal(status.managed, true);
  } finally {
    manager.stopManagedService();
    if (pid) assert.equal(await waitForProcessExit(pid), true, `helper ${pid} did not exit`);
    rmSync(isolatedDir, { recursive: true, force: true });
  }
});
