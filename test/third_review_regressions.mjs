// Regression tests derived from docs/reviews/third-review-probes.mjs (R1–R6, R9, R10).
//
// The review probes deliberately asserted that each DEFECT existed; exit code 0
// there meant "bug reproduced", not "product accepted". This file asserts the
// opposite: the correct, safe behaviour. Every test here is expected to FAIL on
// 4bfe1ca and PASS after the fix. Real CuSessionManager / real tool definitions,
// simulated engine + AX worker; no desktop control.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CuSessionManager } from '../lib/core.mjs';
import { registerCuTools } from '../lib/index.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REF = 'k0.3.2';
const NODES_A = [{ ref: REF, role: 'AXButton', title: 'Object A', x: 10, y: 20, w: 30, h: 20 }];
const ENGINE_SNAPSHOT = { ok: true, pid: 42, app: 'A', count: 1, nodes: NODES_A };

function harness(config = {}) {
  const definitions = new Map();
  const manager = new CuSessionManager();
  const execCalls = [];
  manager.activeSession = { pid: 42, windowId: 7 };
  manager.sessionId = 'review';
  manager.eventLog.setSession('review');
  manager.writeActivity = () => {};
  manager.assertCanAct = () => {};
  manager._cursorWrite = () => true;
  manager.exec = async (argv) => {
    execCalls.push(argv);
    return argv[0] === 'snapshot' ? ENGINE_SNAPSHOT : { ok: true };
  };
  const ctx = {
    tools: { register(d) { definitions.set(d.name, d); return () => {}; } },
    get: () => undefined,
  };
  registerCuTools({ ctx, manager, config: { autoSession: false, observeBudgetMs: 0, ...config } });
  const run = { signal: new AbortController().signal };
  return { manager, execCalls, call: (name, args) => definitions.get(name).execute(args, run) };
}

/** Put the manager into the state one retained AX observation would produce. */
function retainedObservation(m, {
  pid = 42, windowId = 7, epoch = 1, observationId = 'obs-1',
  nodes = NODES_A, token = 'token-for-A',
} = {}) {
  m._axWorkerAllowed = true;
  m.axWorkerTarget = { pid, windowId };
  m.axGeneration = m.axGeneration ?? 1;
  m.axWorker = {
    exitCode: null, killed: false,
    stdin: { write() {}, end() {} },
    stdout: new EventEmitter(),
    kill() {}, on() {}, off() {}, once() {},
  };
  m.startAXWorker = async () => m.axWorker;
  return m._recordAXObservation({
    ok: true, cmd: 'observe', epoch, pid, windowId, observationId,
    nodes,
    candidates: [{ path: REF, role: 'AXButton', title: nodes[0]?.title ?? '', elementToken: token, enabled: true }],
  });
}

// ---------------------------------------------------------------- R1 --------
test('R1: a token bound to target A is rejected when the caller explicitly targets B', async () => {
  const { manager: m, execCalls, call } = harness();
  retainedObservation(m);
  const calls = [];
  m.axClick = async (...args) => { calls.push(args); return { ok: true }; };
  const res = await call('cu_click', { pid: 99, windowId: 9, ref: REF, observe: false });
  assert.equal(calls.length, 0, 'no retained token may be dispatched to a different target');
  assert.equal(execCalls.some((a) => a[0] === 'click'), false, 'must not fall back to a path click either');
  assert.equal(res.ok, false);
  assert.ok(['target_mismatch', 'identity_unproven', 'stale_observation'].includes(res.error),
            `expected an explicit identity error, got ${JSON.stringify(res)}`);
  assert.equal(res.actionReplaySafe, false);
});

test('R1: same pid but a different window is also rejected', async () => {
  const { manager: m, call } = harness();
  retainedObservation(m);
  const calls = [];
  m.axClick = async (...args) => { calls.push(args); return { ok: true }; };
  const res = await call('cu_click', { pid: 42, windowId: 9, ref: REF, observe: false });
  assert.equal(calls.length, 0);
  assert.equal(res.ok, false);
});

test('R1: a token from a superseded worker generation is rejected', async () => {
  const { manager: m, call } = harness();
  retainedObservation(m);
  m.axGeneration += 1; // worker restarted / epoch rebuilt
  const calls = [];
  m.axClick = async (...args) => { calls.push(args); return { ok: true }; };
  const res = await call('cu_click', { pid: 42, windowId: 7, ref: REF, observe: false });
  assert.equal(calls.length, 0);
  assert.equal(res.ok, false);
});

