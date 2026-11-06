// Multi-target behavior: one chat owns several application+window targets, each
// with its own generation, stop gate, queue, snapshot cache and preview state.
import test from "node:test";
import assert from "node:assert/strict";

import { CuSessionManager } from "../lib/core.mjs";
import { createCuUiRegistry } from "../lib/cu-ui-session.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function managerHarness() {
  const manager = new CuSessionManager();
  manager.resolveBinaryPath = () => "/nonexistent/cu";
  manager.spawnIndicator = () => null;
  manager._cursorWrite = () => true;
  manager.writeActivity = () => {};
  manager.startScreenIndicator = () => {};
  manager.stopScreenIndicator = async () => {};
  manager.startCursorOverlay = () => null;
  manager.stopCursorOverlay = () => {};
  manager.startNativePreview = () => false;
  manager.stopNativePreview = () => false;
  manager.warmCaptureDaemon = () => {};
  const realExec = CuSessionManager.prototype.exec.bind(manager);
  manager.exec = async (argv, signal, options) =>
    argv[0] === "windows" ? { ok: true, windows: [] } : realExec(argv, signal, options);
  return manager;
}

async function startTwo(manager) {
  const a = await manager.startVisualSession({
    pid: 101, windowId: 11, appName: "Alpha", halo: false, capsule: false,
    cursor: false, nativePreview: false, dockDsh: false,
  });
  const b = await manager.startVisualSession({
    pid: 202, windowId: 22, appName: "Beta", halo: false, capsule: false,
    cursor: false, nativePreview: false, dockDsh: false,
  });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));
  return { a: a.targetId, b: b.targetId };
}

test("one chat holds two independent targets without moving the desktop", async () => {
  const manager = managerHarness();
  const { a, b } = await startTwo(manager);
  assert.deepEqual(manager.listTargets().map((target) => target.targetId).sort(), [a, b].sort());
  assert.equal(manager.dockedDshWindow, null);
  assert.equal(manager.savedTargetBounds, null);
  assert.equal(manager.activeSession.targetId, b);
  assert.equal(manager.activeTargets().length, 2);
});

test("snapshot refs are isolated by target, not just by pid/window string", async () => {
  const manager = managerHarness();
  const { a, b } = await startTwo(manager);
  const rawA = { ok: true, app: "Alpha", nodes: [{ ref: "e1", role: "AXButton", title: "Alpha action" }] };
  const rawB = { ok: true, app: "Beta", nodes: [{ ref: "e1", role: "AXButton", title: "Beta action" }] };
  const snapA = manager.recordSnapshot(101, 11, rawA, { full: true, owner: "chat", targetId: a });
  const snapB = manager.recordSnapshot(202, 22, rawB, { full: true, owner: "chat", targetId: b });
  assert.notEqual(snapA.snapshotId, snapB.snapshotId);
  assert.equal(manager.resolveRefProvenance(101, "e1", 11, a).title, "Alpha action");
  assert.equal(manager.resolveRefProvenance(202, "e1", 22, b).title, "Beta action");
  assert.equal(manager.resolveRefProvenance(101, "e1", 11, b), null);
  assert.notEqual(manager.currentSnapshotId(101, 11, a), manager.currentSnapshotId(202, 22, b));
});

test("different targets execute concurrently; one target stays ordered", async () => {
  const manager = managerHarness();
  const { a, b } = await startTwo(manager);
  const events = [];
  let releaseA;
  manager._execRequest = async (argv) => {
    const target = argv[1];
    events.push(`start:${target}`);
    if (target === "slow") await new Promise((resolve) => { releaseA = resolve; });
    else await wait(30);
    events.push(`end:${target}`);
    return { ok: true, target };
  };
  // No gate/auth is involved in this direct exec test.
  manager.inputGateClosed = false;
  const slow = manager.exec(["snapshot", "slow"], undefined, { targetId: a });
  const fast = manager.exec(["snapshot", "fast"], undefined, { targetId: b });
  await wait(10);
  assert.ok(events.includes("start:slow") && events.includes("start:fast"),
    `both targets must start before either finishes: ${events}`);
  await fast;
  await wait(10);
  assert.ok(!events.includes("end:slow"), "the slow target is still in flight");
  releaseA();
  await slow;

  // Same target: the second command cannot start until the first settles.
  const order = [];
  manager._execRequest = async (argv) => {
    order.push(`start:${argv[1]}`);
    await wait(argv[1] === "one" ? 25 : 1);
    order.push(`end:${argv[1]}`);
    return { ok: true };
  };
  await Promise.all([
    manager.exec(["snapshot", "one"], undefined, { targetId: a }),
    manager.exec(["snapshot", "two"], undefined, { targetId: a }),
  ]);
  assert.deepEqual(order, ["start:one", "end:one", "start:two", "end:two"]);
});

