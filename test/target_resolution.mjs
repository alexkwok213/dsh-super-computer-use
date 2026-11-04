// F1: a session target is an APPLICATION + WINDOW together, not two independent
// defaults. When a caller names a different app, the old session window must not
// ride along — the engine would otherwise hand that window's owner the click.
// F8: a host that enforces `required` before execute must not reject a snapshot /
// expect call that legitimately inherits the session target.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CuSessionManager } from '../lib/core.mjs';
import { registerCuTools } from '../lib/index.mjs';

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
  registerCuTools({ ctx, manager, config: { autoSession: false, observeBudgetMs: 0, ...config } });
  const run = { signal: new AbortController().signal };
  const calls = [];
  const wrapped = async (...args) => {
    calls.push(args);
    return exec(...args);
  };
  manager.exec = wrapped;
  return { manager, calls, tools, call: (name, args) => tools.get(name).execute(args, run) };
}

const clickArgv = (calls) => {
  const hit = calls.find(([argv]) => argv[0] === 'click');
  assert.ok(hit, 'a click must reach the engine');
  return hit[0];
};
const argvHasPair = (argv, flag, value) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] === String(value);
};

const echoExec = async (argv) =>
  argv[0] === 'click' ? { ok: true, action: 'click', x: 5, y: 6 } : { ok: true };

test('an explicit pid for a different app does not inherit the session window', async () => {
  const { call, calls } = harness(echoExec);
  const res = await call('cu_click', { x: 5, y: 6, pid: 99, observe: false });
  assert.equal(res.ok, true);
  const argv = clickArgv(calls);
  assert.ok(argvHasPair(argv, '--pid', 99), `pid 99 must be kept: ${argv.join(' ')}`);
  assert.ok(!argv.includes('--window'), `window 7 must not ride along: ${argv.join(' ')}`);
});

test('an explicit window with no pid is resolved by the engine, never by session pid', async () => {
  const { call, calls } = harness(echoExec);
  const res = await call('cu_click', { x: 5, y: 6, windowId: 9, observe: false });
  assert.equal(res.ok, true);
  const argv = clickArgv(calls);
  assert.ok(argvHasPair(argv, '--window', 9), `window 9 must be kept: ${argv.join(' ')}`);
  assert.ok(!argvHasPair(argv, '--pid', 42), `session pid 42 must not be assumed: ${argv.join(' ')}`);
});

test('an explicit pid that matches the session keeps the session window', async () => {
  const { call, calls } = harness(echoExec);
  const res = await call('cu_click', { x: 5, y: 6, pid: 42, observe: false });
  assert.equal(res.ok, true);
  const argv = clickArgv(calls);
  assert.ok(argvHasPair(argv, '--pid', 42));
  assert.ok(argvHasPair(argv, '--window', 7), `same app keeps the window: ${argv.join(' ')}`);
});

test('an explicit same-app, different window is kept as given', async () => {
  const { call, calls } = harness(echoExec);
  const res = await call('cu_click', { x: 5, y: 6, pid: 42, windowId: 9, observe: false });
  assert.equal(res.ok, true);
  const argv = clickArgv(calls);
  assert.ok(argvHasPair(argv, '--pid', 42));
  assert.ok(argvHasPair(argv, '--window', 9));
});

test('omitting the target entirely inherits the whole session target', async () => {
  const { call, calls } = harness(echoExec);
  const res = await call('cu_click', { x: 5, y: 6, observe: false });
  assert.equal(res.ok, true);
  const argv = clickArgv(calls);
  assert.ok(argvHasPair(argv, '--pid', 42));
  assert.ok(argvHasPair(argv, '--window', 7));
});

test('a mismatched pid/window is forwarded intact so the engine can refuse it', async () => {
  const { call, calls } = harness(async (argv) =>
    argv[0] === 'click'
      ? { ok: false, error: 'target_mismatch', message: 'pid 99 does not own window 7' }
      : { ok: true }
  );
  const res = await call('cu_click', { x: 5, y: 6, pid: 99, windowId: 7, observe: false });
  const argv = clickArgv(calls);
  assert.ok(argvHasPair(argv, '--pid', 99), 'the explicit pid is not silently replaced');
  assert.ok(argvHasPair(argv, '--window', 7), 'the explicit window is kept for the engine to validate');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'target_mismatch');
});

// --- F8: host parameter-enforcement path ----------------------------------
// The real host normalizes `required: true` on a property into the call's
// required-argument set *before* execute() runs. This gate mirrors that one
// step exactly, so a session-inherited call is proven to survive validation
// instead of only being dispatched when a test calls execute() directly.
const requiredNames = (parameters) =>
  Object.entries(parameters)
    .filter(([, spec]) => spec && spec.required === true)
    .map(([name]) => name);

function hostRequiredGate(tool, callArgs) {
  const missing = requiredNames(tool.parameters).filter((name) => callArgs[name] === undefined);
  if (missing.length) {
    throw new Error(`${tool.name} rejected by host: missing required ${missing.join(', ')}`);
  }
}

test('cu_snapshot survives the host required-gate without a pid and binds the session', async () => {
  const { call, calls, tools } = harness(async (argv) => ({ ok: true, pid: 42, app: 'Probe', nodes: [] }));
  const tool = tools.get('cu_snapshot');
  assert.doesNotThrow(() => hostRequiredGate(tool, {}), 'a session call must not require an explicit pid');
  await call('cu_snapshot', { full: true });
  const argv = calls.find(([a]) => a[0] === 'snapshot')[0];
  assert.ok(argvHasPair(argv, '--pid', 42));
  assert.ok(argvHasPair(argv, '--window', 7));
});

test('cu_expect survives the host required-gate without a pid and binds the session', async () => {
  const { call, calls, tools } = harness(async (argv) => ({ ok: true, action: 'expect' }));
  const tool = tools.get('cu_expect');
  assert.doesNotThrow(() => hostRequiredGate(tool, { query: 'Ready' }));
  await call('cu_expect', { query: 'Ready' });
  const argv = calls.find(([a]) => a[0] === 'expect')[0];
  assert.ok(argvHasPair(argv, '--pid', 42));
  assert.ok(argvHasPair(argv, '--window', 7));
});
