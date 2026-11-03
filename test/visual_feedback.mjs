// The overlay used to be wired only to the coordinate path: a ref click, and
// every click inside a batch, reached the engine but never the screen. These
// tests drive the real tools against a stub engine so the connection itself is
// covered, not just the visual helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CuSessionManager } from '../lib/core.mjs';
import { registerCuTools } from '../lib/index.mjs';

const SNAPSHOT = {
  ok: true,
  pid: 42,
  app: 'Probe',
  count: 1,
  nodes: [{ ref: 'k0.3.2', role: 'AXButton', title: '导入', x: 300, y: 400, w: 80, h: 24 }],
};

function harness(exec) {
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
  const visual = [];
  manager._cursorWrite = (command) => {
    visual.push(command);
    return true;
  };
  manager.activeSession = { windowId: 7, pid: 42 };
  manager.writeActivity = () => {};
  manager.exec = exec;
  registerCuTools({ ctx, manager, config: { autoSession: false } });
  const run = { signal: new AbortController().signal, agent: { options: { provider: 'p', model: 'm' } } };
  return {
    manager,
    visual,
    call: (name, args) => tools.get(name).execute(args, run),
    commands: () => visual.map((entry) => entry.cmd),
  };
}

test('a ref click ripples at the frame the engine resolved, and names the control', async () => {
  const { call, visual, commands } = harness(async (argv) => {
    if (argv[0] === 'snapshot') return SNAPSHOT;
    if (argv[0] === 'click') return { ok: true, action: 'click', x: 340, y: 412, via: 'AXPress-background' };
    return { ok: true };
  });
  await call('cu_snapshot', { pid: 42, windowId: 7 });
  visual.length = 0;

  const result = await call('cu_click', { pid: 42, windowId: 7, ref: 'k0.3.2', observe: false });

  assert.equal(result.ok, true);
  assert.deepEqual(commands(), ['cursor', 'cursor', 'label', 'click']);
  const ripple = visual.find((entry) => entry.cmd === 'click');
  // Engine point wins over the snapshot frame: that is where the click landed.
  assert.equal(ripple.x, 340);
  assert.equal(ripple.y, 412);
  assert.equal(visual.find((entry) => entry.cmd === 'label').text, '点击「导入」');
});

test('a coordinate click keeps working without any snapshot', async () => {
  const { call, visual } = harness(async (argv) =>
    argv[0] === 'click' ? { ok: true, action: 'click', x: 340, y: 412 } : { ok: true }
  );
  const result = await call('cu_click', { pid: 42, windowId: 7, x: 340, y: 412, observe: false });
  assert.equal(result.ok, true);
  const ripple = visual.find((entry) => entry.cmd === 'click');
  assert.deepEqual([ripple.x, ripple.y], [340, 412]);
  assert.equal(visual.find((entry) => entry.cmd === 'label').text, '点击 340,412');
});

test('a click the engine refuses never shows a ripple or a success chip', async () => {
  const { call, visual, commands } = harness(async (argv) =>
    argv[0] === 'click'
      ? { ok: false, error: 'control_disabled', message: 'k0.3.2 is disabled' }
      : { ok: true }
  );
  const result = await call('cu_click', { pid: 42, windowId: 7, x: 340, y: 412, observe: false });

  assert.equal(result.ok, false);
  assert.ok(!commands().includes('click'), `no ripple on failure: ${JSON.stringify(visual)}`);
  // The chip that remains is the explicit clear, not a success label.
  const labels = visual.filter((entry) => entry.cmd === 'label');
  assert.equal(labels.at(-1).text, '');
});

test('a batch click is not silent: one ripple per successful step', async () => {
  const { call, visual } = harness(async (argv) => {
    if (argv[0] !== 'click') return { ok: true };
    const flag = (name, fallback) => {
      const index = argv.indexOf(name);
      return index >= 0 ? Number(argv[index + 1]) : fallback;
    };
    return { ok: true, action: 'click', x: flag('--x', 340), y: flag('--y', 412) };
  });

  const result = await call('cu_batch', {
    pid: 42,
    windowId: 7,
    steps: [{ action: 'click', ref: 'k0.3.2' }, { action: 'click', x: 10, y: 20 }],
    observe: false,
    preview: false,
  });

  assert.equal(result.ok, true);
  const ripples = visual.filter((entry) => entry.cmd === 'click');
  assert.equal(ripples.length, 2, JSON.stringify(visual));
  assert.deepEqual([ripples[0].x, ripples[0].y], [340, 412]);
  assert.deepEqual([ripples[1].x, ripples[1].y], [10, 20]);
});

test('a failing batch step is reported on the overlay, not as a click', async () => {
  const { call, visual } = harness(async (argv) => {
    if (argv[0] !== 'click') return { ok: true };
    const index = argv.indexOf('--x');
    const x = index >= 0 ? Number(argv[index + 1]) : 340;
    return x === 10 ? { ok: false, error: 'window_gone' } : { ok: true, action: 'click', x, y: 20 };
  });

  const result = await call('cu_batch', {
    pid: 42,
    windowId: 7,
    steps: [{ action: 'click', x: 340, y: 20 }, { action: 'click', x: 10, y: 20 }],
    observe: false,
    preview: false,
  });

  assert.equal(result.ok, false);
  const ripples = visual.filter((entry) => entry.cmd === 'click');
  assert.equal(ripples.length, 1, `only the successful step ripples: ${JSON.stringify(visual)}`);
  assert.equal(visual.at(-1).cmd, 'label');
  assert.equal(visual.at(-1).text, '');
});

test('no active session means no overlay traffic at all', async () => {
  const { call, manager, visual } = harness(async (argv) =>
    argv[0] === 'click' ? { ok: true, action: 'click', x: 1, y: 2 } : { ok: true }
  );
  manager.activeSession = null;
  await call('cu_click', { pid: 42, windowId: 7, x: 1, y: 2, observe: false });
  await call('cu_batch', {
    pid: 42,
    windowId: 7,
    steps: [{ action: 'click', x: 1, y: 2 }],
    observe: false,
    preview: false,
  });
  assert.equal(visual.length, 0);
});

test('batch clicks keep their own labels instead of one repeated ref', async () => {
  const { call, visual } = harness(async (argv) => {
    if (argv[0] === 'snapshot') return SNAPSHOT;
    if (argv[0] !== 'click') return { ok: true };
    return { ok: true, action: 'click', x: 340, y: 412 };
  });
  await call('cu_snapshot', { pid: 42, windowId: 7 });
  visual.length = 0;
  await call('cu_batch', {
    pid: 42,
    windowId: 7,
    steps: [{ action: 'click', ref: 'k0.3.2' }],
    observe: false,
    preview: false,
  });
  const label = visual.find((entry) => entry.cmd === 'label' && entry.text !== '');
  assert.equal(label.text, '点击「导入」');
});
