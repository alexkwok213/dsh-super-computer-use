// Path + role + title cannot tell two same-named controls apart once list rows
// reorder. An observation therefore carries a snapshot id, and a caller can hand
// it back with a ref: the action is refused if that observation is no longer the
// one backing the refs, instead of silently hitting whatever moved into the path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CuSessionManager } from '../lib/core.mjs';
import { registerCuTools } from '../lib/index.mjs';

const snapshotOf = (titles) => ({
  ok: true,
  pid: 42,
  app: 'Probe',
  count: titles.length,
  nodes: titles.map((title, index) => ({
    ref: `k0.${index}`,
    role: 'AXButton',
    title,
    enabled: true,
    x: 10,
    y: 10 + index * 30,
    w: 100,
    h: 24,
  })),
});

function harness(exec, config = {}) {
  const tools = new Map();
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    get: () => undefined,
  };
  const manager = new CuSessionManager();
  manager._cursorWrite = () => true;
  manager.activeSession = { windowId: 7, pid: 42 };
  manager.writeActivity = () => {};
  manager.exec = exec;
  registerCuTools({ ctx, manager, config: { autoSession: false, observeBudgetMs: 0, ...config } });
  const run = { signal: new AbortController().signal };
  const calls = [];
  const wrapped = async (...args) => {
    calls.push(args);
    return exec(...args);
  };
  manager.exec = wrapped;
  return { manager, calls, call: (name, args) => tools.get(name).execute(args, run) };
}

test('every observation carries a snapshot id, and a new read bumps it', async () => {
  const { call } = harness(async () => snapshotOf(['导入']));
  const first = await call('cu_snapshot', { pid: 42, windowId: 7 });
  assert.equal(typeof first.snapshotId, 'number');
  const second = await call('cu_snapshot', { pid: 42, windowId: 7 });
  assert.equal(second.snapshotId, first.snapshotId + 1);
});

test('a ref with the current snapshot id is accepted', async () => {
  const { call } = harness(async (argv) =>
    argv[0] === 'snapshot' ? snapshotOf(['导入']) : { ok: true, action: 'click', x: 60, y: 22 }
  );
  const snap = await call('cu_snapshot', { pid: 42, windowId: 7, full: true });
  const result = await call('cu_click', {
    pid: 42,
    windowId: 7,
    ref: 'k0.0',
    snapshotId: snap.snapshotId,
    observe: false,
  });
  assert.equal(result.ok, true);
});

test('a ref from a superseded observation is refused without touching the app', async () => {
  const { call, calls } = harness(async (argv) =>
    argv[0] === 'snapshot' ? snapshotOf(['导入']) : { ok: true, action: 'click', x: 60, y: 22 }
  );
  const first = await call('cu_snapshot', { pid: 42, windowId: 7, full: true });
  // A second observation (what an automatic post-action observe does) moves the
  // cache past the id the caller still holds.
  const second = await call('cu_snapshot', { pid: 42, windowId: 7, full: true });
  calls.length = 0;

  const result = await call('cu_click', {
    pid: 42,
    windowId: 7,
    ref: 'k0.0',
    snapshotId: first.snapshotId,
    observe: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'stale_snapshot');
  assert.equal(result.currentSnapshotId, second.snapshotId);
  assert.equal(result.actionReplaySafe, false);
  assert.equal(calls.filter(([argv]) => argv[0] === 'click').length, 0, 'no click may be dispatched');
});

test('the post-action observation hands back the id the next ref should use', async () => {
  const { call } = harness(async (argv) => {
    if (argv[0] === 'snapshot') return snapshotOf(['导入']);
    if (argv[0] === 'click') return { ok: true, action: 'click', x: 60, y: 22 };
    return { ok: true };
  });
  const first = await call('cu_snapshot', { pid: 42, windowId: 7, full: true });
  const clicked = await call('cu_click', { pid: 42, windowId: 7, ref: 'k0.0', snapshotId: first.snapshotId });
  assert.equal(clicked.ok, true);
  const chained = clicked.observation.snapshotId;
  assert.equal(typeof chained, 'number');
  assert.ok(chained > first.snapshotId, 'the observation must be newer than the one that was spent');
  const next = await call('cu_click', { pid: 42, windowId: 7, ref: 'k0.0', snapshotId: chained, observe: false });
  assert.equal(next.ok, true);
});

test('cu_type refuses a superseded ref the same way', async () => {
  const { call } = harness(async (argv) =>
    argv[0] === 'snapshot' ? snapshotOf(['搜索']) : { ok: true, delivered: true }
  );
  const first = await call('cu_snapshot', { pid: 42, windowId: 7, full: true });
  await call('cu_snapshot', { pid: 42, windowId: 7, full: true });
  const result = await call('cu_type', {
    pid: 42,
    windowId: 7,
    ref: 'k0.0',
    text: 'abc',
    snapshotId: first.snapshotId,
    observe: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'stale_snapshot');
});

test('a batch step with a superseded ref stops the batch before acting', async () => {
  const { call, calls } = harness(async (argv) =>
    argv[0] === 'snapshot' ? snapshotOf(['导入']) : { ok: true, action: 'click', x: 5, y: 6 }
  );
  const first = await call('cu_snapshot', { pid: 42, windowId: 7, full: true });
  await call('cu_snapshot', { pid: 42, windowId: 7, full: true });
  calls.length = 0;

  const result = await call('cu_batch', {
    pid: 42,
    windowId: 7,
    steps: [
      { action: 'click', x: 1, y: 2 },
      { action: 'click', ref: 'k0.0', snapshotId: first.snapshotId },
    ],
    observe: false,
    preview: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'stale_snapshot');
  assert.equal(result.failedStep, 1);
  assert.equal(calls.filter(([argv]) => argv[0] === 'click').length, 1, 'the stale step never reaches the engine');
});

test('omitting the id keeps the old behaviour', async () => {
  const { call } = harness(async (argv) =>
    argv[0] === 'snapshot' ? snapshotOf(['导入']) : { ok: true, action: 'click', x: 5, y: 6 }
  );
  await call('cu_snapshot', { pid: 42, windowId: 7, full: true });
  await call('cu_snapshot', { pid: 42, windowId: 7, full: true });
  const result = await call('cu_click', { pid: 42, windowId: 7, ref: 'k0.0', observe: false });
  assert.equal(result.ok, true);
});

test('a ref with no cached observation at all is refused, not guessed', async () => {
  const { call } = harness(async () => ({ ok: true }));
  const result = await call('cu_click', {
    pid: 42,
    windowId: 7,
    ref: 'k0.0',
    snapshotId: 1,
    observe: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'stale_snapshot');
  assert.match(result.message, /no snapshot is cached/);
});
