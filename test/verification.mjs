// Post-action waiting and verification. A single read right after an action is
// a race: a sheet or search result that paints 150 ms later was invisible. These
// tests pin the two mechanisms that replaced it — a bounded change-driven re-read
// and an explicit post-condition through the engine's `expect`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CuSessionManager, buildCommandArgv } from '../lib/core.mjs';
import { registerCuTools } from '../lib/index.mjs';

const tree = (titles) => ({
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

const BEFORE = tree(['导入', '导出']);
const AFTER = tree(['导入', '导出', '导入完成']);

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
  registerCuTools({
    ctx,
    manager,
    config: { autoSession: false, observeBudgetMs: 150, observePollMs: 40, observeMaxReads: 3, ...config },
  });
  const run = { signal: new AbortController().signal };
  return { manager, call: (name, args) => tools.get(name).execute(args, run) };
}

test('a click reports how long it waited and whether the tree moved', async () => {
  const reads = [BEFORE, BEFORE, AFTER];
  let snapshotReads = 0;
  const { call } = harness(async (argv) => {
    if (argv[0] === 'snapshot') {
      return reads[Math.min(snapshotReads++, reads.length - 1)];
    }
    if (argv[0] === 'click') return { ok: true, action: 'click', x: 60, y: 22 };
    return { ok: true };
  });

  await call('cu_snapshot', { pid: 42, windowId: 7 });
  const result = await call('cu_click', { pid: 42, windowId: 7, x: 60, y: 22 });

  assert.equal(result.ok, true);
  assert.equal(result.observation.changed, true, 'a late change must be caught');
  assert.equal(result.observation.reads, 2, 'one baseline-identical read, then the changed one');
  assert.ok(result.observation.waitedMs >= 20, `waited ${result.observation.waitedMs}ms`);
  assert.ok(
    result.observation.changes.some((line) => line.includes('导入完成')),
    JSON.stringify(result.observation.changes)
  );
});

test('a change on the first read keeps the fast path (no extra waiting)', async () => {
  let snapshotReads = 0;
  const { call } = harness(async (argv) => {
    if (argv[0] === 'snapshot') {
      snapshotReads += 1;
      return snapshotReads === 1 ? BEFORE : AFTER;
    }
    return { ok: true, action: 'click', x: 1, y: 2 };
  });
  await call('cu_snapshot', { pid: 42, windowId: 7 });
  const result = await call('cu_click', { pid: 42, windowId: 7, x: 1, y: 2 });
  assert.equal(result.observation.changed, true);
  assert.equal(result.observation.reads, 1);
});

test('an unchanged tree stops at the read cap and says so', async () => {
  const { call } = harness(async (argv) =>
    argv[0] === 'snapshot' ? BEFORE : { ok: true, action: 'click', x: 1, y: 2 }
  );
  await call('cu_snapshot', { pid: 42, windowId: 7 });
  const result = await call('cu_click', { pid: 42, windowId: 7, x: 1, y: 2 });
  assert.equal(result.observation.changed, false);
  assert.equal(result.observation.reads, 3);
  assert.ok(result.observation.waitedMs <= 400, `overspent the budget: ${result.observation.waitedMs}ms`);
});

test('an explicit post-condition is verified through the engine expect', async () => {
  const calls = [];
  const { call } = harness(async (argv) => {
    calls.push(argv);
    if (argv[0] === 'expect') return { ok: true, action: 'expect', ref: 'k0.1', title: '导出', ms: 240 };
    if (argv[0] === 'snapshot') return AFTER;
    return { ok: true, action: 'click', x: 1, y: 2 };
  });

  const result = await call('cu_click', {
    pid: 42,
    windowId: 7,
    x: 1,
    y: 2,
    expect: { query: '导出', enabled: true, timeoutMs: 800 },
  });

  const expectCall = calls.find((argv) => argv[0] === 'expect');
  assert.deepEqual(expectCall.slice(0, 2), ['expect', '--pid']);
  assert.ok(expectCall.includes('--find') && expectCall.includes('导出'));
  assert.ok(expectCall.includes('--enabled'));
  assert.equal(expectCall[expectCall.indexOf('--timeout') + 1], '800');
  assert.equal(result.verified, true);
  assert.equal(result.verification.matchedTitle, '导出');
  // The condition is what tells us the app finished, so it runs before the read.
  assert.ok(
    calls.findIndex((argv) => argv[0] === 'expect') <
      calls.findIndex((argv) => argv[0] === 'snapshot' && argv.includes('--no-actions')),
    JSON.stringify(calls.map((argv) => argv[0]))
  );
});

test('a condition that never holds is reported as unverified, not as a failed action', async () => {
  const { call } = harness(async (argv) => {
    if (argv[0] === 'expect') {
      return { ok: false, error: 'expect_failed', message: 'the control is no longer in the tree', ms: 500 };
    }
    if (argv[0] === 'snapshot') return BEFORE;
    return { ok: true, action: 'click', x: 1, y: 2 };
  });

  const result = await call('cu_click', { pid: 42, windowId: 7, x: 1, y: 2, expect: { query: '导入完成' } });

  assert.equal(result.ok, true, 'the click itself was accepted');
  assert.equal(result.verified, false);
  assert.equal(result.verification.error, 'expect_failed');
  assert.match(result.warning, /不要盲目重放/);
  // Same "do not replay" vocabulary the observation failure already uses.
  assert.equal(result.actionReplaySafe, false);
});

test('cu_expect can be called on its own and keeps the engine answer', async () => {
  const { call } = harness(async (argv) => {
    assert.equal(argv[0], 'expect');
    return { ok: true, action: 'expect', ref: 'k0.3', role: 'AXTextField', title: '搜索', enabled: true, ms: 90 };
  });
  const result = await call('cu_expect', { pid: 42, windowId: 7, ref: 'k0.3', timeoutMs: 1200 });
  assert.equal(result.ok, true);
  assert.equal(result.ref, 'k0.3');
  assert.equal(result.ms, 90);
});

test('cu_expect without a target explains itself instead of calling the engine', async () => {
  let called = false;
  const { call } = harness(async () => {
    called = true;
    return { ok: true };
  });
  const result = await call('cu_expect', { pid: 42 });
  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'expect_needs_target');
});

