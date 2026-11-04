// A preview is optional evidence attached to an action's answer. It must never
// decide how long that answer takes: the capture path has an 8 s engine cap, a
// 12 s daemon-request cap and a fallback shot, so a sick preview used to hold a
// completed click for seconds. These tests pin the budget and its degradation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CuSessionManager } from '../lib/core.mjs';
import { registerCuTools } from '../lib/index.mjs';
import { createPreviewDeadline } from '../lib/preview-deadline.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function harness(exec, config = {}, setup = () => {}, extra = {}) {
  const tools = new Map();
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    get: (key) => extra.ctx?.[key],
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
  const run = extra.run ?? { signal: new AbortController().signal };
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

// --- F3: whole-chain deadline -------------------------------------------
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const JPEG_B64 = JPEG_BYTES.toString('base64');

test('a spent preview never falls back to an engine shot that would block the next action', async () => {
  const calls = [];
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
  const exec = (argv) =>
    serial(async () => {
      calls.push(argv[0]);
      if (argv[0] === 'shot') {
        await sleep(130); // a ghost shot would sit in front of the next action
        return { ok: true, base64: JPEG_B64, mimeType: 'image/jpeg', size: { width: 10, height: 10 }, scale: 1 };
      }
      return { ok: true };
    });
  let daemonStopped = false;
  const { call } = harness(exec, { previewBudgetMs: 20 }, (manager) => {
    // The daemon is killed (budget expiry stops it); its pending request then
    // resolves {ok:false}. The old code fell through to an engine `shot` here —
    // a ghost that landed in the action queue and delayed the next action.
    manager.captureShotViaDaemon = () =>
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'capture daemon exited' }), 40));
    manager.stopCaptureDaemon = () => {
      daemonStopped = true;
    };
  });

  const started = Date.now();
  const click = await call('cu_click', { pid: 42, windowId: 7, x: 5, y: 6, preview: true, observe: false });
  assert.ok(Date.now() - started < 120, 'the action must not wait for the hung daemon');
  assert.equal(click.ok, true);
  assert.equal(click.preview.ok, false);
  assert.equal(click.preview.error, 'preview_budget_exceeded');
  assert.equal(daemonStopped, true);

  await sleep(90); // let the abandoned daemon promise reject and try to fall back
  assert.equal(calls.filter((c) => c === 'shot').length, 0, 'no ghost shot may be enqueued');

  const keyStarted = Date.now();
  const key = await call('cu_key', { pid: 42, name: 'tab', observe: false });
  assert.equal(key.ok, true);
  assert.ok(Date.now() - keyStarted < 60, 'a ghost shot would have added ~130 ms here');
});

test('an attachment save that outlives the budget degrades and never writes lastImage', async () => {
  let saveStarted = 0;
  const attachments = {
    imageLimits: {},
    saveImage: async ({ data }) => {
      saveStarted += 1;
      await sleep(130);
      return { attachmentId: 'a1', mediaType: 'image/jpeg', bytes: data.length, width: 1, height: 1 };
    },
  };
  const llm = { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) };
  const run = { signal: new AbortController().signal, agent: { options: { provider: 'p', model: 'm' } } };
  const { manager, call } = harness(
    async () => ({ ok: true }),
    { previewBudgetMs: 20 },
    (m) => {
      m.captureShotViaDaemon = async () => ({
        ok: true,
        base64: JPEG_B64,
        mimeType: 'image/jpeg',
        size: { width: 400, height: 300 },
        scale: 1,
      });
    },
    { ctx: { attachments, llm }, run }
  );

  const started = Date.now();
  const result = await call('cu_click', { pid: 42, windowId: 7, x: 5, y: 6, preview: true, observe: false });
  assert.ok(Date.now() - started < 100, 'the action must not wait for a slow attachment save');
  assert.equal(result.preview.ok, false);
  assert.equal(result.preview.error, 'preview_budget_exceeded');
  assert.equal(saveStarted, 1, 'the save did start — that is what the deadline bounds');
  assert.equal(manager.lastImage, undefined, 'a late attachment result must not publish');
  await sleep(160);
  assert.equal(manager.lastImage, undefined, 'still not published after the late save resolved');
});

