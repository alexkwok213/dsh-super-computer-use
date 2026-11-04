// Review probes for 4bfe1ca. These deliberately assert that reported gaps EXIST.
// A PASS here means reproduction succeeded, NOT that product acceptance passed.
// Real tool/manager code; simulated engine/worker. Never controls the desktop.
import assert from 'node:assert/strict';
import { CuSessionManager } from '../../lib/core.mjs';
import { registerCuTools } from '../../lib/index.mjs';
import { EventEmitter } from 'node:events';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ref = 'k0.3.2';
const snap = { ok: true, pid: 42, app: 'A', count: 1,
  nodes: [{ ref, role: 'AXButton', title: 'Object A', x: 10, y: 20, w: 30, h: 20 }] };
function harness(config = {}) {
  const definitions = new Map();
  const manager = new CuSessionManager();
  manager.activeSession = { pid: 42, windowId: 7 };
  manager.sessionId = 'review';
  manager.eventLog.setSession('review');
  manager.writeActivity = () => {};
  manager.assertCanAct = () => {};
  manager._cursorWrite = () => true;
  manager.exec = async argv => argv[0] === 'snapshot' ? snap : { ok: true };
  const ctx = { tools: { register(d) { definitions.set(d.name, d); return () => {}; } }, get: () => undefined };
  registerCuTools({ ctx, manager, config: { autoSession: false, observeBudgetMs: 0, ...config } });
  const run = { signal: new AbortController().signal };
  return { manager, call: (name, args) => definitions.get(name).execute(args, run) };
}
const results = [];
function record(name, detail) { results.push({ name, reproduced: true, ...detail }); }

// 1: explicit target B still looks up the ref in the target-A token map.
{
  const { manager: m, call } = harness();
  m._axWorkerAllowed = true;
  m.axWorkerTarget = { pid: 42, windowId: 7 };
  m.axTokens = new Map([[ref, 'token-for-A']]);
  const calls = [];
  m.axClick = async (...args) => { calls.push(args); return { ok: true }; };
  const result = await call('cu_click', { pid: 99, windowId: 9, ref, observe: false });
  assert.deepEqual(calls, [['token-for-A', 'AXPress']]);
  assert.equal(result.ok, true);
  record('cross_target_token_click', { requested: { pid: 99, windowId: 9 }, workerTarget: m.axWorkerTarget, calls });
}

// 2: public right/double-click arguments disappear on the token branch.
{
  const { manager: m, call } = harness();
  m._axWorkerAllowed = true;
  m.axTokens = new Map([[ref, 'token-for-A']]);
  const calls = [];
  m.axClick = async (...args) => { calls.push(args); return { ok: true }; };
  await call('cu_click', { pid: 42, windowId: 7, ref, button: 'right', count: 2, observe: false });
  assert.deepEqual(calls, [['token-for-A', 'AXPress']]);
  record('token_click_loses_semantics', { requested: { button: 'right', count: 2 }, calls });
}

// 3: tool snapshot and retained-token observation are separate observations.
{
  const { manager: m, call } = harness();
  m._axWorkerAllowed = true;
  m.startAXWorker = async () => ({});
  m.axObserve = async () => {
    // External reordering between the first snapshot and the worker observation.
    m.axTokens = new Map([[ref, 'token-for-B-now-at-same-path']]);
    return { ok: true };
  };
  const s = await call('cu_snapshot', { pid: 42, windowId: 7, full: true });
  let clicked;
  m.axClick = async token => { clicked = token; return { ok: true }; };
  await call('cu_click', { pid: 42, windowId: 7, ref, snapshotId: s.snapshotId, observe: false });
  assert.ok(s.lines.some(line => line.includes('Object A')));
  assert.equal(clicked, 'token-for-B-now-at-same-path');
  record('snapshot_token_observation_race', { displayed: s.lines, clickedToken: clicked });
}

