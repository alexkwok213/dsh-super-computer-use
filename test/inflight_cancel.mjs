// Task 8: a user stop must cancel in-flight work; a cancelled action reports its
// outcome as UNKNOWN (it may already have been dispatched) — never "did not run".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CuSessionManager } from '../lib/core.mjs';

function manager() {
  const m = new CuSessionManager();
  m.readServiceConfig = () => ({ baseUrl: 'http://127.0.0.1:1', token: 't' });
  return m;
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test('a normal exec still resolves', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ headers: { get: () => 'application/json' }, json: async () => ({ ok: true }) });
  try {
    const m = manager();
    const res = await m.exec(['key', '--name', 'tab']);
    assert.equal(res.ok, true);
  } finally { globalThis.fetch = original; }
});

test('cancelInFlight aborts an in-flight exec and reports cancelled/unknown', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (_url, opts) => new Promise((_resolve, reject) => {
    const signal = opts.signal;
    const onAbort = () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const m = manager();
    const pending = m.exec(['key', '--name', 'tab']);
    await tick();
    const n = m.cancelInFlight();
    assert.ok(n >= 1, 'one in-flight action was cancelled');
    const res = await pending;
    assert.equal(res.ok, false);
    assert.equal(res.error, 'cancelled');
    assert.equal(res.outcomeUnknown, true);
    assert.equal(res.actionReplaySafe, false);
  } finally { globalThis.fetch = original; }
});

test('an external abort also yields cancelled/unknown', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (_url, opts) => new Promise((_resolve, reject) => {
    const signal = opts.signal;
    const onAbort = () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const m = manager();
    const ac = new AbortController();
    const pending = m.exec(['key', '--name', 'tab'], ac.signal);
    await tick();
    ac.abort();
    const res = await pending;
    assert.equal(res.error, 'cancelled');
    assert.equal(res.outcomeUnknown, true);
  } finally { globalThis.fetch = original; }
});

test('stopVisualSession cancels in-flight work', async () => {
  const m = manager();
  let cancelled = 0;
  m.cancelInFlight = () => { cancelled += 1; return 0; };
  m.stopVisualIndicatorsOnly = async () => {};
  m.setAgentAura = () => {};
  m.stopCursorOverlay = () => {};
  m.stopCaptureDaemon = () => {};
  m.stopScreenIndicator = () => {};
  m.writeActivity = () => {};
  m.stopAXWorker = () => {};
  m.exec = async () => ({ ok: true });
  m.activeSession = null;
  await m.stopVisualSession();
  assert.ok(cancelled >= 1, 'stop must cancel in-flight actions');
});
