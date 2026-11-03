// A preview is optional evidence attached to an action's answer. It must never
// decide how long that answer takes: the capture path has an 8 s engine cap, a
// 12 s daemon-request cap and a fallback shot, so a sick preview used to hold a
// completed click for seconds. These tests pin the budget and its degradation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CuSessionManager } from '../lib/core.mjs';
import { registerCuTools } from '../lib/index.mjs';

function harness(exec, config = {}, setup = () => {}) {
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
  setup(manager);
  registerCuTools({
    ctx,
    manager,
    config: { autoSession: false, observeBudgetMs: 0, previewBudgetMs: 120, ...config },
  });
  const run = { signal: new AbortController().signal };
  return { manager, call: (name, args) => tools.get(name).execute(args, run) };
}

const SNAPSHOT = { ok: true, pid: 42, app: 'Probe', count: 1, nodes: [{ ref: 'k0.0', role: 'AXButton', title: 'Go' }] };

test('a hanging preview degrades inside its budget and does not delay the action', async () => {
  let daemonStopped = false;
  const { call } = harness(
    async (argv) => (argv[0] === 'snapshot' ? SNAPSHOT : { ok: true, action: 'click', x: 5, y: 6 }),
    {},
    (manager) => {
      manager.captureShotViaDaemon = () => new Promise(() => {});
      manager.stopCaptureDaemon = () => {
        daemonStopped = true;
      };
    }
  );

  const started = Date.now();
  const result = await call('cu_click', { pid: 42, windowId: 7, x: 5, y: 6, preview: true });
  const elapsed = Date.now() - started;

  assert.equal(result.ok, true);
  assert.equal(result.preview.ok, false);
  assert.equal(result.preview.error, 'preview_budget_exceeded');
  assert.equal(result.preview.degraded, true);
  assert.equal(result.preview.actionReplaySafe, false);
  assert.ok(elapsed < 700, `action waited ${elapsed}ms for a preview that hung`);
  // The abandoned capture must not leave a zombie in front of the next request.
  assert.equal(daemonStopped, true);
  // The action's own evidence is still there.
  assert.equal(result.observation.ok, undefined);
  assert.equal(result.observation.mode, 'full');
});

test('a fast preview keeps its old shape and now reports where the pixels came from', async () => {
  const { call } = harness(
    async (argv) => (argv[0] === 'snapshot' ? SNAPSHOT : { ok: true, action: 'click', x: 5, y: 6 }),
    {},
    (manager) => {
      manager.captureShotViaDaemon = async () => ({
        ok: true,
        base64: Buffer.from('jpegbytes').toString('base64'),
        mimeType: 'image/jpeg',
        size: { width: 400, height: 300 },
        scale: 2,
        origin: { x: 10, y: 20 },
      });
    }
  );

  const result = await call('cu_click', { pid: 42, windowId: 7, x: 5, y: 6, preview: true });
  assert.equal(result.preview.ok, true);
  assert.equal(result.preview.via, 'daemon');
  assert.equal(result.preview.width, 800);
  assert.equal(result.preview.height, 600);
  assert.ok(result.preview.path, 'falls back to a temp file when the host cannot take images');
  assert.ok(result.preview.captureMs >= 0);
  assert.ok(result.preview.ms >= result.preview.captureMs);
});

test('a broken daemon falls back to the engine shot and says which path was used', async () => {
  const { call } = harness(
    async (argv) => {
      if (argv[0] === 'snapshot') return SNAPSHOT;
      if (argv[0] === 'click') return { ok: true, action: 'click', x: 5, y: 6 };
      if (argv[0] === 'shot') {
        return {
          ok: true,
          base64: Buffer.from('shotbytes').toString('base64'),
          mimeType: 'image/jpeg',
          size: { width: 100, height: 50 },
          scale: 1,
        };
      }
      return { ok: true };
    },
    {},
    (manager) => {
      manager.captureShotViaDaemon = async () => ({ ok: false, error: 'capture_daemon_unavailable' });
    }
  );

  const result = await call('cu_click', { pid: 42, windowId: 7, x: 5, y: 6, preview: true });
  assert.equal(result.preview.ok, true);
  assert.equal(result.preview.via, 'engine');
});

test('an explicit cu_screenshot stays unbudgeted: asking for it means waiting', async () => {
  const { call } = harness(
    async (argv) => {
      if (argv[0] !== 'shot') return { ok: true };
      await new Promise((resolve) => setTimeout(resolve, 900));
      return {
        ok: true,
        base64: Buffer.from('slowshot').toString('base64'),
        mimeType: 'image/jpeg',
        size: { width: 10, height: 10 },
        scale: 1,
      };
    },
    {},
    (manager) => {
      // Daemon misses instantly; the engine shot (the correct path for an
      // explicit request) takes longer than the default 600 ms preview budget.
      manager.captureShotViaDaemon = async () => ({ ok: false, error: 'no_daemon' });
    }
  );
  const result = await call('cu_screenshot', { windowId: 7 });
  assert.equal(result.ok, true);
});
