import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCuTools } from '../lib/index.mjs';
import { CuSessionManager } from '../lib/core.mjs';
import { buildCommandArgv } from '../lib/core.mjs';

test('snapshot argv bounds the settle loop and honours an explicit override', () => {
  const m = new CuSessionManager();
  const def = buildCommandArgv('snapshot', { pid: 7, windowId: 9 }, m);
  assert.ok(def.includes('--max-settle-walks'));
  const i = def.indexOf('--max-settle-walks');
  // Hot-path default does a single walk; the plugin's change-driven observe
  // re-reads when the tree actually changes, so extra settle walks only add
  // latency (measured identical node counts at 0 vs 2 extra walks on Finder).
  assert.equal(def[i + 1], '0');
  const over = buildCommandArgv('snapshot', { pid: 7, settle: 0, maxSettleWalks: 3 }, m);
  assert.equal(over[over.indexOf('--settle') + 1], '0');
  assert.equal(over[over.indexOf('--max-settle-walks') + 1], '3');
});

test('agent cursor helpers emit JSON-line commands for the overlay', () => {
  const manager = new CuSessionManager();
  const received = [];
  manager._cursorWrite = (obj) => received.push(obj);
  manager.showAgentCursor(120, 240);
  manager.showClickRipple(120, 240);
  manager.setAgentAura(false);
  assert.deepEqual(received, [
    { cmd: 'cursor', x: 120, y: 240, glide: true },
    { cmd: 'click', x: 120, y: 240 },
    { cmd: 'aura', visible: false },
  ]);
});

for (const failure of ['throw', 'response']) {
  test(`successful key survives optional snapshot ${failure}`, async () => {
    const tools = new Map();
    const calls = [];
    registerCuTools({
      ctx: { tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } } },
      defineTool: (tool) => tool,
      manager: {
        assertCanAct() {}, writeActivity() {},
        async exec(argv) {
          calls.push(argv[0]);
          if (argv[0] === 'key') return { ok: true, delivered: true };
          if (failure === 'throw') throw new Error('snapshot connection interrupted');
          return { ok: false, error: 'snapshot_unavailable' };
        },
      },
    });
    const result = await tools.get('cu_key').execute({ pid: 42, name: 'return' }, {});
    assert.equal(result.ok, true);
    assert.equal(result.delivered, true);
    assert.equal(result.observation.ok, false);
    assert.equal(result.observation.error, 'post_action_observation_failed');
    assert.deepEqual(calls, ['key', 'snapshot']);
  });
}

for (const mode of ['preview-error', 'cancel-after-action', 'action-error']) {
  test(`${mode} preserves delivery semantics without replay`, async () => {
    const tools = new Map();
    const calls = [];
    const controller = new AbortController();
    registerCuTools({
      ctx: { tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } } },
      defineTool: (tool) => tool,
      manager: {
        assertCanAct() {}, writeActivity() {},
        async exec(argv) {
          calls.push(argv[0]);
          if (argv[0] === 'key') {
            if (mode === 'cancel-after-action') controller.abort();
            return mode === 'action-error' ? { ok: false, error: 'key_failed' } : { ok: true };
          }
          throw new Error('capture connection interrupted');
        },
      },
    });
    const result = await tools.get('cu_key').execute(
      { pid: 42, windowId: 12, name: 'return', observe: false, preview: true },
      { signal: controller.signal }
    );
    if (mode === 'action-error') {
      assert.equal(result.ok, false);
      assert.equal(result.error, 'key_failed');
      assert.equal(result.preview, undefined);
    } else {
      assert.equal(result.ok, true);
      assert.equal(result.preview.error, 'post_action_preview_failed');
      assert.equal(result.preview.actionReplaySafe, false);
    }
    assert.deepEqual(calls, mode === 'preview-error' ? ['key', 'shot'] : ['key']);
  });
}

test('post-action observation and preview start concurrently', async () => {
  const tools = new Map();
  const events = [];
  let releaseSnapshot;
  const snapshotGate = new Promise((r) => { releaseSnapshot = r; });
  registerCuTools({
    ctx: { tools: { register(t) { tools.set(t.name, t); return () => {}; } } },
    defineTool: (tool) => tool,
    manager: {
      assertCanAct() {}, writeActivity() {},
      async exec(argv) {
        if (argv[0] === 'key') return { ok: true };
        events.push('snapshot:start');
        await snapshotGate;
        events.push('snapshot:end');
        return { ok: true, pid: 42, count: 0, nodes: [] };
      },
      recordSnapshot() { return { ok: true }; },
      async captureShotViaDaemon() {
        events.push('preview:start');
        return { ok: true, base64: Buffer.from('x').toString('base64'), mimeType: 'image/jpeg',
                 width: 10, height: 10, size: { width: 10, height: 10 }, scale: 1, origin: { x: 0, y: 0 } };
      },
    },
    config: {},
  });
  const promise = tools.get('cu_key').execute(
    { pid: 42, windowId: 7, name: 'return', preview: true },
    { signal: new AbortController().signal }
  );
  // Give the tool a tick to dispatch both; the preview must already be started
  // even though the snapshot is still blocked.
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(events.includes('preview:start'),
    `preview should start while snapshot is in flight, saw: ${events.join(',')}`);
  releaseSnapshot();
  const result = await promise;
  assert.equal(result.ok, true);
});

test('click emits cursor, label and ripple commands', () => {
  const manager = new CuSessionManager();
  const received = [];
  manager._cursorWrite = (obj) => received.push(obj);
  manager.activeSession = { windowId: 7 };
  manager.showAgentCursor(10, 20);
  manager.showActionLabel('点击 e12', 10, 20);
  manager.showClickRipple(10, 20);
  assert.deepEqual(received.map((r) => r.cmd), ['cursor', 'label', 'click']);
  assert.equal(received[1].text, '点击 e12');
});

test('post-action observe skips per-node action lists (delta unaffected)', () => {
  const m = new CuSessionManager();
  const argv = buildCommandArgv('snapshot', { pid: 7, windowId: 9, noActions: true }, m);
  assert.ok(argv.includes('--no-actions'), argv.join(' '));
  // Explicit cu_snapshot keeps actions by default.
  const explicit = buildCommandArgv('snapshot', { pid: 7 }, m);
  assert.ok(!explicit.includes('--no-actions'), explicit.join(' '));
});

test('a truncated snapshot is reported to the caller', () => {
  const m = new CuSessionManager();
  const out = m.recordSnapshot(1, 2, {
    ok: true, pid: 1, app: 'Big', count: 2, truncated: true, limit: 800,
    nodes: [{ ref: 'e1', role: 'AXButton', title: 'A' }],
  }, { full: true });
  assert.equal(out.truncated, true);
  assert.equal(out.limit, 800);
});

test('snapshot maxNodes passes through and is clamped', () => {
  const m = new CuSessionManager();
  const a = buildCommandArgv('snapshot', { pid: 1, maxNodes: 1500 }, m);
  assert.equal(a[a.indexOf('--max-nodes') + 1], '1500');
  const b = buildCommandArgv('snapshot', { pid: 1, maxNodes: 99999 }, m);
  assert.equal(b[b.indexOf('--max-nodes') + 1], '3000');
  const c = buildCommandArgv('snapshot', { pid: 1 }, m);
  assert.ok(!c.includes('--max-nodes'));
});
