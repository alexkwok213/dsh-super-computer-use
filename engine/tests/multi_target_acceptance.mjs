// Real two-target acceptance against the built universal helper.
//
//   1. starts its OWN service on an isolated state dir/port/token;
//   2. launches two owned `cu demo` windows and never touches user data;
//   3. verifies background click/text by reading each app's own state;
//   4. measures concurrent reads across targets (per-pid native lanes);
//   5. stops A, proves B still works, then stop-all and resource reclamation;
//   6. records frontmost, cursor position, clipboard and preview frames.
//
// It does not claim a user-in-the-loop test: no real keystrokes are injected
// into a third app. Run with `node engine/tests/multi_target_acceptance.mjs`.
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CuSessionManager } from "../../lib/core.mjs";
import { createCuUiRegistry } from "../../lib/cu-ui-session.mjs";
import { registerCuTools } from "../../lib/index.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BIN = process.env.CU_BIN ?? new URL("../../bin/cu", import.meta.url).pathname;
const PREVIEW_BIN = process.env.CU_PREVIEW_BIN ?? new URL("../../bin/cu-preview", import.meta.url).pathname;

function fail(message, detail) {
  const error = new Error(message);
  error.detail = detail;
  throw error;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function readClipboard() {
  try {
    return execFileSync("pbpaste", { encoding: "utf8" });
  } catch {
    return null;
  }
}

function cursorPosition() {
  try {
    return execFileSync(
      "swift",
      ["-e", "import AppKit; let p = NSEvent.mouseLocation; print(\"\\(p.x),\\(p.y)\")"],
      { encoding: "utf8", timeout: 20000 },
    ).trim();
  } catch {
    return null;
  }
}

function counterOf(snapshot) {
  const line = (snapshot?.lines ?? []).find((entry) => entry.includes("Acceptance Button"));
  const match = /Acceptance Button (\d+)/.exec(line ?? "");
  return match ? Number(match[1]) : -1;
}

function textFieldOf(snapshot) {
  const line = (snapshot?.lines ?? []).find(
    (entry) => /AXTextField/.test(entry) && /Acceptance Field/.test(entry),
  );
  return line ? line.split(" ")[0] : null;
}

async function findWindow(manager, child, title) {
  for (let i = 0; i < 80; i += 1) {
    const listing = await manager.exec(["windows"]).catch(() => null);
    const win = (listing?.windows ?? []).find(
      (entry) => entry.title === title && entry.pid === child.pid && entry.windowId > 0,
    );
    if (win) return win;
    await sleep(150);
  }
  fail(`${title} window did not appear`);
}

async function rawSnapshot(manager, pid, windowId, targetId) {
  return manager.exec(
    ["snapshot", "--pid", String(pid), "--window", String(windowId), "--all"],
    undefined,
    { targetId },
  );
}

async function readFirstPreviewFrame(windowId, targetId, generation) {
  const child = spawn(
    PREVIEW_BIN,
    [
      "preview-stream", "--window", String(windowId), "--session", "acceptance",
      "--generation", String(generation), "--target-id", targetId,
      "--fps", "2", "--max-dim", "480", "--seconds", "5",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  try {
    const result = await new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const timer = setTimeout(() => reject(new Error("preview first frame timeout")), 8000);
      child.stdout.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length < 8) return;
        const metaLength = buffer.readUInt32BE(0);
        const jpegLength = buffer.readUInt32BE(4);
        if (buffer.length < 8 + metaLength + jpegLength) return;
        const meta = JSON.parse(buffer.subarray(8, 8 + metaLength).toString("utf8"));
        clearTimeout(timer);
        resolve({ meta, bytes: jpegLength });
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`preview stream exited ${code}`));
      });
    });
    return result;
  } finally {
    try { child.stdin.end(); } catch {}
    try { child.kill("SIGTERM"); } catch {}
  }
}