test('a save that finishes after the session generation moves is discarded', async () => {
  const attachments = {
    imageLimits: {},
    saveImage: async ({ data }) => {
      await sleep(60);
      return { attachmentId: 'a2', mediaType: 'image/jpeg', bytes: data.length, width: 1, height: 1 };
    },
  };
  const llm = { resolveModelInfo: async () => ({ inputModalities: ['image'] }) };
  const run = { signal: new AbortController().signal, agent: { options: { provider: 'p', model: 'm' } } };
  const { manager, call } = harness(
    async () => ({ ok: true }),
    { previewBudgetMs: 500 },
    (m) => {
      m.sessionGeneration = 1;
      m.captureShotViaDaemon = async () => ({
        ok: true,
        base64: JPEG_B64,
        mimeType: 'image/jpeg',
        size: { width: 10, height: 10 },
        scale: 1,
      });
    },
    { ctx: { attachments, llm }, run }
  );
  setTimeout(() => {
    manager.sessionGeneration = 2;
  }, 15);
  const result = await call('cu_click', { pid: 42, windowId: 7, x: 5, y: 6, preview: true, observe: false });
  assert.equal(result.preview.ok, false);
  assert.equal(result.preview.error, 'preview_stale_generation');
  assert.equal(manager.lastImage, undefined);
});

test('a capture rejection that arrives after the budget is swallowed', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const { call } = harness(
      async () => ({ ok: true }),
      { previewBudgetMs: 10 },
      (m) => {
        m.captureShotViaDaemon = () =>
          new Promise((_, reject) => setTimeout(() => reject(new Error('late daemon failure')), 50));
        m.stopCaptureDaemon = () => {};
      }
    );
    const result = await call('cu_click', { pid: 42, windowId: 7, x: 5, y: 6, preview: true, observe: false });
    assert.equal(result.preview.ok, false);
    await sleep(120);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.equal(unhandled.length, 0, `unhandled: ${unhandled.map(String).join('; ')}`);
});

test('the preview deadline classifies budget, cancel and stale generation, and budget 0 never times out', async () => {
  const d1 = createPreviewDeadline({ budgetMs: 15 });
  assert.ok(d1.remainingMs() > 0);
  await sleep(30);
  assert.throws(() => d1.check(), (e) => e.code === 'PREVIEW_BUDGET_EXCEEDED');
  d1.dispose();

  const ac = new AbortController();
  const d2 = createPreviewDeadline({ budgetMs: 0, signal: ac.signal });
  assert.equal(d2.remainingMs(), Infinity);
  assert.equal(d2.check(), undefined);
  ac.abort();
  assert.throws(() => d2.check(), (e) => e.code === 'PREVIEW_CANCELLED');
  d2.dispose();

  let gen = 1;
  const d3 = createPreviewDeadline({ budgetMs: 0, generation: 1, isCurrent: () => gen === 1 });
  d3.check();
  gen = 2;
  assert.throws(() => d3.check(), (e) => e.code === 'PREVIEW_STALE_GENERATION');
  d3.dispose();
});

// --- F7: decide shouldPreview once --------------------------------------
function fourPathHarness() {
  const counts = { warm: 0, preview: 0, last: null };
  const tools = new Map();
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => {};
      },
    },
    get: () => undefined,
  };
  const manager = new CuSessionManager();
  manager.writeActivity = () => {};
  manager.warmCaptureDaemon = () => {
    counts.warm += 1;
  };
  manager.stopCaptureDaemon = () => {};
  manager.captureShotViaDaemon = async () => {
    counts.preview += 1;
    return { ok: true, base64: JPEG_B64, mimeType: 'image/jpeg', size: { width: 10, height: 10 }, scale: 1 };
  };
  manager.startVisualSession = async (opts) => {
    counts.last = opts;
    if (opts.warmCapture) manager.warmCaptureDaemon();
    manager.activeSession = { windowId: opts.windowId, pid: opts.pid ?? 42 };
    return { ok: true, session: manager.activeSession };
  };
  registerCuTools({
    ctx,
    manager,
    config: { autoSession: false, observeBudgetMs: 0, sessionPreviewBudgetMs: 1000 },
  });
  return { counts, call: (args) => tools.get('cu_session').execute({ action: 'start', ...args }, { signal: new AbortController().signal }) };
}

test('every default-preview path decides once: warm-up and capture never both run', async () => {
  const cases = [
    ['omitted + window', { windowId: 7 }, 0, 1],
    ['true + window', { windowId: 7, preview: true }, 0, 1],
    ['false + window', { windowId: 7, preview: false }, 1, 0],
    ['no window', {}, 1, 0],
  ];
  for (const [label, args, wantWarm, wantPreview] of cases) {
    const { counts, call } = fourPathHarness();
    const res = await call(args);
    assert.equal(res.ok, true, label);
    assert.equal(counts.warm, wantWarm, `${label}: warm-up count`);
    assert.equal(counts.preview, wantPreview, `${label}: preview captures`);
    assert.ok(!(counts.warm && counts.preview), `${label}: warm-up and preview must not both run`);
  }
});
