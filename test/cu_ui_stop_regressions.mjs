// Round-2 stop regressions (review R4 + S1).
//
// The probes in docs/reviews/harness-round2-probes.mjs asserted that these
// defects existed. This file asserts the opposite — the safe behaviour — with
// the real registry, the real CuSessionManager gate and the real registerCuTools
// wrapper. Only the native service request is simulated, so no desktop input is
// produced and the assertCanAct / startVisualSession gate is never stubbed.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CuSessionManager } from "../lib/core.mjs";
import { registerCuTools } from "../lib/index.mjs";
import { createCuUiRegistry } from "../lib/cu-ui-session.mjs";

const INPUT_COMMANDS = new Set(["click", "type", "key", "scroll", "setvalue", "batch", "action"]);

function createManager(overrides = {}) {
  let generation = 0;
  return {
    activeSession: null,
    sessionId: null,
    sessionGeneration: 0,
    inputGateClosed: false,
    pauseLatched: false,
    stopCalls: 0,
    cancelCalls: 0,
    async stopVisualSession(opts = {}) {
      this.stopCalls += 1;
      this.inputGateClosed = true;
      if (opts.pause === true) this.pauseLatched = true;
      generation += 1;
      this.sessionGeneration = generation;
      this.activeSession = null;
      this.sessionId = null;
      return { ok: true, cleanupState: "unknown", cancelledActions: 1 };
    },
    cancelInFlight() {
      this.cancelCalls += 1;
      return 1;
    },
    start(windowId = 11, pid = 222, app = "Notes") {
      generation += 1;
      this.sessionGeneration = generation;
      this.sessionId = `engine-${generation}`;
      this.activeSession = { windowId, pid, app, label: app, startedAt: Date.now() };
      this.inputGateClosed = false;
    },
    ...overrides,
  };
}

test("R4: a stop with an out-of-date revision still stops the current session", async () => {
  const manager = createManager();
  const registry = createCuUiRegistry({ manager });
  const claimed = registry.claim("chat-a");
  manager.start();

  registry.beginAction("chat-a", { tool: "cu_click" });
  const observedRevision = registry.snapshot("chat-a").revision;
  // A normal result bumps the revision between the snapshot the user saw and
  // the click on Stop. That must not turn the stop into a 409.
  registry.endAction("chat-a", { ok: true });
  assert.notEqual(registry.snapshot("chat-a").revision, observedRevision);

  const stopped = await registry.control({
    hostSessionId: "chat-a",
    cuSessionId: claimed.cuSessionId,
    expectedRevision: observedRevision,
    command: "stop",
  });
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  assert.equal(stopped.status, undefined);
  assert.equal(manager.inputGateClosed, true);
  assert.equal(manager.pauseLatched, true, "a UI stop must latch the user pause");
  assert.equal(manager.stopCalls, 1);
  // The response carries the post-stop snapshot; the client applies it instead
  // of inventing revision+1 and waiting for the next poll.
  assert.equal(stopped.snapshot.state, "cleanup_unknown");
  assert.equal(stopped.snapshot.revision, registry.revision());
  assert.equal(stopped.snapshot.cuSessionId, claimed.cuSessionId);
});

