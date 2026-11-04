// Action event protocol v1 (Spec §5.2). One normalized event drives the
// overlay/capsule/tool state, so these tests pin the contract: every action kind
// uses the same phases, a refused dispatch never claims "dispatched", and a
// verification that did not match can never become "verified".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CuSessionManager } from '../lib/core.mjs';
import { registerCuTools } from '../lib/index.mjs';
import {
  KINDS,
  PHASES,
  normalizeActionEvent,
  createActionEventLog,
  createEventStreamParser,
} from '../lib/action-events.mjs';

const emittedNs = '1700000000000000000';
const baseEvent = (over = {}) => ({
  version: 1,
  sessionId: 's1',
  actionId: 'a1-click',
  eventId: 'e1',
  source: 'adapter',
  phase: 'accepted',
  kind: 'click',
  target: null,
  clockDomain: 'adapter',
  emittedNs,
  ...over,
});
const target = { pid: 42, windowId: 7, targetGeneration: 1, geometryVersion: 1 };

test('every action kind uses the same phase vocabulary', () => {
  for (const kind of KINDS) {
    for (const phase of PHASES) {
      const raw = baseEvent({
        kind,
        phase,
        target,
        ...(phase === 'verified' ? { verification: { matched: true, evidenceRef: 'x' } } : {}),
      });
      const normalized = normalizeActionEvent(raw);
      assert.equal(normalized.ok, true, `${kind}/${phase}: ${JSON.stringify(normalized)}`);
      assert.equal(normalized.event.seq, undefined, 'normalize must not assign seq');
    }
  }
});

test('accepted may omit a target but targetReady/dispatched may not', () => {
  assert.equal(normalizeActionEvent(baseEvent({ phase: 'accepted', target: null })).ok, true);
  assert.equal(normalizeActionEvent(baseEvent({ phase: 'targetReady', target: null })).ok, false);
  assert.equal(normalizeActionEvent(baseEvent({ phase: 'dispatched', target: null })).ok, false);
});

test('verified requires matched evidence; a failed verification cannot be verified', () => {
  assert.equal(normalizeActionEvent(baseEvent({ phase: 'verified', target })).ok, false);
  assert.equal(
    normalizeActionEvent(baseEvent({ phase: 'verified', target, verification: { matched: false, evidenceRef: 'x' } })).ok,
    false
  );
  assert.equal(
    normalizeActionEvent(baseEvent({ phase: 'verified', target, verification: { matched: true, evidenceRef: 'expect' } })).ok,
    true
  );
});

test('(0,0) is a legal point; non-finite numbers are rejected', () => {
  assert.equal(normalizeActionEvent(baseEvent({ target, point: { x: 0, y: 0 } })).ok, true);
  assert.equal(normalizeActionEvent(baseEvent({ target, point: { x: Number.NaN, y: 1 } })).ok, false);
  assert.equal(normalizeActionEvent(baseEvent({ target: { ...target, pid: Number.POSITIVE_INFINITY } })).ok, false);
  assert.equal(normalizeActionEvent(baseEvent({ emittedNs: 1700000000000000000 })).ok, false, 'emittedNs must be a digit string');
});

test('dedupe by eventId happens before seq, and seq is monotonic', () => {
  const log = createActionEventLog({ currentSessionId: 's1' });
  const first = log.publish(baseEvent({ eventId: 'e1', target }));
  assert.equal(first.ok, true);
  assert.equal(first.event.seq, 1);
  const replay = log.publish(baseEvent({ eventId: 'e1', target, phase: 'dispatched' }));
  assert.equal(replay.ok, false);
  assert.equal(replay.duplicate, true);
  assert.equal(log.seq, 1, 'a duplicate must not advance seq');
  const second = log.publish(baseEvent({ eventId: 'e2', target }));
  assert.equal(second.event.seq, 2);
});

test('an event from a superseded session is refused', () => {
  const log = createActionEventLog({ currentSessionId: 's2' });
  const res = log.publish(baseEvent({ sessionId: 's1', target }));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'stale_session');
});

