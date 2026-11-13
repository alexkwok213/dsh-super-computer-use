import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CuSessionManager } from '../lib/core.mjs';
import { registerCuTools } from '../lib/index.mjs';

function harness({ capture = true, matched = true, swatch = true, vision = true, attachment = true, region = true, widthMatched = true, externalImages = null, drawingTool = 'Monoline', shotWidth = 200, shotHeight = 200, roiHash = null, varyAfterFile = false, verifyAfterHash = null, preferDaemon = false } = {}) {
  const tools = new Map(), calls = [], feedback = [], daemonCalls = [];
  const ctx = { tools: { register(def) { tools.set(def.name, def); return () => {}; } }, get: key => key === 'llm' ? { resolveModelInfo: async () => ({ inputModalities: vision ? ['image'] : ['text'] }) } : key === 'attachments' ? { saveImage: async () => attachment ? ({ attachmentId: 'after', mediaType: 'image/png', bytes: 100, width: 20, height: 20 }) : null } : undefined };
  const manager = new CuSessionManager();
  manager.activeSession = { pid: 42, windowId: 7 };
  manager.writeActivity = () => {};
  manager.showActionLabel = (...args) => feedback.push(args);
  if (preferDaemon) {
    manager._preferDaemonForPaint = true;
    manager.captureShotToFile = async (opts) => {
      daemonCalls.push(opts);
      copyFileSync('assets/icon.png', opts.out);
      return { ok: true, out: opts.out, source: 'scstream', timestampNs: '500', origin: { x: 0, y: 0 }, size: { width: shotWidth, height: shotHeight }, scale: 1 };
    };
  }
  let shotCount = 0;
  manager.exec = async argv => {
    calls.push(argv);
    if (argv[0] === 'windows') return { ok: true, windows: [{ pid: 42, windowId: 7, app: 'Freeform', bounds: { x: 0, y: 0, width: shotWidth, height: shotHeight } }] };
    if (argv[0] === 'shot' && capture) {
      shotCount += 1;
      const out = argv[argv.indexOf('--out') + 1];
      copyFileSync('assets/icon.png', out);
      if (varyAfterFile && shotCount >= 2) writeFileSync(out, Buffer.concat([readFileSync(out), Buffer.from(`-${shotCount}`)]));
    }
    if (argv[0] === 'shot') return capture ? { ok: true, origin: { x: 0, y: 0 }, size: { width: shotWidth, height: shotHeight }, scale: 1 } : { ok: false, error: 'capture_failed' };
    if (argv[0] === 'snapshot') return { ok: true, nodes: [{ title: 'Choose a color', x: 10, y: 10, w: 20, h: 20 }, ...(drawingTool ? [{ title: 'Drawing tool', value: drawingTool, x: 40, y: 10, w: 20, h: 20 }] : [])] };
    if (argv[0] === 'paint-swatch') return { ok: true, matched: swatch };
    if (argv[0] === 'paint-canvas-hash' && roiHash) return { ok: true, hash: typeof roiHash === 'function' ? roiHash(argv) : roiHash };
    if (argv[0] === 'paint-verify') return { ok: true, matched, widthMatched, regionMatched: true, measuredWidth: widthMatched ? 2 : 12, failedStrokes: matched ? [] : [0], ...(verifyAfterHash ? { afterHash: verifyAfterHash } : {}) };
    if (argv[0] === 'strokes') return { ok: true, finishedNs: '123456', strokes: JSON.parse(readFileSync(argv[argv.indexOf('--file') + 1], 'utf8')).strokes.length };
    return { ok: true };
  };
  registerCuTools({ ctx, manager, config: { autoSession: false } });
  return { calls, daemonCalls, feedback, call: args => tools.get('cu_paint').execute({ ...(region ? { paintRegion: [[0, 0], [shotWidth, 0], [shotWidth, shotHeight], [0, shotHeight]], brushWidth: 2 } : {}), ...args }, { signal: new AbortController().signal, agent: { options: { provider: 'p', model: 'm' } }, ...(externalImages ? { externalImages } : {}) }) };
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
    assert.equal(result.artworkComplete, false);
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
    assert.equal(result.artworkComplete, false);
    assert.equal(result.requiresVisualReview, true);
    assert.equal(result.verification.semanticAccuracy, 'not_verified');
    assert.equal(result.image.attachmentId, 'after');
    assert.equal(result.nextOffset, 1);
    assert.equal(result.strokes, 1);
    assert.match(h.feedback[0][0], /#dc141e/);
    assert.match(h.feedback[0][0], /2pt/);
    assert.deepEqual(h.feedback[0].slice(1), [10, 10]);
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


test('region overflow is refused before native dispatch or capture', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paint-test-'));
  try {
    const file = join(dir, 'strokes.json');
    writeFileSync(file, JSON.stringify({ strokes: [[[20, 20], [80, 20]]] }));
    const h = harness();
    const result = await h.call({ pid: 42, windowId: 7, strokesFile: file,
      expectedHex: '#dc141e', authorizeForeground: true,
      paintRegion: [[10, 10], [50, 10], [50, 50], [10, 50]], brushWidth: 2 });
    assert.equal(result.error, 'stroke_outside_paint_region');
    assert.equal(h.calls.some(x => ['strokes', 'shot'].includes(x[0])), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing region cannot silently mean the whole window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paint-test-'));
  try {
    const file = join(dir, 'strokes.json');
    writeFileSync(file, JSON.stringify({ strokes: [[[20, 20], [80, 20]]] }));
    const h = harness({ region: false });
    const result = await h.call({ pid: 42, windowId: 7, strokesFile: file,
      expectedHex: '#dc141e', authorizeForeground: true });
    assert.equal(result.error, 'invalid_paint_region');
    assert.equal(h.calls.some(x => x[0] === 'strokes'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('wrong measured brush width prevents continuation even with matching color', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paint-test-'));
  try {
    const file = join(dir, 'strokes.json'); writeFileSync(file, JSON.stringify({ strokes: [[[10, 10], [20, 10]]] }));
    const h = harness({ widthMatched: false });
    const result = await h.call({ pid: 42, windowId: 7, strokesFile: file, expectedHex: '#dc141e', authorizeForeground: true });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'paint_not_verified');
    const check = h.calls.find(x => x[0] === 'paint-verify');
    assert.equal(check[check.indexOf('--expected-width') + 1], '2');
    assert.equal(result.nextOffset, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('external MCP delivers screenshot bytes without inventing a DSH model route', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paint-test-')), images = [];
  try {
    const file = join(dir, 'strokes.json'); writeFileSync(file, JSON.stringify({ strokes: [[[10, 10], [20, 10]]] }));
    const h = harness({ vision: false, attachment: false, externalImages: { supported: true, async save(data, mimeType) {
      images.push({ bytes: data.length, mimeType }); return { delivery: 'mcp_image', captureId: 'external-1' };
    } } });
    const result = await h.call({ pid: 42, windowId: 7, strokesFile: file, expectedHex: '#dc141e', authorizeForeground: true });
    assert.equal(result.ok, true);
    assert.equal(result.image.delivery, 'mcp_image');
    assert.equal(images.length, 1);
    assert.ok(images[0].bytes > 100);
    assert.equal(images[0].mimeType, 'image/png');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('continuation requires a review of the exact prior image and source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paint-test-'));
  try {
    const file = join(dir, 'strokes.json');
    writeFileSync(file, JSON.stringify({ strokes: [[[10, 10], [20, 10]], [[10, 20], [20, 20]]] }));
    const h = harness();
    const args = { pid: 42, windowId: 7, strokesFile: file, expectedHex: '#dc141e', authorizeForeground: true };
    const first = await h.call(args);
    assert.equal(first.ok, true);
    const count = h.calls.filter(x => x[0] === 'strokes').length;
    const unreviewed = await h.call({ ...args, offset: 1 });
    assert.equal(unreviewed.error, 'paint_review_required');
    assert.equal(h.calls.filter(x => x[0] === 'strokes').length, count);
    const next = await h.call({ ...args, offset: 1, reviewToken: first.reviewToken,
      review: 'The red line is inside the watermelon region with the intended width; continue the adjacent arc.' });
    assert.equal(next.ok, true);
    const replay = await h.call({ ...args, offset: 1, reviewToken: first.reviewToken, review: 'Same review' });
    assert.equal(replay.ok, false);
    assert.equal(h.calls.filter(x => x[0] === 'strokes').length, count + 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('failed input blocks even a new source until a fresh frame is reviewed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paint-test-'));
  try {
    const file = join(dir, 'strokes.json'); writeFileSync(file, JSON.stringify({ strokes: [[[10, 10], [20, 10]]] }));
    const h = harness({ widthMatched: false });
    const args = { pid: 42, windowId: 7, strokesFile: file, expectedHex: '#dc141e', authorizeForeground: true };
    assert.equal((await h.call(args)).error, 'paint_not_verified');
    const calls = h.calls.filter(x => x[0] === 'strokes').length;
    const recovery = await h.call(args);
    assert.equal(recovery.error, 'paint_recovery_review_required');
    assert.ok(recovery.reviewToken);
    assert.ok(recovery.image);
    assert.equal(h.calls.filter(x => x[0] === 'strokes').length, calls);
    const refused = await h.call(args);
    assert.equal(refused.error, 'paint_review_required');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('expired review is refreshed with an image without dispatching more input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paint-test-'));
  const now = Date.now;
  try {
    const file = join(dir, 'strokes.json'); writeFileSync(file, JSON.stringify({ strokes: [[[10, 10], [20, 10]], [[10, 20], [20, 20]]] }));
    const h = harness();
    const args = { pid: 42, windowId: 7, strokesFile: file, expectedHex: '#dc141e', authorizeForeground: true };
    const first = await h.call(args);
    const at = now(); Date.now = () => at + 300001;
    const expired = await h.call({ ...args, offset: 1, reviewToken: first.reviewToken, review: 'The prior stroke fits the intended region.' });
    assert.equal(expired.error, 'paint_review_expired');
    assert.ok(expired.image);
    assert.notEqual(expired.reviewToken, first.reviewToken);
    assert.equal(h.calls.filter(x => x[0] === 'strokes').length, 1);
    const next = await h.call({ ...args, offset: 1, reviewToken: expired.reviewToken, review: 'The fresh frame still shows the intended mark inside the region.' });
    assert.equal(next.ok, true);
  } finally { Date.now = now; rmSync(dir, { recursive: true, force: true }); }
});

test('count batches bounded stroke chunks and validates bounds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paint-test-'));
  try {
    const file = join(dir, 'strokes.json');
    writeFileSync(file, JSON.stringify({ strokes: [[[10, 10], [20, 10]], [[10, 20], [20, 20]], [[10, 30], [20, 30]], [[10, 40], [20, 40]]] }));
    const h = harness();
    const args = { pid: 42, windowId: 7, strokesFile: file, expectedHex: '#dc141e', authorizeForeground: true };
    assert.equal((await h.call({ ...args, count: 0 })).error, 'invalid_stroke_count');
    assert.equal((await h.call({ ...args, count: 11 })).error, 'invalid_stroke_count');
    const first = await h.call({ ...args, count: 3 });
    assert.equal(first.ok, true);
    assert.equal(first.strokes, 3);
    assert.equal(first.nextOffset, 3);
    assert.equal(first.totalStrokes, 4);
    const second = await h.call({ ...args, offset: 3, count: 3, reviewToken: first.reviewToken, review: 'The first 3 red strokes sit inside the upper region with expected thickness.' });
    assert.equal(second.ok, true);
    assert.equal(second.strokes, 1);
    assert.equal(second.nextOffset, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('expectedTool blocks wrong Freeform brush before dispatching native strokes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paint-test-'));
  try {
    const file = join(dir, 'strokes.json'); writeFileSync(file, JSON.stringify({ strokes: [[[10, 10], [20, 10]]] }));
    const h = harness({ drawingTool: 'Marker' });
    const result = await h.call({ pid: 42, windowId: 7, strokesFile: file, expectedHex: '#dc141e', expectedTool: 'Monoline', authorizeForeground: true });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'paint_tool_not_verified');
    assert.equal(result.expectedTool, 'Monoline');
    assert.equal(result.actualTool, 'Marker');
    assert.equal(h.calls.some(x => x[0] === 'strokes'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Freeform Fill tool forwards --fill to paint-verify and records fillMode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paint-test-'));
  try {
    const file = join(dir, 'strokes.json'); writeFileSync(file, JSON.stringify({ strokes: [[[10, 10], [40, 10], [40, 40], [10, 40], [10, 10]]] }));
    const h = harness({ drawingTool: 'Fill' });
    const result = await h.call({ pid: 42, windowId: 7, strokesFile: file, expectedHex: '#dc141e', expectedTool: 'Fill', authorizeForeground: true });
    assert.equal(result.ok, true);
    assert.equal(result.verification.fillMode, true);
    assert.equal(result.verification.method, 'interior_fill_and_boundary');
    const verifyCall = h.calls.find(x => x[0] === 'paint-verify');
    assert.ok(verifyCall?.includes('--fill'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('canvas interior ROI hash prevents chrome-only PNG diffs from triggering paint_canvas_changed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paint-test-'));
  try {
    const file = join(dir, 'strokes.json'); writeFileSync(file, JSON.stringify({ strokes: [[[20, 80], [60, 80]], [[20, 100], [60, 100]]] }));
    const h = harness({ shotWidth: 800, shotHeight: 600, roiHash: 'stable-interior-roi-hash', varyAfterFile: true });
    const args = { pid: 42, windowId: 7, strokesFile: file, expectedHex: '#dc141e', authorizeForeground: true };
    const first = await h.call(args);
    assert.equal(first.ok, true);
    const second = await h.call({ ...args, offset: 1, reviewToken: first.reviewToken, review: 'The first stroke inside the interior canvas is crisp and matches expected thickness.' });
    assert.equal(second.ok, true);
    assert.ok(h.calls.some(x => x[0] === 'paint-canvas-hash'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('aggregate verifyMode allows 64 strokes, forwards spacing/insets, reuses afterHash and prefers SCStream daemon capture', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paint-agg-test-'));
  try {
    const strokes = Array.from({ length: 25 }, (_, i) => [[20, 20 + i * 2], [60, 20 + i * 2]]);
    const planFile = join(dir, 'vec.plan.json');
    writeFileSync(planFile, JSON.stringify({
      version: 2,
      mode: 'vector',
      batches: [{ index: 0, role: 'ink', tool: 'Monoline', brushWidthName: 'Medium', brushWidth: 5, hex: '#212939', count: 25, strokes }],
    }));
    const h = harness({ shotWidth: 800, shotHeight: 600, roiHash: 'inline-after-hash', verifyAfterHash: 'inline-after-hash', preferDaemon: true });
    assert.equal((await h.call({ pid: 42, windowId: 7, planPath: planFile, layerIndex: 0, count: 65, verifyMode: 'aggregate', authorizeForeground: true })).error, 'invalid_stroke_count');
    assert.equal((await h.call({ pid: 42, windowId: 7, planPath: planFile, layerIndex: 0, count: 25, verifyMode: 'bogus', authorizeForeground: true })).error, 'invalid_verify_mode');

    const res = await h.call({
      pid: 42, windowId: 7, planPath: planFile, layerIndex: 0, count: 25,
      verifyMode: 'aggregate', spacing: 10, paceMs: 2, authorizeForeground: true,
    });
    assert.equal(res.ok, true);
    assert.equal(res.strokes, 25);
    assert.equal(res.verification.verifyMode, 'aggregate');
    assert.equal(res.captureSource.before, 'scstream');
    assert.equal(res.captureSource.after, 'scstream');
    assert.equal(h.daemonCalls.length, 2);
    assert.equal(h.daemonCalls[1].minTimestampNs, '123456');
    const strokesCall = h.calls.find(x => x[0] === 'strokes');
    assert.equal(strokesCall[strokesCall.indexOf('--spacing') + 1], '10');
    const verifyCall = h.calls.find(x => x[0] === 'paint-verify');
    assert.ok(verifyCall?.includes('--aggregate'));
    assert.ok(verifyCall?.includes('--inset-top'));
    assert.equal(h.calls.filter(x => x[0] === 'paint-canvas-hash').length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