// 4: verify errors are converted to null, then legacy path typing proceeds.
{
  const { manager: m, call } = harness();
  m._axWorkerAllowed = true;
  m.axTokens = new Map([[ref, 'token-for-A']]);
  m.axVerify = async () => { throw new Error('worker unavailable'); };
  const commands = [];
  m.exec = async argv => { commands.push(argv); return { ok: true }; };
  const result = await call('cu_type', { pid: 42, windowId: 7, ref, text: 'probe', mode: 'setvalue', observe: false });
  assert.equal(commands[0][0], 'setvalue');
  assert.equal(result.ok, true);
  record('verify_error_still_types_by_path', { commands });
}

// 5: default stop aborts an active fetch, but queued exec starts afterwards.
{
  const m = new CuSessionManager();
  const sequence = [];
  for (const method of ['stopVisualIndicatorsOnly', 'setAgentAura', 'stopCursorOverlay',
    'stopCaptureDaemon', 'stopScreenIndicator', 'writeActivity', 'stopAXWorker']) m[method] = () => {};
  m._execRequest = async (argv, signal) => {
    sequence.push(`dispatch:${argv[1]}`);
    if (argv[1] === 'second') return { ok: true };
    return await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
      }, { once: true });
    });
  };
  const first = m.exec(['key', 'first']);
  const second = m.exec(['key', 'second']);
  await sleep(5);
  sequence.push('stop-called');
  const stop = await m.stopVisualSession();
  const outcomes = await Promise.all([first, second]);
  assert.ok(sequence.indexOf('dispatch:second') > sequence.indexOf('stop-called'));
  assert.equal(outcomes[1].ok, true);
  assert.equal(stop.session, 'stopped');
  record('queued_exec_survives_stop', { sequence, outcomes, paused: stop.paused });
}

// 6: a fallback already started before expiry still blocks the shared queue.
{
  const { manager: m, call } = harness({ previewBudgetMs: 20 });
  m.exec = CuSessionManager.prototype.exec.bind(m);
  m.captureShotViaDaemon = async () => ({ ok: false });
  m.stopCaptureDaemon = () => {};
  const sequence = [];
  m._execRequest = async argv => {
    sequence.push(argv[0]);
    if (argv[0] === 'shot') {
      await sleep(150);
      return { ok: true, base64: 'eA==', size: { width: 1, height: 1 }, scale: 1 };
    }
    return { ok: true, x: 5, y: 6 };
  };
  const click = await call('cu_click', { pid: 42, windowId: 7, x: 5, y: 6, observe: false, preview: true });
  const start = performance.now();
  await m.exec(['key', '--name', 'tab']);
  const nextActionMs = performance.now() - start;
  assert.equal(click.preview.error, 'preview_budget_exceeded');
  assert.ok(nextActionMs > 80, String(nextActionMs));
  record('inflight_fallback_blocks_next_action', { sequence, nextActionMs: Math.round(nextActionMs) });
}

// 7: the real tool definitions emit no unified events for type/key/scroll.
{
  const { manager: m, call } = harness();
  for (const [name, args] of [
    ['cu_type', { pid: 42, windowId: 7, text: 'probe', observe: false }],
    ['cu_key', { pid: 42, windowId: 7, name: 'tab', observe: false }],
    ['cu_scroll', { pid: 42, windowId: 7, dy: 10, observe: false }],
  ]) await call(name, args);
  assert.equal(m.eventLog.events.length, 0);
  record('nonclick_actions_have_no_unified_events', { eventCount: m.eventLog.events.length });
}

// 8: worker replies have no request ID; a timed-out reply can satisfy the next call.
{
  const m = new CuSessionManager();
  const child = new EventEmitter();
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stdin = { write(line) {
    const request = JSON.parse(line);
    setTimeout(() => child.stdout.emit('data', JSON.stringify({ ok: true, forRequest: request.name }) + '\n'),
      request.name === 'first' ? 40 : 80);
  } };
  m.axWorker = child;
  await assert.rejects(m._axRequest({ name: 'first' }, 10), /timeout/);
  const second = await m._axRequest({ name: 'second' }, 200);
  assert.equal(second.forRequest, 'first');
  record('late_worker_reply_misattributed', { requested: 'second', received: second });
  await sleep(85);
}

console.log(JSON.stringify({ baseline: '4bfe1ca', simulated: true, results }, null, 2));