test('the NDJSON parser tolerates split chunks, multiple lines, and old single JSON', () => {
  const seen = [];
  const parser = createEventStreamParser({ onEvent: (e) => seen.push(e.phase) });
  const line1 = JSON.stringify({ kind: 'event', event: baseEvent({ eventId: 'e1', phase: 'targetReady', target }) });
  const line2 = JSON.stringify({ kind: 'event', event: baseEvent({ eventId: 'e2', phase: 'dispatched', target }) });
  const line3 = JSON.stringify({ kind: 'result', result: { ok: true, action: 'click' } });
  // Split arbitrarily across chunks, several lines per chunk.
  parser.push(line1.slice(0, 12));
  parser.push(line1.slice(12) + '\n' + line2 + '\n');
  parser.push(line3 + '\n');
  const final = parser.end();
  assert.equal(final.ok, true);
  assert.equal(final.result.ok, true);
  assert.deepEqual(seen, ['targetReady', 'dispatched']);

  const old = createEventStreamParser();
  old.push(JSON.stringify({ ok: true, action: 'click' }) + '\n');
  const oldFinal = old.end();
  assert.equal(oldFinal.ok, true);
  assert.equal(oldFinal.result.action, 'click');
});

test('a stream that disconnects after events does not become success', () => {
  const parser = createEventStreamParser();
  parser.push(JSON.stringify({ kind: 'event', event: baseEvent({ eventId: 'e1', phase: 'dispatched', target }) }) + '\n');
  const final = parser.end(); // no final result
  assert.equal(final.ok, false);
  assert.equal(final.error, 'stream_incomplete');
  assert.equal(final.sawEvents, true);
  assert.equal(final.events.length, 1);
});

// --- exec(argv, signal, {eventsVersion,onEvent}) -------------------------
function fakeFetchOnce(payloadChunks) {
  return async () => {
    let i = 0;
    return {
      ok: true,
      headers: { get: () => 'application/x-ndjson' },
      body: {
        getReader() {
          return {
            async read() {
              if (i < payloadChunks.length) return { done: false, value: Buffer.from(payloadChunks[i++]) };
              return { done: true, value: undefined };
            },
          };
        },
      },
    };
  };
}

test('exec consumes an NDJSON stream and hands each event to onEvent', async () => {
  const m = new CuSessionManager();
  const originalFetch = globalThis.fetch;
  const events = [];
  const ev = baseEvent({ eventId: 'n1', source: 'native', phase: 'dispatched', target });
  globalThis.fetch = fakeFetchOnce([
    JSON.stringify({ kind: 'event', event: ev }) + '\n' + JSON.stringify({ kind: 'result', result: { ok: true } }) + '\n',
  ]);
  try {
    const result = await m.exec(['key', '--name', 'tab'], undefined, {
      eventsVersion: 1,
      eventContext: { sessionId: 's1', actionId: 'a1-key', targetGeneration: 1 },
      onEvent: (e) => events.push(e.phase),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(events, ['dispatched']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- adapter wiring through cu_click -------------------------------------
function harness(exec) {
  const tools = new Map();
  const ctx = {
    tools: { register(d) { tools.set(d.name, d); return () => tools.delete(d.name); } },
    get: () => undefined,
  };
  const manager = new CuSessionManager();
  manager._cursorWrite = () => true;
  manager.activeSession = { windowId: 7, pid: 42 };
  manager.sessionId = 's1';
  manager.eventLog.setSession('s1');
  manager.writeActivity = () => {};
  manager.exec = exec;
  registerCuTools({ ctx, manager, config: { autoSession: false, observeBudgetMs: 0 } });
  const run = { signal: new AbortController().signal };
  return { manager, call: (name, args) => tools.get(name).execute(args, run) };
}

test('cu_click publishes accepted→targetReady→dispatched→unverified, never verified without an expect', async () => {
  const { manager, call } = harness(async (argv) =>
    argv[0] === 'click' ? { ok: true, action: 'click', x: 5, y: 6 } : { ok: true }
  );
  await call('cu_click', { pid: 42, windowId: 7, x: 5, y: 6, observe: false });
  const phases = manager.eventLog.events.map((e) => e.phase);
  assert.deepEqual(phases, ['accepted', 'targetReady', 'dispatched', 'unverified']);
});

test('a refused click publishes failed and never dispatched', async () => {
  const { manager, call } = harness(async (argv) =>
    argv[0] === 'click' ? { ok: false, error: 'control_disabled' } : { ok: true }
  );
  await call('cu_click', { pid: 42, windowId: 7, x: 5, y: 6, observe: false });
  const phases = manager.eventLog.events.map((e) => e.phase);
  assert.ok(phases.includes('failed'));
  assert.ok(!phases.includes('dispatched'), `refused click must not dispatch: ${phases}`);
});
