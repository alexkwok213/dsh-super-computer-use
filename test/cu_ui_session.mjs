import test from "node:test";
import assert from "node:assert/strict";
import { createCuUiRegistry } from "../lib/cu-ui-session.mjs";

function createManager() {
  let generation = 0;
  return {
    activeSession: null,
    sessionId: null,
    sessionGeneration: 0,
    inputGateClosed: false,
    stopCalls: 0,
    cancelCalls: 0,
    async stopVisualSession() {
      this.stopCalls += 1;
      this.inputGateClosed = true;
      generation += 1;
      this.sessionGeneration = generation;
      const previous = this.activeSession;
      this.activeSession = null;
      this.sessionId = null;
      return {
        ok: true,
        session: "stopped",
        inputGateClosed: true,
        cleanupState: "unknown",
        cancelledActions: 2,
        nativePreviewStopped: true,
        restoredDsh: false,
        restoredTarget: false,
        previous,
      };
    },
    cancelInFlight() {
      this.cancelCalls += 1;
      return 1;
    },
    start(windowId = 11, pid = 222, app = "Notes") {
      generation += 1;
      this.sessionGeneration = generation;
      this.sessionId = `engine-${generation}`;
      this.activeSession = { windowId, pid, app, label: "Notes", startedAt: Date.now() };
      this.inputGateClosed = false;
    },
  };
}

test("one owner: a second chat is refused and sees only busy", async () => {
  const manager = createManager();
  const registry = createCuUiRegistry({ manager });
  const a = registry.claim("chat-a");
  assert.equal(a.ok, true);

  const b = registry.claim("chat-b");
  assert.equal(b.ok, false);
  assert.equal(b.error, "cu_busy");

  const bView = registry.snapshot("chat-b");
  assert.equal(bView.state, "busy_elsewhere");
  assert.equal(bView.cuSessionId, null);
  assert.equal(bView.target, null);

  const aView = registry.snapshot("chat-a");
  assert.equal(aView.state, "claimed");
  assert.equal(aView.cuSessionId, a.cuSessionId);
});

test("a foreign chat cannot stop the owner and learns nothing about it", async () => {
  const manager = createManager();
  const registry = createCuUiRegistry({ manager });
  const a = registry.claim("chat-a");
  manager.start();

  const stolen = await registry.control({
    hostSessionId: "chat-b",
    cuSessionId: a.cuSessionId,
    command: "stop",
  });
  assert.equal(stolen.ok, false);
  assert.equal(stolen.status, 403);
  assert.equal(manager.stopCalls, 0);
  assert.equal(manager.activeSession?.windowId, 11);
});

test("stale cuSessionId and stale revision are rejected with 409", async () => {
  const manager = createManager();
  const registry = createCuUiRegistry({ manager });
  const a = registry.claim("chat-a");
  manager.start();
  registry.beginAction("chat-a", { tool: "cu_click" });
  registry.endAction("chat-a", { ok: true });

  const staleSession = await registry.control({
    hostSessionId: "chat-a",
    cuSessionId: "cu-nope",
    command: "stop",
  });
  assert.equal(staleSession.ok, false);
  assert.equal(staleSession.status, 409);
  assert.equal(staleSession.error, "stale_session");

  const staleRevision = await registry.control({
    hostSessionId: "chat-a",
    cuSessionId: a.cuSessionId,
    expectedRevision: 0,
    command: "stop",
  });
  assert.equal(staleRevision.ok, false);
  assert.equal(staleRevision.status, 409);
  assert.equal(staleRevision.error, "stale_revision");
  assert.equal(manager.stopCalls, 0);
});

test("stop closes the gate immediately, is idempotent and reports unknown cleanup", async () => {
  const manager = createManager();
  const registry = createCuUiRegistry({ manager });
  const a = registry.claim("chat-a");
  manager.start();

  const first = registry.control({
    hostSessionId: "chat-a",
    cuSessionId: a.cuSessionId,
    command: "stop",
  });
  // Gate closes before the awaited cleanup finishes.
  assert.equal(manager.inputGateClosed, true);
  assert.equal(registry.snapshot("chat-a").state, "stopping");
  const result = await first;
  assert.equal(result.ok, true);
  assert.equal(result.cleanupState, "unknown");
  assert.equal(manager.stopCalls, 1);
  assert.equal(manager.cancelCalls, 1);
  assert.equal(registry.snapshot("chat-a").state, "cleanup_unknown");

  const again = await registry.control({
    hostSessionId: "chat-a",
    cuSessionId: a.cuSessionId,
    command: "stop",
  });
  assert.equal(again.ok, true);
  assert.equal(again.alreadyStopped, true);
  assert.equal(manager.stopCalls, 1, "second stop must not re-run cleanup");
});

