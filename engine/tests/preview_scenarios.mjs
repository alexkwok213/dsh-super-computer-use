// Round-2 preview scenarios against the real installed helper and bridge:
// target close, minimize, 20 target switches, hide (cancel), client reload.
//
//   node engine/tests/preview_scenarios.mjs --json docs/reviews/evidence/round2-preview-scenarios.json
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

import { CuSessionManager } from "../../lib/core.mjs";
import { createCuUiRegistry } from "../../lib/cu-ui-session.mjs";
import { createPreviewBridge } from "../../lib/preview-stream.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const JSON_OUT = flag("json", null);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findDemo(manager, demo) {
  for (let i = 0; i < 60; i += 1) {
    const out = await manager.exec(["windows"]).catch(() => null);
    const window = (out?.windows ?? []).find(
      (entry) => entry.title === "cu demo window" && entry.pid === demo.pid && entry.windowId > 0,
    );
    if (window) return window;
    await sleep(200);
  }
  const out = await manager.exec(["windows"]).catch(() => null);
  const psout = (await import("node:child_process")).execFileSync("ps", ["-o", "pid=,stat=,command=", "-p", String(demo.pid)], { encoding: "utf8" }).trim();
  throw new Error(psout + " | " + 
    `demo window not found for pid ${demo.pid}; alive=${demo.exitCode === null}; windows=` +
      JSON.stringify((out?.windows ?? []).map((w) => ({ pid: w.pid, title: w.title, windowId: w.windowId }))),
  );
}

function makeSetup(manager, registry) {
  const bridge = createPreviewBridge({ manager, log: () => {} });
  const routes = new Map();
  bridge.register({
    register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
    registry,
  });
  return { bridge, route: routes.get("/api/scu/preview") };
}

async function readFrame(reader, timeoutMs = 5000) {
  const started = Date.now();
  let buffer = Buffer.alloc(0);
  while (Date.now() - started < timeoutMs) {
    const result = await Promise.race([
      reader.read(),
      sleep(Math.max(250, timeoutMs - (Date.now() - started))).then(() => ({ timeout: true })),
    ]);
    if (result.timeout) {
      await reader.cancel().catch(() => {});
      return null;
    }
    if (result.done) return null;
    buffer = Buffer.concat([buffer, Buffer.from(result.value ?? [])]);
    if (buffer.length >= 8) {
      const metaLength = buffer.readUInt32BE(0);
      const jpegLength = buffer.readUInt32BE(4);
      if (buffer.length >= 8 + metaLength + jpegLength) {
        return JSON.parse(buffer.subarray(8, 8 + metaLength).toString("utf8"));
      }
    }
  }
  return null;
}

async function openStream(route, registry, manager, hostSessionId, window) {
  manager.activeSession = {
    windowId: window.windowId,
    pid: window.pid,
    app: window.app ?? "cu",
    label: "scenario",
    startedAt: Date.now(),
  };
  manager.sessionGeneration = (manager.sessionGeneration ?? 0) + 1;
  manager.sessionId = `scenario-${Date.now()}-${manager.sessionGeneration}`;
  registry.setTarget({
    pid: window.pid,
    windowId: window.windowId,
    appName: window.app ?? "cu",
  });
  await manager.exec(["activate", "--window", String(window.windowId)]).catch(() => null);
  await sleep(300);
  const cuSessionId = registry.cuSessionId();
  const generation = manager.sessionGeneration;
  const response = await route.fetch(
    new Request(
      `http://127.0.0.1/api/scu/preview?hostSessionId=${encodeURIComponent(hostSessionId)}` +
        `&cuSessionId=${encodeURIComponent(cuSessionId)}&generation=${generation}`,
    ),
  );
  if (response.status !== 200) {
    throw new Error(`preview HTTP ${response.status} ${await response.text().catch(() => "")}`);
  }
  const reader = response.body.getReader();
  const frame = await readFrame(reader);
  return { response, reader, frame, generation };
}

