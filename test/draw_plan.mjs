// Drawing pipeline: drawplan turns an image into a laid-out stroke plan, and
// cu_paint streams one layer without a per-stroke round trip. These tests stay
// headless: drawplan only reads a file, and the stroke path is exercised with
// --dry-run so no synthetic mouse events reach the desktop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CuSessionManager } from '../lib/core.mjs';
import { registerCuTools } from '../lib/index.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const CU = process.env.CU_BIN || join(ROOT, 'bin', 'cu');
const IMAGE = join(ROOT, 'assets', 'icon.png');

function run(args) {
  const stdout = execFileSync(CU, args, { encoding: 'utf8' });
  return JSON.parse(stdout.trim().split('\n').pop());
}

function luminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

test('drawplan emits a complete, ordered layer plan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cu-drawplan-'));
  try {
    const planPath = join(dir, 'plan.json');
    const previewPath = join(dir, 'preview.png');
    const summary = run([
      'drawplan', '--image', IMAGE, '--rect', '10,20,300,300',
      '--grid', '48', '--colors', '6', '--out', planPath, '--preview', previewPath,
    ]);
    assert.equal(summary.ok, true);
    assert.equal(summary.action, 'drawplan');
    assert.equal(summary.layers.length, 6);
    assert.ok(summary.totalRuns > 50);
    assert.ok(existsSync(planPath), 'plan file written');
    assert.ok(existsSync(previewPath), 'preview written');

    const png = readFileSync(previewPath);
    assert.equal(png.toString('ascii', 1, 4), 'PNG');
    assert.equal(png.readUInt32BE(16), 48);
    assert.equal(png.readUInt32BE(20), 48);

    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    assert.equal(plan.x0, 10);
    assert.equal(plan.y0, 20);
    assert.ok(Math.abs(plan.sx - 300 / 48) < 1e-9);
    assert.equal(plan.layers.length, 6);
    let runs = 0;
    for (const layer of plan.layers) {
      runs += layer.runs.length;
      for (const [i0, j, i1] of layer.runs) {
        assert.ok(i0 >= 0 && i1 >= i0 && i1 < 48 && j >= 0 && j < 48);
      }
    }
    assert.equal(runs, summary.totalRuns);
    for (let i = 1; i < plan.layers.length; i += 1) {
      assert.ok(luminance(plan.layers[i - 1].hex) >= luminance(plan.layers[i].hex),
        'layers go light -> dark');
    }

    const first = plan.layers[0];
    const dry = run(['strokes', '--plan', planPath, '--layer', String(first.index), '--dry-run']);
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.strokes, first.runs.length);
    assert.equal(dry.points, first.runs.length * 2);
    assert.equal(dry.hex, first.hex);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drawplan refuses unreadable input and impossible palettes', () => {
  assert.throws(() => run(['drawplan', '--image', '/nope/missing.png', '--rect', '0,0,100,100']));
  assert.throws(() => run(['drawplan', '--image', IMAGE, '--rect', '0,0,100,100', '--colors', '99']));
  assert.throws(() => run(['drawplan', '--image', IMAGE, '--rect', '0,0,1,1']));
});

function harness() {
  const tools = new Map();
  const ctx = {
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    get: () => undefined,
  };
  const manager = new CuSessionManager();
  manager._cursorWrite = () => true;
  manager.writeActivity = () => {};
  manager.activeSession = { windowId: 7, pid: 42 };
  const calls = [];
  manager.exec = async (argv) => {
    calls.push(argv);
    if (argv[0] === 'windows') {
      return { ok: true, windows: [{ windowId: 7, pid: 42, app: 'Probe', bounds: { x: 0, y: 0, width: 1200, height: 900 } }] };
    }
    if (argv[0] === 'drawplan') {
      return { ok: true, action: 'drawplan', layers: [], totalRuns: 0, out: '/tmp/x.plan.json', preview: '' };
    }
    return { ok: true, action: argv[0] };
  };
  registerCuTools({ ctx, manager, config: { autoSession: false, observeBudgetMs: 0 } });
  const runCtx = { signal: new AbortController().signal };
  return { manager, calls, tools, call: (name, args) => tools.get(name).execute(args, runCtx) };
}