test("a stale cuSessionId is refused and cannot stop the new session", async () => {
  const manager = createManager();
  const registry = createCuUiRegistry({ manager });
  const first = registry.claim("chat-a");
  manager.start();
  await registry.control({
    hostSessionId: "chat-a",
    cuSessionId: first.cuSessionId,
    command: "stop",
  });

  const second = registry.claim("chat-a");
  manager.start(88, 999, "Finder");
  assert.notEqual(second.cuSessionId, first.cuSessionId);

  const stale = await registry.control({
    hostSessionId: "chat-a",
    cuSessionId: first.cuSessionId,
    command: "stop",
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.status, 409);
  assert.equal(stale.error, "stale_session");
  assert.equal(manager.stopCalls, 1, "the old session must not run cleanup again");
  assert.equal(manager.activeSession?.windowId, 88);
});

test("two concurrent stops of the same session share one cleanup", async () => {
  const manager = createManager();
  let release;
  const cleanup = new Promise((resolve) => {
    release = resolve;
  });
  manager.stopVisualSession = async () => {
    manager.stopCalls += 1;
    manager.inputGateClosed = true;
    await cleanup;
    return { ok: true, cleanupState: "unknown", cancelledActions: 3 };
  };
  const registry = createCuUiRegistry({ manager });
  const claimed = registry.claim("chat-a");
  manager.start();

  const first = registry.control({
    hostSessionId: "chat-a",
    cuSessionId: claimed.cuSessionId,
    expectedRevision: 1,
    command: "stop",
  });
  const second = registry.control({
    hostSessionId: "chat-a",
    cuSessionId: claimed.cuSessionId,
    expectedRevision: 2,
    command: "stop",
  });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(manager.stopCalls, 1);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.detail.cancelledActions, 3);
  assert.equal(b.detail.cancelledActions, 3);
});

test("missing and malformed control fields are rejected before touching the session", async () => {
  const manager = createManager();
  const registry = createCuUiRegistry({ manager });
  registry.claim("chat-a");
  manager.start();

  const missingSession = await registry.control({
    hostSessionId: "chat-a",
    command: "stop",
  });
  assert.equal(missingSession.ok, false);
  assert.equal(missingSession.status, 400);
  assert.equal(missingSession.error, "no_cu_session");

  const numericSession = await registry.control({
    hostSessionId: "chat-a",
    cuSessionId: 42,
    command: "stop",
  });
  assert.equal(numericSession.status, 400);

  const missingHost = await registry.control({ cuSessionId: "cu-x", command: "stop" });
  assert.equal(missingHost.status, 400);
  assert.equal(missingHost.error, "no_host_session");

  const badCommand = await registry.control({
    hostSessionId: "chat-a",
    cuSessionId: "cu-x",
    command: "nuke",
  });
  assert.equal(badCommand.status, 400);
  assert.equal(badCommand.error, "unknown_command");
  assert.equal(manager.stopCalls, 0);
  assert.equal(manager.inputGateClosed, false);
});

// ---------------------------------------------------------------------------
// Real manager + real tool wrapper. Native execution is a counter at the
// service-request boundary; the gate, assertCanAct and startVisualSession are
// the production code paths.

function createToolHarness() {
  const manager = new CuSessionManager({ stateDir: mkdtempSync(join(tmpdir(), "scu-stop-")) });
  const definitions = new Map();
  const nativeInputs = [];

  // Process/UI side effects only. Never the gate and never startVisualSession.
  manager.writeActivity = () => {};
  manager.spawnIndicator = () => ({});
  manager.stopVisualIndicatorsOnly = async () => {};
  manager.startScreenIndicator = () => {};
  manager.stopScreenIndicator = () => {};
  manager.startCursorOverlay = () => {};
  manager.stopCursorOverlay = () => {};
  manager.startNativePreview = () => {};
  manager.stopNativePreview = () => false;
  manager.setAgentAura = () => {};
  manager.warmCaptureDaemon = () => {};
  manager.readServiceConfig = () => ({ baseUrl: "http://127.0.0.1:9", token: "test" });
  manager._execRequest = async (argv) => {
    if (INPUT_COMMANDS.has(argv[0])) nativeInputs.push(argv);
    if (argv[0] === "windows") {
      return {
        ok: true,
        windows: [
          { windowId: 7, pid: 42, app: "Notes", title: "Notes", bounds: { x: 0, y: 0, width: 400, height: 300 } },
          { windowId: 99, pid: 1, app: "DeepSeek Harness", title: "DSH", bounds: { x: 0, y: 0, width: 900, height: 700 } },
        ],
      };
    }
    if (argv[0] === "snapshot") return { ok: true, nodes: [], count: 0 };
    return { ok: true };
  };

  const registry = createCuUiRegistry({ manager });
  const ctx = {
    tools: {
      register(def) {
        definitions.set(def.name, def);
        return () => {};
      },
    },
    get: () => undefined,
  };
  registerCuTools({
    ctx,
    manager,
    registry,
    config: {
      autoSession: true,
      idleStopSeconds: 0,
      viewerMode: "native",
      observeBudgetMs: 0,
      uiProbe: false,
    },
  });

  const exec = { agent: { id: "chat-a" }, signal: new AbortController().signal };
  return {
    manager,
    registry,
    nativeInputs,
    call: (name, args) => definitions.get(name).execute(args, exec),
  };
}

