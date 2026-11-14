// Round-2 action lifecycle regressions (review R3 + S2).
//
// Every test asserts the safe behaviour the review asked for: an action result
// belongs to the exact action that produced it, the registry is released by the
// manager's own end notification rather than guessed timers, and a passed
// cu_expect is reported as verified while a completed-but-unproven action is
// reported as unverified (never as "waiting").

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CuSessionManager } from "../lib/core.mjs";
import { registerCuTools } from "../lib/index.mjs";
import { createCuUiRegistry } from "../lib/cu-ui-session.mjs";
import { installHarnessUiBridge } from "../lib/harness-ui-bridge.mjs";

function createFakeManager() {
  let generation = 0;
  return {
    activeSession: null,
    sessionId: null,
    sessionGeneration: 0,
    inputGateClosed: false,
    pauseLatched: false,
    stopCalls: 0,
    async stopVisualSession() {
      this.stopCalls += 1;
      generation += 1;
      this.sessionGeneration = generation;
      this.sessionId = null;
      this.activeSession = null;
      this.inputGateClosed = true;
      return { ok: true, cleanupState: "unknown" };
    },
    cancelInFlight() {
      return 0;
    },
    start(windowId = 11, pid = 222, app = "Notes") {
      generation += 1;
      this.sessionGeneration = generation;
      this.sessionId = `engine-${generation}`;
      this.activeSession = { windowId, pid, app, label: app, startedAt: Date.now() };
      this.inputGateClosed = false;
    },
  };
}

function begin(registry, hostSessionId, tool = "cu_click") {
  const claimed = registry.beginAction(hostSessionId, { tool });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  assert.equal(typeof claimed.ticket?.actionId, "string", "beginAction must return an immutable ticket");
  assert.equal(typeof claimed.ticket?.cuSessionId, "string");
  assert.equal(claimed.ticket?.hostSessionId, hostSessionId);
  return claimed.ticket;
}

// ---------------------------------------------------------------- R3 --------

test("R3: an old action result cannot overwrite the same chat's new session", async () => {
  const manager = createFakeManager();
  const registry = createCuUiRegistry({ manager });
  registry.claim("chat-a");
  manager.start();
  const oldTicket = begin(registry, "chat-a", "cu_click");

  await registry.control({
    hostSessionId: "chat-a",
    cuSessionId: oldTicket.cuSessionId,
    command: "stop",
  });
  manager.start(88, 999, "Finder");
  const newTicket = begin(registry, "chat-a", "cu_type");
  assert.notEqual(newTicket.cuSessionId, oldTicket.cuSessionId);

  // The old click fails AFTER the new typing session started.
  registry.endAction(oldTicket, { ok: false, error: "old_click_failed" });
  const view = registry.snapshot("chat-a");
  assert.equal(view.state, "running", "the stale result must not change the new action state");
  assert.equal(view.error, null);
  assert.equal(view.action?.kind, "type");

  registry.endAction(newTicket, { ok: true });
  assert.equal(registry.snapshot("chat-a").state, "unverified");
});

test("R3: action1 returning after action2 started in the same session is ignored", () => {
  const registry = createCuUiRegistry({ manager: createFakeManager() });
  registry.claim("chat-a");
  const first = begin(registry, "chat-a", "cu_click");
  const second = begin(registry, "chat-a", "cu_type");

  registry.endAction(first, { ok: false, error: "late_click_failed" });
  const view = registry.snapshot("chat-a");
  assert.equal(view.state, "running");
  assert.equal(view.error, null);
  assert.equal(view.action?.kind, "type");

  registry.endAction(second, { ok: true, verified: true });
  assert.equal(registry.snapshot("chat-a").state, "verified");
});

