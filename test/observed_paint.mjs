import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CuSessionManager } from '../lib/core.mjs';
import { registerCuTools } from '../lib/index.mjs';

function harness({ capture = true, matched = true, swatch = true, vision = true, attachment = true } = {}) {
  const tools = new Map(), calls = [];
  const ctx = { tools: { register(def) { tools.set(def.name, def); return () => {}; } }, get: key => key === 'llm' ? { resolveModelInfo: async () => ({ inputModalities: vision ? ['image'] : ['text'] }) } : key === 'attachments' ? { saveImage: async () => attachment ? ({ attachmentId: 'after', mediaType: 'image/png', bytes: 100, width: 20, height: 20 }) : null } : undefined };
  const manager = new CuSessionManager();
  manager.activeSession = { pid: 42, windowId: 7 };
  manager.writeActivity = () => {};
  manager.exec = async argv => {
    calls.push(argv);
    if (argv[0] === 'windows') return { ok: true, windows: [{ pid: 42, windowId: 7, app: 'Freeform', bounds: { x: 0, y: 0, width: 200, height: 200 } }] };
    if (argv[0] === 'shot' && capture) copyFileSync('assets/icon.png', argv[argv.indexOf('--out') + 1]);
    if (argv[0] === 'shot') return capture ? { ok: true, origin: { x: 0, y: 0 }, size: { width: 200, height: 200 }, scale: 1 } : { ok: false, error: 'capture_failed' };
    if (argv[0] === 'snapshot') return { ok: true, nodes: [{ title: 'Choose a color', x: 10, y: 10, w: 20, h: 20 }] };
    if (argv[0] === 'paint-swatch') return { ok: true, matched: swatch };
    if (argv[0] === 'paint-verify') return { ok: true, matched, failedStrokes: matched ? [] : [0] };
    if (argv[0] === 'strokes') return { ok: true, strokes: JSON.parse(readFileSync(argv[argv.indexOf('--file') + 1], 'utf8')).strokes.length };
    return { ok: true };
  };
  registerCuTools({ ctx, manager, config: { autoSession: false } });
  return { calls, call: args => tools.get('cu_paint').execute(args, { signal: new AbortController().signal, agent: { options: { provider: 'p', model: 'm' } } }) };
}

test('painting stops before input if before-capture fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paint-test-'));
  try {
    const file = join(dir, 'strokes.json'); writeFileSync(file, JSON.stringify({ strokes: [[[10, 10], [20, 10]]] }));
    const h = harness({ capture: false });
    const result = await h.call({ pid: 42, windowId: 7, strokesFile: file, expectedHex: '#dc141e', authorizeForeground: true });
    assert.equal(result.ok, false);
    assert.equal(h.calls.some(x => x[0] === 'strokes'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('painting bounds the chunk and fails closed on wrong or missing color', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paint-test-'));
  try {
    const file = join(dir, 'strokes.json'); writeFileSync(file, JSON.stringify({ strokes: Array.from({ length: 15 }, (_, i) => [[10, i + 10], [20, i + 10]]) }));
    const h = harness({ matched: false });
    const result = await h.call({ pid: 42, windowId: 7, strokesFile: file, expectedHex: '#dc141e', authorizeForeground: true });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'paint_not_verified');
    assert.equal(h.calls.filter(x => x[0] === 'strokes').length, 1);
    assert.equal(h.calls.filter(x => x[0] === 'paint-verify').length, 1);
    assert.equal(result.nextOffset, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a verified chunk returns a continuation index, not a whole layer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paint-test-'));
  try {
    const file = join(dir, 'strokes.json'); writeFileSync(file, JSON.stringify({ strokes: Array.from({ length: 15 }, (_, i) => [[10, i + 10], [20, i + 10]]) }));
    const h = harness();
    const result = await h.call({ pid: 42, windowId: 7, strokesFile: file, expectedHex: '#dc141e', authorizeForeground: true });
    assert.equal(result.ok, true);
    assert.equal(result.verification.matched, true);
    assert.equal(result.image.attachmentId, 'after');
    assert.equal(result.nextOffset, 1);
    assert.equal(result.strokes, 1);
    const dispatched = h.calls.find(x => x[0] === 'strokes');
    assert.equal(dispatched[dispatched.indexOf('--expected-window') + 1], '0,0,200,200');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('Freeform refuses before drawing when the selected swatch does not match', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paint-test-'));
  try {
    const file = join(dir, 'strokes.json'); writeFileSync(file, JSON.stringify({ strokes: [[[10, 10], [20, 10]]] }));
    const h = harness({ swatch: false });
    const result = await h.call({ pid: 42, windowId: 7, strokesFile: file, expectedHex: '#dc141e', authorizeForeground: true });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'paint_color_not_verified');
    assert.equal(h.calls.some(x => x[0] === 'strokes'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('a model without image input must not draw blind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paint-test-'));
  try {
    const file = join(dir, 'strokes.json'); writeFileSync(file, JSON.stringify({ strokes: [[[10, 10], [20, 10]]] }));
    const h = harness({ vision: false });
    const result = await h.call({ pid: 42, windowId: 7, strokesFile: file, expectedHex: '#dc141e', authorizeForeground: true });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'paint_vision_unavailable');
    assert.equal(h.calls.some(x => x[0] === 'strokes'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('a failed image attachment after drawing prevents continuation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paint-test-'));
  try {
    const file = join(dir, 'strokes.json'); writeFileSync(file, JSON.stringify({ strokes: [[[10, 10], [20, 10]], [[10, 20], [20, 20]]] }));
    const h = harness({ attachment: false });
    const result = await h.call({ pid: 42, windowId: 7, strokesFile: file, expectedHex: '#dc141e', authorizeForeground: true });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'paint_vision_unavailable');
    assert.equal(result.actionReplaySafe, false);
    assert.equal(result.nextOffset, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a plan layer must match its explicit index, not its array position', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paint-test-'));
  try {
    const file = join(dir, 'plan.json');
    writeFileSync(file, JSON.stringify({ x0: 0, y0: 0, sx: 1, sy: 1, layers: [{ index: 5, hex: '#000000', runs: [[10, 10, 20]] }] }));
    const h = harness();
    const result = await h.call({ pid: 42, windowId: 7, planPath: file, layerIndex: 0, authorizeForeground: true });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'invalid_paint_source');
    assert.equal(h.calls.some(x => x[0] === 'strokes'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