test("after the owner stops, another chat may start; no takeover of the target", async () => {
  const manager = createManager();
  const registry = createCuUiRegistry({ manager });
  const a = registry.claim("chat-a");
  manager.start();
  await registry.control({ hostSessionId: "chat-a", cuSessionId: a.cuSessionId, command: "stop" });

  const b = registry.claim("chat-b");
  assert.equal(b.ok, true);
  manager.start(88, 999, "Finder");
  registry.beginAction("chat-b", { tool: "cu_click" });
  const view = registry.snapshot("chat-b");
  assert.equal(view.target.windowId, 88);
  assert.equal(view.state, "running");
  // A no longer owns anything; it sees only that B is busy, never B's target.
  assert.equal(registry.snapshot("chat-a").state, "busy_elsewhere");
  assert.equal(registry.snapshot("chat-a").target, null);
});

test("tool lifecycle maps to running / waiting / verified / failed", async () => {
  const manager = createManager();
  const registry = createCuUiRegistry({ manager });
  const a = registry.claim("chat-a");
  manager.start(5, 6, "Notes");

  registry.beginAction("chat-a", { tool: "cu_click" });
  assert.equal(registry.snapshot("chat-a").state, "running");
  assert.equal(registry.snapshot("chat-a").action.kind, "click");

  registry.endAction("chat-a", { ok: true });
  assert.equal(registry.snapshot("chat-a").state, "waiting");

  registry.beginAction("chat-a", { tool: "cu_expect" });
  registry.endAction("chat-a", { ok: true, verified: true });
  assert.equal(registry.snapshot("chat-a").state, "verified");

  registry.beginAction("chat-a", { tool: "cu_type" });
  registry.endAction("chat-a", { ok: false, error: "element not found" });
  assert.equal(registry.snapshot("chat-a").state, "failed");
  assert.match(registry.snapshot("chat-a").error, /element not found/);
  assert.equal(a.ok, true);
});

test("a late in-flight result cannot overwrite a UI stop", async () => {
  const manager = createManager();
  const registry = createCuUiRegistry({ manager });
  const a = registry.claim("chat-a");
  manager.start();
  registry.beginAction("chat-a", { tool: "cu_click" });
  const stopping = registry.control({
    hostSessionId: "chat-a",
    cuSessionId: a.cuSessionId,
    command: "stop",
  });
  // The click that was in flight when the user pressed Stop resolves now.
  registry.endAction("chat-a", { ok: false, error: "cancelled" });
  await stopping;
  const view = registry.snapshot("chat-a");
  assert.equal(view.state, "cleanup_unknown");
  assert.equal(view.error, null);
});

test("agent disappearance stops the desktop instead of transferring it", async () => {
  const manager = createManager();
  const registry = createCuUiRegistry({ manager });
  const a = registry.claim("chat-a");
  manager.start();
  const result = await registry.sessionEnded("chat-a");
  assert.equal(result.ok, true);
  assert.equal(manager.stopCalls, 1);
  assert.equal(registry.snapshot("chat-a").state, "cleanup_unknown");
  assert.equal(registry.claim("chat-b").ok, true);
  assert.equal(a.ok, true);
});

test("turn-end marking is bounded to the current owner", async () => {
  const manager = createManager();
  const registry = createCuUiRegistry({ manager });
  registry.claim("chat-a");
  manager.start();
  assert.equal(registry.markStopped("chat-b").ok, false);
  assert.equal(registry.markStopped("chat-a").ok, true);
  assert.equal(registry.snapshot("chat-a").state, "cleanup_unknown");
  assert.equal(registry.snapshot("chat-a").target, null);
});

test("preview status only accepts known values from the owner", () => {
  const manager = createManager();
  const registry = createCuUiRegistry({ manager });
  const a = registry.claim("chat-a");
  assert.equal(registry.setPreviewStatus("chat-a", a.cuSessionId, "live").ok, true);
  assert.equal(registry.snapshot("chat-a").previewStatus, "live");
  assert.equal(registry.setPreviewStatus("chat-a", a.cuSessionId, "bogus").ok, false);
  assert.equal(registry.setPreviewStatus("chat-b", a.cuSessionId, "live").ok, false);
});

test("labels never carry control characters or unbounded text", () => {
  const manager = createManager();
  const registry = createCuUiRegistry({ manager });
  registry.claim("chat-a");
  manager.start();
  registry.beginAction("chat-a", { tool: "cu_type", label: "x".repeat(200) + "\n\u0000" });
  const view = registry.snapshot("chat-a");
  assert.ok(view.label.length <= 64);
  assert.doesNotMatch(view.label, /[\u0000-\u001f]/);
});