test("R3: an old action cannot touch a different chat that took over the desk", async () => {
  const manager = createFakeManager();
  const registry = createCuUiRegistry({ manager });
  registry.claim("chat-a");
  manager.start();
  const oldTicket = begin(registry, "chat-a", "cu_click");
  await registry.control({
    hostSessionId: "chat-a",
    cuSessionId: oldTicket.cuSessionId,
    command: "stop",
  });

  assert.equal(registry.claim("chat-b").ok, true);
  manager.start(55, 66, "Pages");
  const newTicket = begin(registry, "chat-b", "cu_click");

  registry.endAction(oldTicket, { ok: false, error: "old_chat_failed" });
  assert.equal(registry.snapshot("chat-b").state, "running");
  assert.equal(registry.snapshot("chat-b").error, null);
  registry.endAction(newTicket, { ok: true });
  assert.equal(registry.snapshot("chat-b").state, "unverified");
});

test("R3: a late finally while stopping is ignored and does not turn stop into failed", async () => {
  const manager = createFakeManager();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  manager.stopVisualSession = async () => {
    manager.stopCalls += 1;
    manager.inputGateClosed = true;
    await gate;
    return { ok: true, cleanupState: "unknown" };
  };
  const registry = createCuUiRegistry({ manager });
  registry.claim("chat-a");
  manager.start();
  const ticket = begin(registry, "chat-a", "cu_click");

  const stopping = registry.control({
    hostSessionId: "chat-a",
    cuSessionId: ticket.cuSessionId,
    command: "stop",
  });
  registry.endAction(ticket, { ok: false, error: "cancelled" });
  release();
  await stopping;

  const view = registry.snapshot("chat-a");
  assert.equal(view.state, "cleanup_unknown");
  assert.equal(view.error, null);
});

test("a result without its ticket is refused and changes nothing", () => {
  const registry = createCuUiRegistry({ manager: createFakeManager() });
  registry.claim("chat-a");
  const ticket = begin(registry, "chat-a", "cu_click");
  const result = registry.endAction("chat-a", { ok: false, error: "forged" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_ticket");
  assert.equal(registry.snapshot("chat-a").state, "running");
  registry.endAction(ticket, { ok: true });
});

// ------------------------------------------------------- manager notices ----

function realManager() {
  const manager = new CuSessionManager({ stateDir: mkdtempSync(join(tmpdir(), "scu-events-")) });
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
  manager._execRequest = async () => ({ ok: true });
  manager.activeSession = { windowId: 7, pid: 42, app: "Notes", label: "Notes", startedAt: Date.now() };
  manager.sessionId = "engine-session-1";
  manager.sessionGeneration = 1;
  return manager;
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test("idle timeout ends the session, emits one notice and releases the owner", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const manager = realManager();
  const notices = [];
  manager.onSessionEnd((notice) => notices.push(notice));
  const registry = createCuUiRegistry({ manager });
  registry.claim("chat-a");
  manager.armIdleStop(5);
  t.mock.timers.tick(5000);
  await flush();

  assert.equal(manager.activeSession, null);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].reason, "idle_timeout");
  assert.equal(notices[0].sessionId, "engine-session-1");
  assert.equal(notices[0].cleanupState, "unknown");
  assert.equal(registry.snapshot("chat-a").state, "cleanup_unknown");
  assert.equal(registry.claim("chat-b").ok, true, "the idle-ended owner must be released");
});

test("session timeout and agent dispose also release the owner without latching pause", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const manager = realManager();
  const registry = createCuUiRegistry({ manager });
  registry.claim("chat-a");
  manager.armSessionTimer(30);
  t.mock.timers.tick(30000);
  await flush();
  assert.equal(registry.snapshot("chat-a").state, "cleanup_unknown");
  assert.equal(manager.pauseLatched, false);
  assert.equal(registry.claim("chat-b").ok, true);

  const manager2 = realManager();
  const registry2 = createCuUiRegistry({ manager: manager2 });
  registry2.claim("chat-c");
  const ended = await registry2.sessionEnded("chat-c");
  assert.equal(ended.ok, true);
  assert.equal(manager2.activeSession, null);
  assert.equal(manager2.pauseLatched, false);
  assert.equal(registry2.claim("chat-d").ok, true);
});

