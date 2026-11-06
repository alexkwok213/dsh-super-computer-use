import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CuSessionManager } from '../lib/core.mjs';
import { registerCuTools } from '../lib/index.mjs';

function setup(t) {
  const stateDir = mkdtempSync(join(tmpdir(), 'cu-resume-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const manager = new CuSessionManager({ stateDir });
  manager.writeActivity = () => {};
  manager.setNativePreviewVisible = () => {};
  const tools = new Map();
  registerCuTools({ manager, defineTool: x => x,
    ctx: { tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } } } });
  return { manager, run: (name, args) => tools.get(name).execute(args, {}) };
}

test('explicit resume reopens the gate so the next launch is dispatched', async t => {
  const { manager, run } = setup(t);
  manager.inputGateClosed = true;
  manager.pauseLatched = true;
  const dispatched = [];
  manager._execRequest = async argv => { dispatched.push(argv[0]); return { ok: true }; };
  assert.equal((await run('cu_session', { action: 'resume' })).ok, true);
  const result = await run('cu_launch', { app: 'test-app' });
  assert.equal(result.launch.ok, true);
  assert.deepEqual(dispatched, ['resume', 'launch']);
});

test('failed resume reports failure and leaves the local gate closed', async t => {
  const { manager, run } = setup(t);
  manager.inputGateClosed = true;
  manager.pauseLatched = true;
  manager._execRequest = async () => ({ ok: false, error: 'service_unreachable' });
  const result = await run('cu_session', { action: 'resume' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'service_unreachable');
  assert.equal(manager.pauseLatched, true);
  assert.equal(manager.inputGateClosed, true);
});

test('a stop during resume wins over the late successful resume reply', async t => {
  const { manager, run } = setup(t);
  let reply;
  manager._execRequest = () => new Promise(resolve => { reply = resolve; });
  const pending = run('cu_session', { action: 'resume' });
  await new Promise(resolve => setImmediate(resolve));
  manager.inputGateClosed = true;
  manager.pauseLatched = true;
  manager.sessionGeneration++;
  reply({ ok: true });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error, 'cancelled');
  assert.equal(manager.inputGateClosed, true);
  assert.equal(manager.pauseLatched, true);
});

test('failed launch propagates failure and does not activate a window afterwards', async t => {
  const { manager, run } = setup(t);
  const dispatched = [];
  manager._execRequest = async argv => {
    dispatched.push(argv[0]);
    return { ok: false, error: 'cancelled', outcomeUnknown: true, actionReplaySafe: false };
  };
  const result = await run('cu_launch', { app: 'test-app', windowId: 123 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'cancelled');
  assert.equal(result.actionReplaySafe, false);
  assert.deepEqual(dispatched, ['launch']);
});

test('failed window activation propagates failure only after explicit foreground authorization', async t => {
  const { manager, run } = setup(t);
  manager._execRequest = async () => ({ ok: false, error: 'window_not_found' });
  const result = await run('cu_launch', {
    windowId: 123, background: false, authorizeForeground: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'window_not_found');
});

test('windowId stays in the background by default and never activates', async t => {
  const { manager, run } = setup(t);
  const dispatched = [];
  manager._execRequest = async (argv) => {
    dispatched.push(argv[0]);
    return { ok: true };
  };
  const result = await run('cu_launch', { windowId: 123 });
  assert.equal(result.ok, true);
  assert.equal(result.background, true);
  assert.equal(result.window.keptInBackground, true);
  assert.deepEqual(dispatched, [], 'no launch or activate command runs for a background window hint');
});

test('status identifies the loaded plugin separately from the native service', async t => {
  const { manager, run } = setup(t);
  manager.getStatus = async () => ({ ok: true, version: 'native-test-version' });
  const result = await run('cu_status', {});
  assert.equal(result.version, 'native-test-version');
  assert.equal(result.plugin.packageName, 'dsh-super-computer-use');
  assert.ok(result.plugin.version);
  assert.match(result.plugin.sourceHash, /^[a-f0-9]{64}$/);
  assert.ok(result.plugin.entryPath.endsWith('/lib/index.mjs'));
  assert.equal(result.plugin.hostPid, process.pid);
});