test("S1: after a UI stop, coordinate click / type / batch produce zero native input", async () => {
  const h = createToolHarness();
  const started = await h.call("cu_session", {
    action: "start",
    windowId: 7,
    pid: 42,
    preview: false,
    halo: false,
    capsule: false,
    cursor: false,
    dockDsh: false,
    splitScreen: false,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(h.manager.inputGateClosed, false);
  const cuSessionId = h.registry.cuSessionId();
  assert.ok(cuSessionId);

  const stopped = await h.registry.control({
    hostSessionId: "chat-a",
    cuSessionId,
    command: "stop",
  });
  assert.equal(stopped.ok, true);
  assert.equal(h.manager.pauseLatched, true);
  assert.equal(h.manager.inputGateClosed, true);
  assert.equal(h.manager.activeSession, null);

  const before = h.nativeInputs.length;
  // A coordinate click is the path that used to auto-start a fresh session and
  // silently clear the user's stop.
  await assert.rejects(
    h.call("cu_click", { x: 12, y: 24, windowId: 7, pid: 42, observe: false, preview: false }),
    (error) => error?.code === "PAUSED_BY_USER",
  );
  await assert.rejects(
    h.call("cu_type", { text: "hello", pid: 42, windowId: 7, observe: false, preview: false }),
    (error) => error?.code === "PAUSED_BY_USER",
  );
  await assert.rejects(
    h.call("cu_batch", { pid: 42, windowId: 7, steps: [{ action: "click", x: 1, y: 2 }], observe: false, preview: false }),
    (error) => error?.code === "PAUSED_BY_USER",
  );
  assert.equal(h.nativeInputs.length, before, `native input leaked after stop: ${JSON.stringify(h.nativeInputs)}`);
  assert.ok(
    h.nativeInputs.every((argv) => !INPUT_COMMANDS.has(argv[0])),
    "no input command may reach the native executor after a user stop",
  );
});

test("S1: an explicit cu_session start clears the user stop and input works again", async () => {
  const h = createToolHarness();
  await h.call("cu_session", {
    action: "start",
    windowId: 7,
    pid: 42,
    preview: false,
    halo: false,
    capsule: false,
    cursor: false,
    dockDsh: false,
    splitScreen: false,
  });
  await h.registry.control({
    hostSessionId: "chat-a",
    cuSessionId: h.registry.cuSessionId(),
    command: "stop",
  });
  assert.equal(h.manager.pauseLatched, true);

  const restarted = await h.call("cu_session", {
    action: "start",
    windowId: 7,
    pid: 42,
    preview: false,
    halo: false,
    capsule: false,
    cursor: false,
    dockDsh: false,
    splitScreen: false,
  });
  assert.equal(restarted.ok, true, JSON.stringify(restarted));
  assert.equal(h.manager.pauseLatched, false);
  assert.equal(h.manager.inputGateClosed, false);

  const clicked = await h.call("cu_click", {
    x: 12,
    y: 24,
    windowId: 7,
    pid: 42,
    observe: false,
    preview: false,
  });
  assert.notEqual(clicked.ok, false);
  assert.ok(h.nativeInputs.some((argv) => argv[0] === "click"), "the explicit restart must restore input");
});