async function main() {
  if (!existsSync(BIN)) fail("bin/cu missing; run npm run build:bin");
  if (!existsSync(PREVIEW_BIN)) fail("bin/cu-preview missing");
  const stateDir = mkdtempSync(join(tmpdir(), "cu-multi-accept-"));
  const port = await freePort();
  const token = `accept-${Math.random().toString(36).slice(2)}`;
  const service = spawn(BIN, ["service", "--port", String(port), "--token", token], {
    env: { ...process.env, CU_STATE_DIR: stateDir },
    stdio: ["pipe", "ignore", "ignore"],
  });
  const fixtures = [];
  const fixtureSource = new URL("./fixtures/acceptance_target.swift", import.meta.url).pathname;
  const fixtureBinary = join(stateDir, "acceptance-target");
  execFileSync("swiftc", ["-O", "-swift-version", "5", "-o", fixtureBinary, fixtureSource], {
    stdio: "ignore",
    timeout: 60000,
  });
  const result = { ok: false, checks: {}, evidence: {} };
  let manager;
  try {
    for (let i = 0; i < 60; i += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/status`, { signal: AbortSignal.timeout(300) });
        if (res.ok) break;
      } catch {}
      await sleep(100);
    }
    manager = new CuSessionManager({
      stateDir,
      serviceUrl: `http://127.0.0.1:${port}`,
      token,
      binaryPath: BIN,
      previewBinaryPath: PREVIEW_BIN,
    });
    manager.writeActivity = () => {};
    manager.startScreenIndicator = () => {};
    manager.stopScreenIndicator = async () => {};
    manager.spawnIndicator = () => null;
    manager._cursorWrite = () => true;
    manager.startCursorOverlay = () => null;
    manager.stopCursorOverlay = () => {};
    manager.startNativePreview = () => false;
    manager.stopNativePreview = () => false;
    manager.warmCaptureDaemon = () => {};

    const targetAppA = spawn(fixtureBinary, [], {
      stdio: "ignore",
      env: { ...process.env, CU_ACCEPT_LABEL: "A", CU_ACCEPT_X: "80", CU_ACCEPT_Y: "120" },
    });
    const targetAppB = spawn(fixtureBinary, [], {
      stdio: "ignore",
      env: { ...process.env, CU_ACCEPT_LABEL: "B", CU_ACCEPT_X: "540", CU_ACCEPT_Y: "120" },
    });
    fixtures.push(targetAppA, targetAppB);
    const winA = await findWindow(manager, targetAppA, "CU Acceptance A");
    const winB = await findWindow(manager, targetAppB, "CU Acceptance B");
    result.evidence.windows = { A: { pid: winA.pid, windowId: winA.windowId }, B: { pid: winB.pid, windowId: winB.windowId } };

    const tools = new Map();
    const ctx = {
      tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
      get() { return undefined; },
    };
    const registry = createCuUiRegistry({ manager });
    registerCuTools({
      ctx, manager, registry,
      config: { autoSession: false, idleStopSeconds: 0, viewerMode: "native", uiProbe: false },
    });
    const execFor = (id) => ({ agent: { id }, signal: new AbortController().signal });
    const call = (id, name, args) => tools.get(name).execute(args, execFor(id));

    // Baseline is taken AFTER the two owned fixture windows exist, so launching
    // test apps cannot be confused with an action stealing focus. From here on,
    // every observation/action below must leave this app in front.
    const frontBefore = await manager.exec(["frontmost"]);
    const cursorBefore = cursorPosition();
    const clipboardBefore = readClipboard();

    const startedA = await call("accept", "cu_session", {
      action: "start", windowId: winA.windowId, pid: winA.pid, appName: "Demo A",
      dockDsh: false, splitScreen: false, capsule: false, halo: false, cursor: false, preview: false,
    });
    const startedB = await call("accept", "cu_session", {
      action: "start", windowId: winB.windowId, pid: winB.pid, appName: "Demo B",
      dockDsh: false, splitScreen: false, capsule: false, halo: false, cursor: false, preview: false,
    });
    if (!startedA.ok || !startedB.ok) fail("session start failed", { startedA, startedB });
    const targetA = startedA.targetId;
    const targetB = startedB.targetId;
    result.evidence.targets = { A: targetA, B: targetB };

    const snapA = await call("accept", "cu_snapshot", { pid: winA.pid, windowId: winA.windowId, full: true });
    const snapB = await call("accept", "cu_snapshot", { pid: winB.pid, windowId: winB.windowId, full: true });
    if (!snapA.ok || !snapB.ok) fail("snapshot failed", { snapA, snapB });
    const buttonA = (snapA.lines ?? []).find((line) => line.includes("Acceptance Button"));
    const buttonB = (snapB.lines ?? []).find((line) => line.includes("Acceptance Button"));
    if (!buttonA || !buttonB) fail("acceptance buttons missing");
    const countA = counterOf(snapA);
    const countB = counterOf(snapB);

    const concurrentStarted = Date.now();
    const [clickA, clickB] = await Promise.all([
      call("accept", "cu_click", {
        targetId: targetA, pid: winA.pid, windowId: winA.windowId,
        ref: buttonA.split(" ")[0], snapshotId: snapA.snapshotId,
        expect: { query: `Acceptance Button ${countA + 1}`, timeoutMs: 2500 },
        observe: false, preview: false,
      }),
      call("accept", "cu_click", {
        targetId: targetB, pid: winB.pid, windowId: winB.windowId,
        ref: buttonB.split(" ")[0], snapshotId: snapB.snapshotId,
        expect: { query: `Acceptance Button ${countB + 1}`, timeoutMs: 2500 },
        observe: false, preview: false,
      }),
    ]);
    result.evidence.backgroundClicksMs = Date.now() - concurrentStarted;
    result.checks.bothTargetsRetainTokens =
      clickA.via === "ax-worker-token" && clickB.via === "ax-worker-token";
    if (!clickA.ok || clickA.verified !== true) fail("A click not verified", clickA);
    if (!clickB.ok || clickB.verified !== true) fail("B click not verified", clickB);
    const afterClickA = await call("accept", "cu_snapshot", {
      targetId: targetA, pid: winA.pid, windowId: winA.windowId, full: true,
    });
    const afterClickB = await call("accept", "cu_snapshot", {
      targetId: targetB, pid: winB.pid, windowId: winB.windowId, full: true,
    });
    result.checks.backgroundClicksVerified =
      counterOf(afterClickA) === countA + 1 && counterOf(afterClickB) === countB + 1;
    result.evidence.clicks = {
      A: { before: countA, after: counterOf(afterClickA), via: clickA.via ?? null },
      B: { before: countB, after: counterOf(afterClickB), via: clickB.via ?? null },
    };
    if (!result.checks.backgroundClicksVerified) fail("counter did not advance", result.evidence.clicks);

    const textA = textFieldOf(snapA);
    const textB = textFieldOf(snapB);
    result.evidence.textFields = { A: textA, B: textB };
    const tokenText = `multi-${Date.now().toString(36)}`;
    const typedStarted = Date.now();
    const [typedA, typedB] = await Promise.all([
      textA
        ? call("accept", "cu_type", {
            targetId: targetA, pid: winA.pid, windowId: winA.windowId, ref: textA,
            mode: "setvalue", text: tokenText, observe: false, preview: false,
            expect: { query: tokenText, timeoutMs: 2000 },
          })
        : Promise.resolve(null),
      textB
        ? call("accept", "cu_type", {
            targetId: targetB, pid: winB.pid, windowId: winB.windowId, ref: textB,
            mode: "setvalue", text: tokenText, observe: false, preview: false,
            expect: { query: tokenText, timeoutMs: 2000 },
          })
        : Promise.resolve(null),
    ]);
    result.evidence.backgroundTypingMs = Date.now() - typedStarted;
    result.evidence.text = { hasFieldA: Boolean(textA), hasFieldB: Boolean(textB), typedA, typedB };
    result.checks.backgroundTextVerified = Boolean(
      typedA?.ok && typedA?.verified === true && typedB?.ok && typedB?.verified === true,
    );

    // Capability boundary: the custom canvas has no AXPress. A raw PID mouse
    // event is delivered but does not change its state on an inactive window.
    // The tool must report that honestly instead of claiming success.
    const rawB = await rawSnapshot(manager, winB.pid, winB.windowId, targetB);
    const canvasNode = (rawB?.nodes ?? []).find((node) => node.title === "Canvas Surface");
    let canvasAttempt = null;
    if (canvasNode) {
      canvasAttempt = await call("accept", "cu_click", {
        targetId: targetB, pid: winB.pid, windowId: winB.windowId,
        x: canvasNode.cx, y: canvasNode.cy,
        expect: { query: "Canvas 1", timeoutMs: 800 },
        observe: true, preview: false,
      });
    }
    const rawBAfter = await rawSnapshot(manager, winB.pid, winB.windowId, targetB);
    const canvasStatusAfter = (rawBAfter?.nodes ?? []).find((node) => node.title === "Canvas Status");
    result.evidence.backgroundCapability = {
      canvasValueAfter: canvasStatusAfter?.value ?? null,
      canvasAttempt: canvasAttempt
        ? {
            ok: canvasAttempt.ok,
            error: canvasAttempt.error ?? null,
            dispatchOnly: canvasAttempt.dispatchOnly ?? null,
            via: canvasAttempt.via ?? null,
            effect: canvasAttempt.effectEvidence ?? null,
          }
        : null,
      axPressVerified: clickA.verified === true && clickB.verified === true,
      setValueVerified: Boolean(typedA?.verified === true && typedB?.verified === true),
    };
    result.checks.pidDispatchNotReportedAsSuccess =
      !canvasAttempt || canvasAttempt.ok === false || canvasAttempt.verified !== true;

    // Two read-only waits that never match: with per-pid lanes the wall time is
    // ~one timeout, not the sum. Each target is still ordered internally.
    const waitStarted = Date.now();
    const [waitA, waitB] = await Promise.all([
      call("accept", "cu_expect", { targetId: targetA, pid: winA.pid, windowId: winA.windowId, query: "never-a", timeoutMs: 1600 }),
      call("accept", "cu_expect", { targetId: targetB, pid: winB.pid, windowId: winB.windowId, query: "never-b", timeoutMs: 1600 }),
    ]);
    const concurrentMs = Date.now() - waitStarted;
    result.evidence.concurrentExpectMs = concurrentMs;
    result.evidence.concurrentExpect = { a: waitA?.ok === false, b: waitB?.ok === false };
    result.checks.concurrentReadsAcrossTargets = concurrentMs < 2700;
    if (waitA?.ok !== false || waitB?.ok !== false) fail("concurrent expect unexpectedly succeeded");

    const previewA = await readFirstPreviewFrame(winA.windowId, targetA, manager.targetForKey(targetA).generation);
    const previewB = await readFirstPreviewFrame(winB.windowId, targetB, manager.targetForKey(targetB).generation);
    result.evidence.previews = { A: previewA.meta, B: previewB.meta };
    result.checks.previewsBoundToTarget =
      previewA.meta.targetId === targetA && previewB.meta.targetId === targetB;
    if (!result.checks.previewsBoundToTarget) fail("preview target id mismatch");

    const frontAfter = await manager.exec(["frontmost"]);
    const cursorAfter = cursorPosition();
    const clipboardAfter = readClipboard();
    result.evidence.noInterference = {
      frontBefore, frontAfter, cursorBefore, cursorAfter,
      clipboardUnchanged: clipboardBefore === clipboardAfter,
    };
    result.checks.frontmostUnchanged =
      frontBefore?.frontmost?.pid === frontAfter?.frontmost?.pid;
    result.checks.cursorUnchanged = cursorBefore === cursorAfter;
    result.checks.clipboardUnchanged = clipboardBefore === clipboardAfter;
    if (!result.checks.frontmostUnchanged) fail("background actions changed the frontmost app");

    // Stop A only. A's gate closes; B remains live and verifiable.
    const stoppedA = await call("accept", "cu_session", {
      action: "stop", targetId: targetA, pause: false,
    });
    if (!stoppedA.ok) fail("target A stop failed", stoppedA);
    const snapB2 = await call("accept", "cu_snapshot", { pid: winB.pid, windowId: winB.windowId, full: true });
    const buttonB2 = (snapB2.lines ?? []).find((line) => line.includes("Acceptance Button"));
    const countB2 = counterOf(snapB2);
    const clickB2 = await call("accept", "cu_click", {
      targetId: targetB, pid: winB.pid, windowId: winB.windowId,
      ref: buttonB2.split(" ")[0], snapshotId: snapB2.snapshotId,
      expect: { query: `Acceptance Button ${countB2 + 1}`, timeoutMs: 2500 },
      observe: false, preview: false,
    });
    result.checks.afterStopABStillWorks = clickB2.ok === true && clickB2.verified === true;
    if (!result.checks.afterStopABStillWorks) fail("B did not continue after A stopped", clickB2);
    let blockedA = null;
    try {
      await call("accept", "cu_click", {
        targetId: targetA, pid: winA.pid, windowId: winA.windowId,
        ref: buttonA.split(" ")[0], observe: false, preview: false,
      });
    } catch (error) {
      blockedA = error;
    }
    result.checks.stoppedATargetRefused = Boolean(blockedA);
    if (!blockedA) fail("stopped target A accepted another action");

    // Stop all. No queued input may run and both gates stay closed.
    const stoppedAll = await call("accept", "cu_session", { action: "stop", pause: true });
    if (!stoppedAll.ok) fail("stop-all failed", stoppedAll);
    await sleep(150);
    result.checks.stopAllClosedEverything =
      manager.activeTargets().length === 0 &&
      manager.inputGateClosed === true &&
      manager.targets.size === 0;
    const afterStopKey = await manager.exec(["key", "--name", "return"], undefined, {
      targetId: targetB,
    }).catch((error) => ({ ok: false, thrown: error?.message }));
    result.checks.queuedInputRefused = afterStopKey?.ok === false;
    if (!result.checks.stopAllClosedEverything) fail("stop-all left a target active");
    if (!result.checks.queuedInputRefused) fail("post-stop input was not refused", afterStopKey);

    result.evidence.processes = {
      managerServicePid: manager.managedServiceProcess?.pid ?? null,
      pluginManaged: Boolean(manager.managedServiceProcess),
      fixtures: fixtures.map((child) => ({ pid: child.pid, alive: child.exitCode === null })),
    };
    result.ok = Object.values(result.checks).every(Boolean);
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  } finally {
    try { await manager?.stopVisualSession({ pause: false, reason: "acceptance_cleanup" }); } catch {}
    for (const fixture of fixtures) {
      try { fixture.kill("SIGTERM"); } catch {}
    }
    try { service.stdin?.end(); } catch {}
    try { service.kill("SIGTERM"); } catch {}
    await sleep(400);
    try {
      if (service.exitCode === null) service.kill("SIGKILL");
    } catch {}
    rmSync(stateDir, { recursive: true, force: true });
  }
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error?.message ?? String(error),
    detail: error?.detail ?? null,
  }, null, 2));
  process.exit(1);
});
