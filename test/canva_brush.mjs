// canva-brush: deterministic control of the Canva whiteboard brush over CDP.
// The module talks to the page's own DOM (aria-labelled buttons and native
// range/text inputs), so these tests use a tiny fake CDP client that answers
// Runtime.evaluate with canned values — no browser required.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../lib/canva-brush.mjs');

test('canva-brush exports the documented control surface', () => {
  for (const name of ['armBrush', 'isBrushArmed', 'setBrushStyle', 'setBrushColor', 'clearCanvas', 'closePopovers', 'readBrushSettings']) {
    assert.equal(typeof mod[name], 'function', `${name} is exported`);
  }
});

test('setBrushColor rejects a malformed hex before touching the page', async () => {
  const calls = [];
  const client = { send: async (method, params) => { calls.push({ method, params }); return { result: { value: 'null' } }; } };
  await assert.rejects(() => mod.setBrushColor(client, 'blue'), /hex must be/);
  assert.equal(calls.length, 0, 'no page calls for an invalid hex');
});

test('isBrushArmed reads the rail button background', async () => {
  const client = { send: async () => ({ result: { value: 'rgba(57, 70, 96, 0.14)' } }) };
  assert.equal(await mod.isBrushArmed(client), true);
  const idle = { send: async () => ({ result: { value: 'rgba(15, 16, 21, 0)' } }) };
  assert.equal(await mod.isBrushArmed(idle), false);
});

test('setBrushStyle drives only the two settings sliders', async () => {
  let evalCount = 0;
  const client = {
    send: async (method, params) => {
      evalCount += 1;
      if (params.expression.includes('rs.length>=2')) return { result: { value: 'true' } };
      if (params.expression.includes('fire(rs[0]')) return { result: { value: '["10","100"]' } };
      return { result: { value: 'ok' } };
    },
  };
  const applied = await mod.setBrushStyle(client, { thickness: 10, opacity: 100 });
  assert.deepEqual(applied, ["10", "100"]);
  assert.ok(evalCount >= 2);
});