test("an in-flight action defers the idle stop instead of being cut off", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const manager = realManager();
  const registry = createCuUiRegistry({ manager });
  registry.claim("chat-a");
  manager._inflight = new Set([{ inFlight: true }]);
  manager.armIdleStop(5);
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(registry.snapshot("chat-a").state, "claimed", "a running action must not be timed out");
  manager._inflight.clear();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(registry.snapshot("chat-a").state, "cleanup_unknown");
});

test("an in-flight action defers session timeout and refreshSessionTimer slides untimed active sessions", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const manager = realManager();
  const registry = createCuUiRegistry({ manager });
  registry.claim("chat-a");
  manager._inflight = new Set([{ inFlight: true }]);
  manager.armSessionTimer(30);
  t.mock.timers.tick(30000);
  await flush();
  assert.equal(registry.snapshot("chat-a").state, "claimed", "in-flight action must defer session timeout");

  manager.sessionHasTimedIndicators = false;
  assert.equal(manager.refreshSessionTimer(), true, "untimed session refreshes timer on active desktop work");
  manager._inflight.clear();
  t.mock.timers.tick(20000);
  await flush();
  assert.equal(registry.snapshot("chat-a").state, "claimed", "refreshed untimed session stays alive before renewed deadline");
  assert.equal(manager.refreshSessionTimer(), true);
  t.mock.timers.tick(20000);
  await flush();
  assert.equal(registry.snapshot("chat-a").state, "claimed", "continuous activity slides past initial 30s cap");

  // Timed indicator sessions do not slide automatically on refreshSessionTimer.
  manager.sessionHasTimedIndicators = true;
  assert.equal(manager.refreshSessionTimer(), false);
  t.mock.timers.tick(10000);
  await flush();
  assert.equal(registry.snapshot("chat-a").state, "cleanup_unknown");
});

test("watcher presence is not input activity and cannot keep the owner alive", async () => {
  const manager = {
    activeSession: null,
    sessionGeneration: 0,
    calls: 0,
    armIdleStop() {
      this.calls += 1;
      throw new Error("state polling must not arm the input idle timer");
    },
    async stopVisualSession() {
      return { ok: true };
    },
    cancelInFlight() {
      return 0;
    },
  };
  const registry = createCuUiRegistry({ manager });
  registry.claim("chat-a");
  const routes = new Map();
  const bridge = installHarnessUiBridge(
    {
      get: () => ({
        fetch: {
          register(route) {
            routes.set(route.path, route);
            return () => {};
          },
        },
      }),
    },
    { registry, manager, config: { uiProbe: false } },
  );
  const route = routes.get("/api/scu/state");
  for (let i = 0; i < 10; i += 1) {
    const response = await route.fetch(
      new Request("http://127.0.0.1/api/scu/state", {
        method: "POST",
        body: JSON.stringify({ hostSessionId: "chat-a" }),
      }),
    );
    assert.equal(response.status, 200);
  }
  assert.equal(manager.calls, 0);
  bridge.dispose();
});

test("dispose removes the manager end subscription", () => {
  const manager = realManager();
  const registry = createCuUiRegistry({ manager });
  assert.equal(manager.sessionEndListeners.size, 1);
  registry.dispose();
  assert.equal(manager.sessionEndListeners.size, 0);
});

// ---------------------------------------------------- verified semantics ----

function toolHarness() {
  const manager = realManager();
  const definitions = new Map();
  const registry = createCuUiRegistry({ manager });
  registerCuTools({
    ctx: {
      tools: {
        register(def) {
          definitions.set(def.name, def);
          return () => {};
        },
      },
      get: () => undefined,
    },
    manager,
    registry,
    config: { autoSession: false, idleStopSeconds: 0, viewerMode: "native", observeBudgetMs: 0 },
  });
  const exec = { agent: { id: "chat-a" }, signal: new AbortController().signal };
  return { manager, registry, call: (name, args) => definitions.get(name).execute(args, exec) };
}