test('buildCommandArgv refuses an expect with neither ref nor query', () => {
  assert.throws(() => buildCommandArgv('expect', { pid: 1 }), /ref or query/);
});

test('a long poll says what it is waiting for, then confirms it', async () => {
  const activities = [];
  const tools = new Map();
  const ctx = {
    tools: { register: (d) => { tools.set(d.name, d); return () => {}; } },
    get: () => undefined,
  };
  const manager = new CuSessionManager();
  manager._cursorWrite = () => true;
  manager.writeActivity = (text) => activities.push(String(text));
  manager.activeSession = { windowId: 7, pid: 42 };
  manager.exec = async (argv) => {
    if (argv[0] === 'expect') return { ok: true, action: 'expect', ref: 'k0.1', ms: 300 };
    if (argv[0] === 'snapshot') return { ok: true, pid: 42, app: 'P', count: 0, nodes: [] };
    return { ok: true, action: 'click', x: 1, y: 2 };
  };
  registerCuTools({ ctx, manager, config: { autoSession: false, observeBudgetMs: 0 } });

  await tools.get('cu_click').execute({ ref: 'k0.1', expect: { query: '导入完成', timeoutMs: 600 } }, { signal: new AbortController().signal });

  assert.ok(activities.includes('等待 「导入完成」'), JSON.stringify(activities));
  assert.ok(activities.includes('已确认 「导入完成」'), JSON.stringify(activities));
});

test('a poll too short to be seen does not repaint the capsule', async () => {
  const activities = [];
  const tools = new Map();
  const ctx = {
    tools: { register: (d) => { tools.set(d.name, d); return () => {}; } },
    get: () => undefined,
  };
  const manager = new CuSessionManager();
  manager._cursorWrite = () => true;
  manager.writeActivity = (text) => activities.push(String(text));
  manager.activeSession = { windowId: 7, pid: 42 };
  manager.exec = async (argv) =>
    argv[0] === 'expect' ? { ok: true, action: 'expect', ms: 5 } : { ok: true, action: 'click', x: 1, y: 2 };
  registerCuTools({ ctx, manager, config: { autoSession: false, observeBudgetMs: 0 } });

  await tools.get('cu_expect').execute({ ref: 'k0.1', timeoutMs: 100 }, { signal: new AbortController().signal });
  assert.ok(!activities.some((a) => a.startsWith('等待')), JSON.stringify(activities));
});
