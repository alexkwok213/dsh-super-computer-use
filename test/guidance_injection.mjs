// Push-mode knowledge: the router's advice must arrive WITH the tool result,
// not only in a static skill. Also guards the regression boundary — unit tests
// that register tools against a bare manager must never see the extra field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CuSessionManager } from '../lib/core.mjs';
import { registerCuTools } from '../lib/index.mjs';

const WINDOWS = {
  ok: true,
  frontmost: { app: 'Freeform', pid: 63103 },
  windows: [{ app: 'Freeform', title: 'Untitled', pid: 63103, windowId: 10429, frontmost: true }],
};

function harness({ guidanceConfig, withSession = true, frontmost = true } = {}) {
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
  manager.writeActivity = () => {};
  manager.captureShotViaDaemon = async () => ({ ok: false, error: 'no_daemon' });
  manager.stopCaptureDaemon = () => {};
  manager.exec = async (argv) => (argv[0] === 'windows' && frontmost ? WINDOWS : { ok: true, windows: [] });
  manager.getStatus = async () => (frontmost
    ? { ok: true, frontmost: { app: 'Freeform', pid: 63103 } }
    : { ok: true, frontmost: null });
  if (withSession) manager.activeSession = { app: 'Freeform', pid: 63103, windowId: 10429 };
  const config = { autoSession: false, observeBudgetMs: 0, ...(guidanceConfig ?? {}) };
  registerCuTools({ ctx, manager, config });
  const run = { signal: new AbortController().signal, agent: { options: { provider: 'p', model: 'm' } } };
  return { call: (name, args) => tools.get(name).execute(args, run) };
}

test('an operating tool result carries a bounded, useful guidance field', async () => {
  const h = harness();
  const r = await h.call('cu_route', { intent: '在 Freeform 上画出这幅图', appName: 'Freeform' });
  assert.equal(r.ok, true);
  assert.equal(r.recommended.id, 'exactCopy', 'the route answer is unchanged');
  assert.ok(Array.isArray(r.guidance), 'guidance is injected');
  assert.ok(r.guidance.length > 0 && r.guidance.length <= 3, 'at most three lines');
  assert.equal(new Set(r.guidance).size, r.guidance.length, 'no duplicates');
  assert.ok(r.guidance.some((g) => g.includes('cu_route')), 'channel/cost hint present');
  assert.ok(r.guidance.some((g) => g.includes('apple-freeform')), 'matched playbook hint present');
});

test('guidance can be switched off via config', async () => {
  const r = await harness({ guidanceConfig: { guidance: false } })
    .call('cu_route', { intent: '画出这幅图', appName: 'Freeform' });
  assert.equal(r.guidance, undefined);
  assert.equal(r.ok, true);
});

test('no active session means no extra field (unit-test shape stays stable)', async () => {
  const r = await harness({ withSession: false })
    .call('cu_route', { intent: '画出这幅图', appName: 'Freeform' });
  assert.equal(r.guidance, undefined);
  assert.equal(r.recommended.id, 'exactCopy');
});

test('cu_windows and cu_status surface the frontmost app playbook', async () => {
  const h = harness();
  const win = await h.call('cu_windows', {});
  assert.equal(win.ok, true);
  assert.deepEqual(win.activeAppPlaybook, { id: 'apple-freeform', title: 'Apple Freeform（白板绘图）' });
  const status = await h.call('cu_status', {});
  assert.deepEqual(status.activeAppPlaybook, { id: 'apple-freeform', title: 'Apple Freeform（白板绘图）' });
});

test('an unknown frontmost app reports null rather than a guessed playbook', async () => {
  const h = harness({ frontmost: false });
  const win = await h.call('cu_windows', {});
  assert.equal(win.activeAppPlaybook, null);
});