test("a passed cu_expect is verified; a click with no evidence is unverified, not waiting", async () => {
  const h = toolHarness();
  h.manager._execRequest = async (argv) => {
    if (argv[0] === "expect") return { ok: true, action: "expect", ref: "k0.1" };
    if (argv[0] === "click") return { ok: true, action: "click" };
    return { ok: true };
  };
  const expectResult = await h.call("cu_expect", { pid: 42, windowId: 7, ref: "k0.1" });
  assert.equal(expectResult.ok, true);
  assert.equal(h.registry.snapshot("chat-a").state, "verified");

  const clickResult = await h.call("cu_click", {
    pid: 42,
    windowId: 7,
    x: 10,
    y: 20,
    observe: false,
    preview: false,
  });
  assert.equal(clickResult.ok, true);
  assert.equal(h.registry.snapshot("chat-a").state, "unverified");
});

test("overlapping manager stops share one cleanup and emit one end notice", async () => {
  const manager = realManager();
  const notices = [];
  manager.onSessionEnd((notice) => notices.push(notice));
  const first = manager.stopVisualSession();
  const second = manager.stopVisualSession();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(manager.activeSession, null);
  assert.equal(notices.length, 1, "two overlapping stops must not emit two notices");
});

test("a late notice from the old owner cannot release the new owner", async () => {
  const manager = realManager();
  const registry = createCuUiRegistry({ manager });
  const first = registry.claim("chat-a");
  const firstTicket = begin(registry, "chat-a", "cu_click");
  assert.equal(firstTicket.cuSessionId, first.cuSessionId);
  await registry.control({
    hostSessionId: "chat-a",
    cuSessionId: first.cuSessionId,
    command: "stop",
    pause: false,
  });
  const second = registry.claim("chat-a");
  assert.notEqual(second.cuSessionId, first.cuSessionId);
  begin(registry, "chat-a", "cu_type");

  // A late idle/turn-end notice from the retired owner.
  manager._emitSessionEnd({
    sessionId: "engine-old",
    ownerId: first.cuSessionId,
    reason: "idle_timeout",
    cleanupState: "unknown",
  });
  const view = registry.snapshot("chat-a");
  assert.equal(view.state, "running");
  assert.equal(view.cuSessionId, second.cuSessionId);
  assert.equal(registry.markStopped("chat-a", { cuSessionId: first.cuSessionId }).ignored, "stale_session");
  assert.equal(registry.snapshot("chat-a").state, "running");
});

test("cu_screenshot remains readable after non-paused stopVisualSession but respects user pause", async () => {
  const h = toolHarness();
  h.manager.captureShotViaDaemon = async () => ({ ok: false, error: "no_daemon" });
  h.manager._execRequest = async (argv) => {
    if (argv[0] === "shot") {
      return {
        ok: true,
        base64: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString("base64"),
        mimeType: "image/jpeg",
        size: { width: 10, height: 10 },
        scale: 1,
      };
    }
    return { ok: true };
  };
  await h.manager.stopVisualSession({ pause: false });
  assert.equal(h.manager.inputGateClosed, true);
  assert.equal(h.manager.pauseLatched, false);
  const shot = await h.call("cu_screenshot", { pid: 42, windowId: 7 });
  assert.equal(shot.ok, true, `expected screenshot to succeed after non-paused stop, got: ${JSON.stringify(shot)}`);

  await h.manager.stopVisualSession({ pause: true });
  assert.equal(h.manager.pauseLatched, true);
  await assert.rejects(
    () => h.call("cu_screenshot", { pid: 42, windowId: 7 }),
    /paused\/stopped by the user/i,
  );
});

test("stopVisualSession terminates display-awake child cleanly", async () => {
  const manager = realManager();
  let killedSignal = null;
  manager._caffeinateChild = {
    killed: false,
    exitCode: null,
    kill(sig) {
      killedSignal = sig;
      this.killed = true;
    },
  };
  await manager.stopVisualSession();
  assert.equal(killedSignal, "SIGTERM");
  assert.equal(manager._caffeinateChild, null);
});