test("stopping A closes only A's gate; B continues and a late A result stays frozen", async () => {
  const manager = managerHarness();
  manager._execRequest = async () => ({ ok: true });
  const { a, b } = await startTwo(manager);
  const mismatch = manager.refSnapshotMismatch; // keep no-op reference for clarity
  assert.equal(typeof mismatch, "function");

  const stopped = await manager.stopTarget(a, { pause: false, reason: "test" });
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  assert.equal(stopped.remainingTargets, 1);
  assert.equal(manager.activeSession.targetId, b);
  assert.equal(manager.inputGateClosed, false, "target stop must not close the global gate");

  const onA = await manager.exec(["snapshot"], undefined, { targetId: a });
  assert.equal(onA.ok, false);
  assert.equal(onA.error, "target_stopped");
  const onB = await manager.exec(["snapshot"], undefined, { targetId: b });
  assert.equal(onB.ok, true, "B must remain operable after A stopped");

  const all = await manager.stopVisualSession({ pause: false, reason: "test" });
  assert.equal(all.ok, true);
  assert.equal(manager.activeTargets().length, 0);
  const afterStop = await manager.exec(["key", "--name", "return"], undefined, { targetId: b });
  assert.equal(afterStop.ok, false);
  assert.ok(["cancelled", "target_closed"].includes(afterStop.error),
    `stop-all must refuse queued work, got ${afterStop.error}`);
});

test("a target incarnation change invalidates old refs and snapshots", async () => {
  const manager = managerHarness();
  const { a } = await startTwo(manager);
  const raw = { ok: true, app: "Alpha", nodes: [{ ref: "e1", role: "AXButton", title: "Old" }] };
  const snap = manager.recordSnapshot(101, 11, raw, { full: true, owner: "chat", targetId: a });
  assert.equal(manager.refSnapshotMismatch(101, "e1", 11, snap.snapshotId, "chat", a), null);
  manager.invalidateTarget(a, "window_gone");
  assert.equal(manager.resolveRefProvenance(101, "e1", 11, a), null);
  assert.match(manager.refSnapshotMismatch(101, "e1", 11, snap.snapshotId, "chat", a), /no snapshot|closed|replaced/);
  const reopened = manager.ensureTarget({ targetId: a }, { explicit: true });
  assert.ok(reopened.generation > 0);
  assert.equal(manager.resolveRefProvenance(101, "e1", 11, a), null);
});

test("the chat-level registry exposes both targets, stops one, and keeps the other live", async () => {
  const manager = managerHarness();
  const { a, b } = await startTwo(manager);
  const registry = createCuUiRegistry({ manager });
  const claim = registry.claim("chat-a");
  assert.equal(claim.ok, true);

  const ticketA = registry.beginAction("chat-a", { tool: "cu_click", targetId: a });
  assert.equal(ticketA.ok, true, JSON.stringify(ticketA));
  registry.endAction(ticketA.ticket, { ok: true, verified: true });
  const ticketB = registry.beginAction("chat-a", { tool: "cu_type", targetId: b });
  assert.equal(ticketB.ok, true, JSON.stringify(ticketB));
  registry.endAction(ticketB.ticket, { ok: true });

  const view = registry.snapshot("chat-a");
  assert.equal(view.targets.length, 2, JSON.stringify(view.targets));
  assert.equal(view.targets.find((target) => target.targetId === a).state, "verified");
  assert.equal(view.targets.find((target) => target.targetId === b).state, "unverified");
  assert.equal(new Set(view.targets.map((target) => target.targetId)).size, 2);

  const stoppedA = await registry.control({
    hostSessionId: "chat-a",
    cuSessionId: claim.cuSessionId,
    command: "stop",
    targetId: a,
  });
  assert.equal(stoppedA.ok, true, JSON.stringify(stoppedA));
  assert.equal(stoppedA.remainingTargets, 1);
  assert.equal(stoppedA.inputGateClosed, false);
  assert.equal(manager.targetForKey(a).gateClosed, true);
  assert.equal(manager.targetForKey(b).gateClosed, false);
  assert.equal(registry.snapshot("chat-a").targets.find((target) => target.targetId === a).active, false);
  assert.equal(registry.snapshot("chat-a").targets.find((target) => target.targetId === b).active, true);
  assert.equal(registry.snapshot("chat-a").state, "unverified");

  // A cannot be acted on after its stop; B can.
  const blockedA = registry.beginAction("chat-a", { tool: "cu_click", targetId: a });
  assert.equal(blockedA.ok, false);
  assert.equal(blockedA.error, "target_stopped");
  const stillB = registry.beginAction("chat-a", { tool: "cu_click", targetId: b });
  assert.equal(stillB.ok, true);
});