test('cu_paint_plan validates paths and forwards geometry', async () => {
  const { call, calls } = harness();
  const relative = await call('cu_paint_plan', { imagePath: 'relative.png', x: 0, y: 0, width: 100, height: 100 });
  assert.equal(relative.ok, false);
  assert.equal(relative.error, 'image_path_must_be_absolute');

  const missing = await call('cu_paint_plan', { imagePath: '/nope/missing.png', x: 0, y: 0, width: 100, height: 100 });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'image_missing');

  const badRect = await call('cu_paint_plan', { imagePath: IMAGE, x: 0, y: 0, width: 10, height: 10 });
  assert.equal(badRect.ok, false);
  assert.equal(badRect.error, 'invalid_rect');

  const ok = await call('cu_paint_plan', {
    imagePath: IMAGE, x: 100, y: 120, width: 400, height: 400, pid: 42, windowId: 7,
  });
  assert.equal(ok.ok, true);
  const forwarded = calls.find((argv) => argv[0] === 'drawplan');
  assert.ok(forwarded);
  assert.equal(forwarded[forwarded.indexOf('--rect') + 1], '100,120,400,400');
});

test('cu_paint refuses to dispatch without a target or source', async () => {
  const { call, calls, manager } = harness();
  manager.activeSession = null;
  const noTarget = await call('cu_paint', { planPath: '/tmp/x.plan.json', layerIndex: 0 });
  assert.equal(noTarget.ok, false);
  assert.equal(noTarget.error, 'invalid_target');
  manager.activeSession = { windowId: 7, pid: 42 };

  const noSource = await call('cu_paint', { pid: 42, windowId: 7 });
  assert.equal(noSource.ok, false);
  assert.equal(noSource.error, 'missing_source');

  const noLayer = await call('cu_paint', { pid: 42, windowId: 7, planPath: '/tmp/x.plan.json' });
  assert.equal(noLayer.ok, false);
  assert.equal(noLayer.error, 'missing_layer');

  const fg = await call('cu_paint', { pid: 42, windowId: 7, planPath: '/tmp/x.plan.json', layerIndex: 2, foreground: true });
  assert.equal(fg.ok, false);
  assert.equal(fg.error, 'foreground_requires_authorization');

  const dispatched = await call('cu_paint', { pid: 42, windowId: 7, planPath: '/tmp/x.plan.json', layerIndex: 2, dryRun: true });
  assert.equal(dispatched.ok, true);
  const strokes = calls.find((argv) => argv[0] === 'strokes');
  assert.ok(!strokes.includes('--background'));
  assert.ok(strokes.includes('--dry-run'));
  assert.equal(strokes[strokes.indexOf('--layer') + 1], '2');

  const bg = await call('cu_paint', {
    pid: 42, windowId: 7, planPath: '/tmp/x.plan.json', layerIndex: 2, background: true, dryRun: true,
  });
  assert.equal(bg.ok, true);
  const bgStrokes = calls.filter((argv) => argv[0] === 'strokes').at(-1);
  assert.ok(bgStrokes.includes('--background'));
});

test('cu drawplan --mode vector builds real vector batches and cu_paint_plan forwards mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vector-plan-cli-'));
  try {
    const planPath = join(dir, 'vec.plan.json');
    const prevPath = join(dir, 'vec.preview.png');
    const summary = run([
      'drawplan', '--image', IMAGE, '--rect', '100,120,400,400',
      '--mode', 'vector', '--bg', 'auto', '--grid', '96', '--colors', '8',
      '--out', planPath, '--preview', prevPath,
    ]);
    assert.equal(summary.ok, true);
    assert.equal(summary.mode, 'vector');
    assert.ok(Array.isArray(summary.batches) && summary.batches.length >= 1);
    assert.ok(summary.totalStrokes >= 1);
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    assert.equal(plan.version, 2);
    assert.equal(plan.mode, 'vector');
    assert.equal(plan.batches.length, summary.batches.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const { call, calls } = harness();
  const wrapped = await call('cu_paint_plan', {
    imagePath: IMAGE, x: 100, y: 120, width: 400, height: 400,
    mode: 'vector', bgMode: 'auto', grid: 360, colors: 20, pid: 42, windowId: 7,
  });
  assert.equal(wrapped.ok, true);
  const forwarded = calls.find((argv) => argv[0] === 'drawplan' && argv.includes('vector'));
  assert.ok(forwarded);
  assert.equal(forwarded[forwarded.indexOf('--grid') + 1], '360');
  assert.equal(forwarded[forwarded.indexOf('--colors') + 1], '20');
  assert.equal(forwarded[forwarded.indexOf('--bg') + 1], 'auto');
});