// ---------------------------------------------------------------- R2 --------
test('R2: displayed snapshot nodes and elementTokens come from ONE retained observation', async () => {
  const { manager: m, execCalls, call } = harness();
  const reordered = [{ ref: REF, role: 'AXButton', title: 'Object B', x: 10, y: 20, w: 30, h: 20 }];
  retainedObservation(m, { nodes: reordered, token: 'token-for-B' });
  m.axObserve = async () => m._recordAXObservation({
    ok: true, cmd: 'observe', epoch: 1, pid: 42, windowId: 7, observationId: 'obs-2',
    nodes: reordered,
    candidates: [{ path: REF, role: 'AXButton', title: 'Object B', elementToken: 'token-for-B', enabled: true }],
  });
  const s = await call('cu_snapshot', { pid: 42, windowId: 7, full: true });
  assert.equal(s.ok, true);
  assert.ok(s.lines?.some((l) => l.includes('Object B')),
            'displayed nodes must come from the SAME observation that minted the tokens');
  assert.equal(s.elementTokens?.[REF], 'token-for-B');
  assert.equal(execCalls.some((a) => a[0] === 'snapshot'), false,
               'a second engine observation must not be spliced into the retained one');
  assert.ok(s.observationId, 'the observation must be identifiable');
});

// ---------------------------------------------------------------- R3 --------
test('R3: an identity-check exception stops input; no path-based write happens', async () => {
  const { manager: m, execCalls, call } = harness();
  retainedObservation(m);
  const inputCalls = [];
  m.axInput = async (...args) => { inputCalls.push(args); throw new Error('worker unavailable'); };
  const res = await call('cu_type', { pid: 42, windowId: 7, ref: REF, text: 'probe', mode: 'setvalue', observe: false });
  assert.equal(inputCalls.length, 1, 'the retained-object input must be attempted as ONE native command');
  assert.equal(execCalls.some((a) => ['setvalue', 'type', 'action'].includes(a[0])), false,
               'an unproven identity must never silently degrade to a path write');
  assert.equal(res.ok, false);
  assert.equal(res.actionReplaySafe, false);
});

test('R3: a successful retained-object input never re-resolves the ref by path', async () => {
  const { manager: m, execCalls, call } = harness();
  retainedObservation(m);
  const inputCalls = [];
  m.axInput = async (...args) => { inputCalls.push(args); return { ok: true, via: 'ax-worker-token' }; };
  const res = await call('cu_type', { pid: 42, windowId: 7, ref: REF, text: 'probe', mode: 'setvalue', observe: false });
  assert.equal(inputCalls.length, 1);
  assert.equal(inputCalls[0][0], 'token-for-A');
  assert.equal(execCalls.some((a) => ['setvalue', 'type', 'action'].includes(a[0])), false);
  assert.equal(res.ok, true);
});

// ---------------------------------------------------------------- R4 --------
test('R4: a late worker reply cannot satisfy another request, and a timeout invalidates the worker', async () => {
  const m = new CuSessionManager();
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stdin = {
    write(line) {
      const req = JSON.parse(line);
      setTimeout(() => child.stdout.emit('data',
        JSON.stringify({ ok: true, forRequest: req.name, requestId: req.requestId }) + '\n'),
        req.name === 'first' ? 40 : 80);
    },
    end() {},
  };
  child.kill = () => {};
  m.axWorker = child;
  m.axGeneration = 1;
  m._recordAXObservation({ ok: true, epoch: 1, pid: 42, windowId: 7, observationId: 'obs-1',
                           nodes: NODES_A, candidates: [{ path: REF, elementToken: 'token-for-A' }] });

  await assert.rejects(m._axRequest({ name: 'first' }, 10), /timeout|unavailable/);
  assert.equal(m.axTokens?.size ?? 0, 0, 'tokens of a timed-out worker must be invalidated');

  let served = null;
  try { served = await m._axRequest({ name: 'second' }, 200); } catch { /* expected */ }
  assert.equal(served?.forRequest, undefined, 'a late reply for "first" must never satisfy "second"');
  assert.equal(served?.ok, undefined);
  await sleep(90);
});

test('R4: a duplicate / unmatched worker reply is discarded, not delivered to a pending request', async () => {
  const m = new CuSessionManager();
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  child.kill = () => {};
  m.axWorker = child;
  m.axGeneration = 1;
  const pending = m._axRequest({ name: 'real' }, 300);
  await new Promise((r) => setTimeout(r, 0)); // let the queued run() register its requestId
  // A stale reply carrying a requestId nobody asked for must be dropped.
  child.stdout.emit('data', JSON.stringify({ ok: true, forRequest: 'stale', requestId: 'stale-id' }) + '\n');
  const realId = [...(m._axPending?.keys?.() ?? [])][0];
  assert.ok(realId, 'the request must be registered with a requestId');
  child.stdout.emit('data', JSON.stringify({ ok: true, forRequest: 'real', requestId: realId }) + '\n');
  const res = await pending;
  assert.equal(res.forRequest, 'real');
});