test("stop-all invalidates every target and refuses queued work", async () => {
  const manager = managerHarness();
  const { a, b } = await startTwo(manager);
  const registry = createCuUiRegistry({ manager });
  const claim = registry.claim("chat-a");
  const tickets = [
    registry.beginAction("chat-a", { tool: "cu_click", targetId: a }),
    registry.beginAction("chat-a", { tool: "cu_click", targetId: b }),
  ];
  assert.equal(tickets.every((ticket) => ticket.ok), true);
  const stopped = await registry.control({
    hostSessionId: "chat-a",
    cuSessionId: claim.cuSessionId,
    command: "stop",
  });
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  assert.equal(stopped.remainingTargets, 0);
  assert.equal(manager.activeTargets().length, 0);
  assert.equal(manager.inputGateClosed, true);
  const view = registry.snapshot("chat-a");
  assert.equal(view.targets.every((target) => target.active === false), true);
  assert.equal(view.state, "cleanup_unknown");
  for (const ticket of tickets) {
    const late = registry.endAction(ticket.ticket, { ok: true, verified: true });
    assert.equal(late.ok, true);
    assert.ok(late.ignored, "a late result after stop-all is history");
  }
});

test("a read-only sibling observation does not steal the chat's current target", async () => {
  const manager = managerHarness();
  const { b } = await startTwo(manager);
  assert.equal(manager.currentTargetKey, b);
  const sibling = manager.ensureTarget({ pid: 303, windowId: 33 }, { makePrimary: false });
  assert.ok(sibling);
  assert.equal(manager.currentTargetKey, b, "the last action target stays selected");
  assert.equal(manager.resolveTargetArgs({}).targetId, b);
});

test("native window_gone retires the target incarnation automatically", async () => {
  const manager = managerHarness();
  manager._execRequest = async () => ({ ok: false, error: "window_gone" });
  const { b } = await startTwo(manager);
  const result = await manager.exec(["click", "--x", "1", "--y", "1"], undefined, { targetId: b });
  assert.equal(result.error, "window_gone");
  const target = manager.targetForKey(b);
  assert.equal(target.closed, true, "a gone window must not stay addressable");
  assert.equal(target.gateClosed, true);
  const again = await manager.exec(["click", "--x", "1", "--y", "1"], undefined, { targetId: b });
  assert.equal(again.ok, false);
  assert.ok(["target_closed", "target_stopped"].includes(again.error));
});

test('polling reflects native preview close and native target stop without another model action', async () => {
  const manager = managerHarness();
  const { a, b } = await startTwo(manager);
  manager.targets.get(a).nativePreview = {status:'live',visible:true};
  const registry = createCuUiRegistry({manager});
  registry.claim('chat-a');
  assert.equal(registry.snapshot('chat-a').targets.find(t=>t.targetId===a).nativePreview.status,'live');
  manager.targets.get(a).nativePreview = {status:'closed',visible:false};
  assert.equal(registry.snapshot('chat-a').targets.find(t=>t.targetId===a).nativePreview.status,'closed');
  await manager.stopTarget(a);
  const snapshot = registry.snapshot('chat-a');
  assert.equal(snapshot.targets.find(t=>t.targetId===a).active,false);
  assert.equal(snapshot.targets.find(t=>t.targetId===b).active,true);
  registry.dispose();
});
