// Task 8 wiring: a real session attaches retained elementTokens from the
// resident AX worker to cu_snapshot, and a ref click then acts on that token —
// never falling back to the path when identity is rejected. Tests stay on the
// old one-shot path because `_axWorkerAllowed` is false outside a real session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CuSessionManager } from '../lib/core.mjs';
import { registerCuTools } from '../lib/index.mjs';

const SNAPSHOT = {
  ok: true,
  pid: 42,
  app: 'Probe',
  count: 1,
  nodes: [{ ref: 'k0.3.2', role: 'AXButton', title: '导入', x: 300, y: 400, w: 80, h: 24 }],
};

function harness() {
  const tools = new Map();
  const ctx = { tools: { register(d) { tools.set(d.name, d); return () => tools.delete(d.name); } }, get: () => undefined };
  const manager = new CuSessionManager();
  manager._cursorWrite = () => true;
  manager.writeActivity = () => {};
  manager.activeSession = { windowId: 7, pid: 42 };
  const calls = [];
  manager.exec = async (argv) => {
    calls.push(argv[0]);
    if (argv[0] === 'snapshot') return SNAPSHOT;
    if (argv[0] === 'click') return { ok: true, action: 'click', x: 340, y: 412 };
    return { ok: true };
  };
  registerCuTools({ ctx, manager, config: { autoSession: false, observeBudgetMs: 0 } });
  const run = { signal: new AbortController().signal };
  return { manager, calls, call: (name, args) => tools.get(name).execute(args, run) };
}

test('a real session attaches elementTokens to cu_snapshot', async () => {
  const { manager, call } = harness();
  manager._axWorkerAllowed = true;
  manager.startAXWorker = async () => null;
  manager.axObserve = async () => manager._recordAXObservation({
    ok: true, epoch: 1, pid: 42, windowId: 7, observationId: 'obs-1',
    nodes: SNAPSHOT.nodes,
    candidates: [{ path: 'k0.3.2', elementToken: 'tok-A' }],
  });
  const snap = await call('cu_snapshot', { pid: 42, windowId: 7, full: true });
  assert.equal(snap.ok, true);
  assert.deepEqual(snap.elementTokens, { 'k0.3.2': 'tok-A' });
});

test('a ref click with a retained token dispatches via the worker, not the engine path', async () => {
  const { manager, calls, call } = harness();
  manager._axWorkerAllowed = true;
  manager.axTokens = new Map([['k0.3.2', 'tok-A']]);
  const dispatched = [];
  manager.axClick = async (token, action) => {
    dispatched.push([token, action]);
    return { ok: true, action: 'click', via: 'ax-worker' };
  };
  const res = await call('cu_click', { pid: 42, windowId: 7, ref: 'k0.3.2', observe: false });
  assert.deepEqual(dispatched, [['tok-A', 'AXPress']]);
  assert.equal(calls.includes('click'), false, 'must not click by path when a token exists');
  assert.equal(res.via, 'ax-worker-token');
});

test('a rejected identity is returned, never retried by path', async () => {
  const { manager, calls, call } = harness();
  manager._axWorkerAllowed = true;
  manager.axTokens = new Map([['k0.3.2', 'tok-A']]);
  manager.axClick = async () => ({ ok: false, error: 'identity_unproven' });
  const res = await call('cu_click', { pid: 42, windowId: 7, ref: 'k0.3.2', observe: false });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'identity_unproven');
  assert.equal(calls.includes('click'), false, 'a rejected identity must not fall back to path click');
});

test('outside a real session the old one-shot click path is used', async () => {
  const { manager, calls, call } = harness();
  // _axWorkerAllowed stays false (no startVisualSession).
  const res = await call('cu_click', { pid: 42, windowId: 7, ref: 'k0.3.2', observe: false });
  assert.equal(res.ok, true);
  assert.equal(calls.includes('click'), true);
});

test('cu_type writes to the retained object in ONE native command (no path re-resolve)', async () => {
  const { manager, calls, call } = harness();
  manager._axWorkerAllowed = true;
  manager.axWorkerTarget = { pid: 42, windowId: 7 };
  manager.axTokens = new Map([['k0.3.2', 'tok-A']]);
  const inputCalls = [];
  manager.axInput = async (...args) => { inputCalls.push(args); return { ok: true, via: 'ax-worker-token' }; };
  const res = await call('cu_type', { pid: 42, windowId: 7, ref: 'k0.3.2', text: 'hi', mode: 'setvalue', observe: false });
  assert.equal(res.ok, true);
  assert.equal(inputCalls.length, 1);
  assert.equal(inputCalls[0][0], 'tok-A');
  assert.equal(calls.includes('type') || calls.includes('setvalue'), false,
               'must not re-resolve the ref by path when a retained token is used');
});

test('cu_type does not type when the retained identity is rejected', async () => {
  const { manager, calls, call } = harness();
  manager._axWorkerAllowed = true;
  manager.axTokens = new Map([['k0.3.2', 'tok-A']]);
  manager.axVerify = async () => ({ ok: false, error: 'identity_unproven' });
  const res = await call('cu_type', { pid: 42, windowId: 7, ref: 'k0.3.2', text: 'hi', mode: 'type', observe: false });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'identity_unproven');
  assert.equal(calls.includes('type'), false, 'must not type into a rejected target');
});

test('the resident AX worker is bound to one target; a switch must not reuse it', async () => {
  const { manager } = harness();
  manager.axWorker = { exitCode: null, killed: false };
  manager.axWorkerTarget = { pid: 42, windowId: 7 };
  assert.equal(manager._axWorkerTargetMatches(42, 7), true, 'same target reuses');
  assert.equal(manager._axWorkerTargetMatches(99, 7), false, 'different pid must not reuse');
  assert.equal(manager._axWorkerTargetMatches(42, 9), false, 'different window must not reuse');
});

test('starting a new target session drops the old AX worker', async () => {
  const m = new CuSessionManager();
  let stopped = 0;
  m.stopAXWorker = () => { stopped += 1; };
  m.spawnIndicator = () => null;
  m.writeActivity = () => {};
  m.clearPauseLatch = () => {};
  m.stopVisualIndicatorsOnly = async () => {};
  m.warmCaptureDaemon = () => {};
  m.startScreenIndicator = () => {};
  m.startCursorOverlay = () => null;
  m.setAgentAura = () => {};
  m.exec = async (argv) => (argv[0] === "windows" ? { ok: true, windows: [] } : { ok: true });
  m.activeSession = { windowId: 7, pid: 5 };
  await m.startVisualSession({ windowId: 9, pid: 6 }); // different target
  assert.equal(stopped >= 1, true, 'a target switch must stop the old AX worker');
});
