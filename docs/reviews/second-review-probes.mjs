// Review probes against the current adapter. No real app or service is touched.
// These reproduce gaps; passing assertions below do NOT mean the gaps are fixed.
// Run: node docs/reviews/second-review-probes.mjs
import assert from 'node:assert/strict';
import { CuSessionManager } from '../../lib/core.mjs';
import { registerCuTools } from '../../lib/index.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const shot = {
  ok: true, base64: Buffer.from([255, 216, 255, 224, 0, 16]).toString('base64'),
  mimeType: 'image/jpeg', size: { width: 10, height: 10 }, scale: 1,
  origin: { x: 0, y: 0 },
};
const findings = [];

function harness(config = {}, services = {}) {
  const definitions = new Map();
  const manager = new CuSessionManager();
  manager.assertCanAct = () => {};
  manager.writeActivity = () => {};
  manager._cursorWrite = () => false;
  manager.exec = async () => ({ ok: true });
  manager.captureShotViaDaemon = async () => shot;
  manager.stopCaptureDaemon = () => {};
  registerCuTools({
    ctx: {
      tools: { register(def) { definitions.set(def.name, def); return () => {}; } },
      get: name => services[name],
    },
    manager,
    config: { autoSession: false, observeBudgetMs: 0, ...config },
    defineTool: def => def,
  });
  const run = {
    signal: new AbortController().signal,
    agent: { options: { provider: 'review-mock', model: 'review-mock' } },
  };
  return { manager, definitions, call: (name, args) => definitions.get(name).execute(args, run) };
}

// Fast pixels plus slow host attachment handling exceed the preview deadline.
{
  const h = harness({ previewBudgetMs: 20 }, {
    llm: { resolveModelInfo: async () => ({ inputModalities: ['image'] }) },
    attachments: {
      saveImage: async ({ data, mediaType }) => {
        await delay(130);
        return { attachmentId: 'review-only', mediaType, bytes: data.length, width: 10, height: 10 };
      },
    },
  });
  const at = performance.now();
  const result = await h.call('cu_key', { pid: 42, windowId: 7, name: 'tab', observe: false, preview: true });
  const elapsedMs = Math.round(performance.now() - at);
  assert.equal(result.preview.ok, true);
  assert.ok(elapsedMs >= 120);
  findings.push({ case: 'attachment_outside_preview_budget', budgetMs: 20, elapsedMs, previewOk: true });
}

// Killing a timed-out daemon settles its promise. The abandoned capture then
// falls back into the same serial execution queue used by the next action.
{
  const h = harness({ previewBudgetMs: 20 });
  const trace = [];
  let finishDaemon;
  h.manager.captureShotViaDaemon = () => new Promise(resolve => { finishDaemon = resolve; });
  h.manager.stopCaptureDaemon = () => finishDaemon?.({ ok: false, error: 'daemon_exited' });
  let queue = Promise.resolve();
  h.manager.exec = argv => {
    const pending = queue.then(async () => {
      trace.push(argv[0]);
      if (argv[0] === 'shot') { await delay(130); return shot; }
      return { ok: true };
    });
    queue = pending.catch(() => {});
    return pending;
  };
  const first = await h.call('cu_key', { pid: 42, windowId: 7, name: 'tab', observe: false, preview: true });
  assert.equal(first.preview.error, 'preview_budget_exceeded');
  const at = performance.now();
  await h.call('cu_key', { pid: 42, windowId: 7, name: 'tab', observe: false });
  const nextActionMs = Math.round(performance.now() - at);
  assert.deepEqual(trace, ['key', 'shot', 'key']);
  assert.ok(nextActionMs >= 100);
  findings.push({ case: 'expired_preview_blocks_next_action', trace, nextActionMs });
}

// Supplying a new process alone inherits an unrelated window from the session.
{
  const h = harness();
  h.manager.activeSession = { pid: 42, windowId: 7 };
  let dispatched;
  h.manager.exec = async argv => { dispatched = argv; return { ok: true, x: 5, y: 6 }; };
  await h.call('cu_click', { pid: 99, x: 5, y: 6, observe: false });
  assert.equal(dispatched[dispatched.indexOf('--pid') + 1], '99');
  assert.equal(dispatched[dispatched.indexOf('--window') + 1], '7');
  findings.push({ case: 'mixed_session_target', session: { pid: 42, windowId: 7 }, dispatched });
}

// The snapshot token checks client cache history, not changes in the live app.
{
  const h = harness();
  const snap = h.manager.recordSnapshot(42, 7, {
    nodes: [{ ref: 'k0.0', role: 'AXButton', title: 'Open', x: 10, y: 10, w: 80, h: 30 }],
  });
  let liveIdentity = 'A';
  h.manager.exec = async () => ({ ok: true, clickedIdentity: liveIdentity });
  liveIdentity = 'B'; // external reordering; no new observation has been requested
  const result = await h.call('cu_click', {
    pid: 42, windowId: 7, ref: 'k0.0', snapshotId: snap.snapshotId, observe: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.clickedIdentity, 'B');
  findings.push({ case: 'external_reorder_not_invalidated_in_adapter', snapshotId: snap.snapshotId, dispatched: true });
}

// Default preview=true still requests warm-up because only explicit true skips it.
{
  const h = harness();
  let options;
  h.manager.startVisualSession = async opts => { options = opts; return { ok: true }; };
  const result = await h.call('cu_session', { action: 'start', pid: 42, windowId: 7 });
  assert.equal(options.warmCapture, true);
  assert.equal(result.preview.ok, true);
  findings.push({ case: 'default_session_double_capture', warmCapture: true, previewAlsoCaptured: true });
}

// Runtime fallback is unreachable through a host that enforces required params.
{
  const h = harness();
  const names = ['cu_snapshot', 'cu_expect'].filter(name => h.definitions.get(name).parameters.pid.required === true);
  assert.deepEqual(names, ['cu_snapshot', 'cu_expect']);
  findings.push({ case: 'session_pid_fallback_conflicts_with_schema', requiredPidTools: names });
}

console.log(JSON.stringify({ simulatedOnly: true, findings }, null, 2));
