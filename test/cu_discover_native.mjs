// Native discovery used to be impossible: cu_discover was CDP-only, so the
// Freeform playbook existed in the repo but could never reach the model. These
// tests pin the AX-based native branch and prove it needs no Chrome at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CuSessionManager } from '../lib/core.mjs';
import { registerCuTools } from '../lib/index.mjs';

const WINDOWS = {
  ok: true,
  frontmost: { app: 'Freeform', pid: 63103 },
  windows: [
    {
      app: 'Freeform', title: 'Untitled', pid: 63103, windowId: 10429, frontmost: true,
      bounds: { x: 0, y: 33, width: 1204, height: 993 },
    },
  ],
};

const AX = {
  ok: true,
  count: 2,
  nodes: [
    { role: 'AXButton', title: 'Choose a color', value: 'black', x: 629, y: 978, w: 25, h: 25 },
    { role: 'AXButton', title: 'Choose a drawing tool', value: '', x: 605, y: 982, w: 16, h: 16 },
    { role: 'AXGroup', title: '', value: '', x: 0, y: 33, w: 1204, h: 993 },
  ],
};

function harness() {
  const tools = new Map();
  const calls = [];
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
  manager.exec = async (argv) => {
    calls.push(argv.slice());
    if (argv[0] === 'windows') return WINDOWS;
    if (argv[0] === 'ax') return AX;
    return { ok: true };
  };
  registerCuTools({ ctx, manager, config: { autoSession: false, observeBudgetMs: 0 } });
  const run = { signal: new AbortController().signal, agent: { options: { provider: 'p', model: 'm' } } };
  return { calls, call: (name, args) => tools.get(name).execute(args, run) };
}

test('native discovery by appName returns the Freeform playbook without Chrome', async () => {
  const h = harness();
  const r = await h.call('cu_discover', { appName: 'Freeform' });
  assert.equal(r.ok, true);
  assert.equal(r.channel, 'native');
  assert.equal(r.playbook.id, 'apple-freeform');
  assert.ok(r.playbook.pitfalls.length > 0);
  assert.ok(Array.isArray(r.next) && r.next.length > 0, 'flow names are returned');
  assert.ok(r.playbook.routes.some((x) => x.id === 'exactCopy'));
  assert.equal(h.calls.some((c) => /cdp|launch|chrome/i.test(c.join(' '))), false,
    'native branch must not touch CDP or launch a browser');
});

test('native discovery by pid/windowId enumerates AX controls too', async () => {
  const h = harness();
  const r = await h.call('cu_discover', { pid: 63103, windowId: 10429 });
  assert.equal(r.ok, true);
  assert.equal(r.channel, 'native');
  assert.equal(r.target.appName, 'Freeform');
  assert.equal(r.playbook.id, 'apple-freeform');
  assert.equal(r.counts.controls, 2, 'only named controls are listed');
  assert.deepEqual(r.controls.buttons.map((c) => c.title), ['Choose a color', 'Choose a drawing tool']);
  assert.ok(h.calls.some((c) => c[0] === 'windows'));
  assert.ok(h.calls.some((c) => c[0] === 'ax'));
});

test('an unknown native app is reported as unmatched, not silently guessed', async () => {
  const h = harness();
  const r = await h.call('cu_discover', { appName: 'SomeUnknownApp' });
  assert.equal(r.ok, true);
  assert.equal(r.channel, 'native');
  assert.equal(r.playbook.id, 'web-canvas-generic');
  assert.match(r.hint, /no verified playbook/);
});