async function main() {
  const manager = new CuSessionManager();
  const registry = createCuUiRegistry({ manager });
  registry.claim("scenario-chat");
  const demoA = spawn(manager.resolveBinaryPath(), ["demo", "--seconds", "300"], { stdio: "ignore" });
  await sleep(1000);
  const demoB = spawn(manager.resolveBinaryPath(), ["demo", "--seconds", "300"], { stdio: "ignore" });
  await sleep(1000);
  const checks = {};
  let bridge;
  try {
    const windowA = await findDemo(manager, demoA);
    const windowB = await findDemo(manager, demoB);
    const setup = makeSetup(manager, registry);
    bridge = setup.bridge;
    const { route } = setup;

    // --- 20 target switches between two live demo windows ---------------
    let switchOk = 0;
    for (let i = 0; i < 20; i += 1) {
      const target = i % 2 === 0 ? windowA : windowB;
      const next = await openStream(route, registry, manager, "scenario-chat", target);
      if (next.frame) switchOk += 1;
      await next.reader.cancel().catch(() => {});
      await sleep(80);
    }
    checks.switchesCompleted = switchOk;
    checks.switchesNoLeak = bridge.stats().activeChildren === 0 && bridge.stats().timers === 0;

    // --- hide (consumer cancel) then reopen (client reload) -------------
    const hidden = await openStream(route, registry, manager, "scenario-chat", windowA);
    checks.hideFirstFrame = Boolean(hidden.frame);
    await hidden.reader.cancel().catch(() => {});
    await sleep(200);
    checks.hideReleased = bridge.stats().activeChildren === 0;
    const reopened = await openStream(route, registry, manager, "scenario-chat", windowA);
    checks.reloadFirstFrame = Boolean(reopened.frame);
    await reopened.reader.cancel().catch(() => {});
    await sleep(200);
    checks.reloadReleased = bridge.stats().activeChildren === 0;

    // --- minimize: record whether real frames continue ------------------
    const minimized = await openStream(route, registry, manager, "scenario-chat", windowB);
    checks.minimizeFirstFrame = Boolean(minimized.frame);
    const snap = await manager.exec([
      "snapshot", "--pid", String(windowB.pid), "--window", String(windowB.windowId),
    ]);
    const minimizeButton = (snap.nodes ?? []).find(
      (node) => node.subrole === "AXMinimizeButton" || node.role === "AXMinimizeButton",
    );
    if (minimizeButton) {
      const pressed = await manager.exec([
        "action", "--pid", String(windowB.pid), "--window", String(windowB.windowId),
        "--ref", minimizeButton.ref, "--name", "AXPress",
      ]);
      checks.minimizePressed = pressed?.ok !== false;
    } else {
      checks.minimizePressed = false;
    }
    const beforeFrames = bridge.stats().framesReceived;
    await sleep(2000);
    const afterFrames = bridge.stats().framesReceived;
    checks.minimizeFramesContinue = afterFrames > beforeFrames;
    checks.minimizeObserved = { beforeFrames, afterFrames };
    await minimized.reader.cancel().catch(() => {});

    // --- target close during capture ------------------------------------
    const closed = await openStream(route, registry, manager, "scenario-chat", windowA);
    checks.targetCloseFirstFrame = Boolean(closed.frame);
    demoA.kill("SIGTERM");
    await sleep(2500);
    checks.targetCloseDegraded = registry.snapshot("scenario-chat").previewStatus === "unavailable";
    checks.targetCloseNoHelper = bridge.stats().activeChildren === 0;
    await closed.reader.cancel().catch(() => {});

    checks.ok = Object.entries(checks)
      .filter(([key]) => key.startsWith("targetClose") || key.startsWith("switch") || key.startsWith("hide") || key.startsWith("reload"))
      .every(([, value]) => Boolean(value));
    console.log(JSON.stringify(checks, null, 2));
    if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(checks, null, 2));
    return checks.ok ? 0 : 1;
  } finally {
    bridge?.dispose();
    if (demoA.exitCode === null) demoA.kill("SIGTERM");
    if (demoB.exitCode === null) demoB.kill("SIGTERM");
    await sleep(500);
  }
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message ?? String(error) }));
  process.exit(1);
});