// ---------------------------------------------------------------- R5 --------
test('R5: a queued action never starts after stop, and reports outcomeUnknown', async () => {
  const m = new CuSessionManager();
  const sequence = [];
  for (const method of ['stopVisualIndicatorsOnly', 'setAgentAura', 'stopCursorOverlay',
    'stopCaptureDaemon', 'stopScreenIndicator', 'writeActivity', 'stopAXWorker']) m[method] = () => {};
  m._execRequest = async (argv, signal) => {
    sequence.push(`dispatch:${argv[1]}`);
    if (argv[1] === 'second') return { ok: true };
    return await new Promise((_resolve, reject) => {
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
  assert.equal(sequence.includes('dispatch:second'), false, 'queued action must not start after the gate closes');
  assert.equal(outcomes[1].ok, false);
  assert.equal(outcomes[1].outcomeUnknown, true);
  assert.equal(outcomes[1].actionReplaySafe, false);
  assert.equal(stop.session, 'stopped');
});

test('R5: a new action enqueued after stop is rejected without dispatch', async () => {
  const m = new CuSessionManager();
  for (const method of ['stopVisualIndicatorsOnly', 'setAgentAura', 'stopCursorOverlay',
    'stopCaptureDaemon', 'stopScreenIndicator', 'writeActivity', 'stopAXWorker']) m[method] = () => {};
  m._execRequest = async () => ({ ok: true, dispatched: true });
  await m.stopVisualSession();
  const res = await m.exec(['key', 'late']);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'cancelled');
  assert.equal(res.outcomeUnknown, true);
});

// ---------------------------------------------------------------- R6 --------
test('R6: an expired preview fallback does not block the next input action', async () => {
  const { manager: m, call } = harness({ previewBudgetMs: 20 });
  m.exec = CuSessionManager.prototype.exec.bind(m);
  m.captureShotViaDaemon = async () => ({ ok: false });
  m.stopCaptureDaemon = () => {};
  const sequence = [];
  m._execRequest = async (argv) => {
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
  assert.ok(nextActionMs < 80, `next action waited ${Math.round(nextActionMs)}ms for an abandoned preview`);
  assert.equal(sequence.includes('shot'), true, 'the fallback did start');
  assert.equal(sequence.indexOf('key') < sequence.indexOf('shot') + 100, true);
});

// ---------------------------------------------------------------- R9 --------
test('R9: type / key / scroll publish unified action events with real kind + terminal phase', async () => {
  const { manager: m, call } = harness();
  for (const [name, args] of [
    ['cu_type', { pid: 42, windowId: 7, text: 'probe', observe: false }],
    ['cu_key', { pid: 42, windowId: 7, name: 'tab', observe: false }],
    ['cu_scroll', { pid: 42, windowId: 7, dy: 10, observe: false }],
  ]) await call(name, args);
  const events = m.eventLog.events;
  assert.ok(events.length > 0, 'non-click actions must produce unified events');
  const kinds = new Set(events.map((e) => e.kind));
  for (const kind of ['type', 'key', 'scroll']) assert.ok(kinds.has(kind), `missing ${kind} events`);
  for (const kind of kinds) {
    const own = events.filter((e) => e.kind === kind);
    assert.ok(own.some((e) => e.phase === 'accepted'), `${kind} needs accepted`);
    assert.ok(own.some((e) => ['unverified', 'verified', 'failed', 'cancelled', 'unknown'].includes(e.phase)),
              `${kind} needs a terminal phase`);
  }
});

// ---------------------------------------------------------------- R10 -------
test('R10: right / double click on a retained token is not silently collapsed to AXPress', async () => {
  const { manager: m, call, execCalls } = harness();
  retainedObservation(m);
  const calls = [];
  m.axClick = async (...args) => { calls.push(args); return { ok: true }; };
  const res = await call('cu_click', { pid: 42, windowId: 7, ref: REF, button: 'right', count: 2, observe: false });
  assert.equal(calls.length, 0, 'AXPress is not semantically equivalent to right+double click');
  assert.equal(execCalls.some((a) => a[0] === 'click'), false, 'no silent path fallback');
  assert.equal(res.ok, false);
  assert.equal(res.actionReplaySafe, false);
  assert.match(String(res.error), /unsupported|semantics|button|count/i);
});

test('R10: a plain single left click on a retained token still dispatches AXPress', async () => {
  const { manager: m, call } = harness();
  retainedObservation(m);
  const calls = [];
  m.axClick = async (...args) => { calls.push(args); return { ok: true }; };
  const res = await call('cu_click', { pid: 42, windowId: 7, ref: REF, button: 'left', count: 1, observe: false });
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [['token-for-A', 'AXPress']]);
  assert.equal(res.ok, true);
});
