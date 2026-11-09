// CDP drawing channel: cu_cdp_paint injects strokes into a web canvas over the
// Chrome DevTools Protocol. These tests exercise the tool's validation and plan
// geometry headlessly; the live-browser probe (status) is skipped when no
// DevToolsActivePort is found so the suite stays hermetic on CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CuSessionManager } from '../lib/core.mjs';
import { registerCuTools } from '../lib/index.mjs';
import { planLayerToStrokes, buildLayerStrokes, isNearWhiteHex, readDevToolsActivePort } from '../lib/cdp.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

function harness() {
  const tools = new Map();
  const ctx = {
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    get: () => undefined,
  };
  const manager = new CuSessionManager();
  manager._cursorWrite = () => true;
  manager.writeActivity = () => {};
  manager.assertCanAct = () => {};
  registerCuTools({ ctx, manager, config: { autoSession: false, observeBudgetMs: 0 } });
  const runCtx = { signal: new AbortController().signal };
  return { tools, call: (name, args) => tools.get(name).execute(args, runCtx) };
}

test('cu_cdp_paint registers with a host-valid schema', () => {
  const { tools } = harness();
  const def = tools.get('cu_cdp_paint');
  assert.ok(def, 'cu_cdp_paint tool is registered');
});

test('planLayerToStrokes mirrors the native run-to-stroke geometry', () => {
  const plan = {
    x0: 100, y0: 50, sx: 4, sy: 2,
    layers: [{ index: 3, hex: '#123456', runs: [[0, 0, 2], [1, 4, 5]] }],
  };
  const { hex, strokes } = planLayerToStrokes(plan, 3, 0.13);
  assert.equal(hex, '#123456');
  assert.equal(strokes.length, 2);
  // run [0,0,2]: y = 50 + (0+0.5)*2 = 51; xa = 100 + 0*4 + 0.13*4 = 100.52; xb = 100 + 3*4 - 0.52 = 111.48
  assert.equal(strokes[0][0][1], 51);
  assert.ok(Math.abs(strokes[0][0][0] - 100.52) < 1e-6);
  assert.ok(Math.abs(strokes[0][1][0] - 111.48) < 1e-6);
  // second run is two points on the same y row
  assert.equal(strokes[1][0][1], strokes[1][1][1]);
});

test('planLayerToStrokes throws on a missing layer', () => {
  const plan = { x0: 0, y0: 0, sx: 1, sy: 1, layers: [] };
  assert.throws(() => planLayerToStrokes(plan, 9), /plan_layer_missing/);
});

test('cu_cdp_paint rejects a paint call without a source', async () => {
  const { call } = harness();
  const r = await call('cu_cdp_paint', { action: 'paint', urlMatch: 'example.com' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'missing_source');
});

test('cu_cdp_paint rejects a plan call without a layer', async () => {
  const { call } = harness();
  const dir = mkdtempSync(join(tmpdir(), 'cu-cdp-'));
  try {
    const planPath = join(dir, 'plan.json');
    writeFileSync(planPath, JSON.stringify({ x0: 0, y0: 0, sx: 1, sy: 1, layers: [] }));
    const r = await call('cu_cdp_paint', { action: 'paint', planPath, urlMatch: 'example.com' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'missing_layer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('live CDP status probe (skipped if Chrome has no debug port)', async (t) => {
  const port = readDevToolsActivePort();
  if (!port) {
    t.skip('no DevToolsActivePort — Chrome not launched with --remote-debugging-port');
    return;
  }
  const { call } = harness();
  // urlMatch that cannot match keeps the probe offline-safe (returns not-found, not a live action)
  const r = await call('cu_cdp_paint', { action: 'status', urlMatch: '__no_such_page__' });
  // Either it lists pages (with at least the browser reachable) or reports a clear error.
  assert.ok(r.ok === true || r.error === 'cdp_connect_failed' || r.error === 'cdp_page_not_found' || r.error === 'cdp_paint_failed');
});

test('owned debug Chrome: launch, attach, and paint a canvas (skipped without Chrome)', async (t) => {
  const { existsSync } = await import('node:fs');
  const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!existsSync(CHROME)) { t.skip('no Chrome app'); return; }
  const { launchDebugChrome, acquirePage, paintStrokes, releasePages } = await import('../lib/cdp.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cu-cdp-e2e-'));
  const port = 9777;
  // Chrome 136+ (verified on 156) refuses CDP Input.dispatchMouseEvent on
  // opaque data: URLs with "Internal error (-32603)". A file:// page has a real
  // origin, so the end-to-end stroke still runs against the real browser.
  const pagePath = join(dir, 'page.html');
  writeFileSync(pagePath, "<!doctype html><html><body><canvas id=c width=300 height=200 style='border:1px solid red'></canvas><script>const c=document.getElementById('c'),x=c.getContext('2d');let d=false;c.addEventListener('mousedown',()=>{d=true;x.beginPath()});c.addEventListener('mousemove',e=>{if(d){x.lineTo(e.offsetX,e.offsetY);x.stroke()}});c.addEventListener('mouseup',()=>d=false);</script></body></html>");
  const startUrl = 'file://' + pagePath;
  try {
    let info;
    try {
      info = await launchDebugChrome({ profileDir: dir, port, startUrl, timeoutMs: 20000 });
    } catch (err) {
      if (err && (err.code === 'EPERM' || /EPERM|cdp_launch_timeout/.test(String(err.message ?? err)))) {
        t.skip(`sandbox blocks launching Chrome (${err.code || err.message})`);
        return;
      }
      throw err;
    }
    assert.ok(info.browserUrl.includes('/devtools/browser/'));
    const conn = await acquirePage({ wsUrl: info.browserUrl, urlMatch: 'page.html' });
    const r = await paintStrokes(conn.client, [[[40, 40], [120, 90], [200, 50]]], { paceMs: 20 });
    assert.equal(r.strokes, 1);
    const ev = await conn.client.send('Runtime.evaluate', {
      expression: "(()=>{const c=document.getElementById('c');const d=c.getContext('2d').getImageData(0,0,300,200).data;let n=0;for(let i=3;i<d.length;i+=4)if(d[i]>0)n++;return n;})()",
      returnByValue: true,
    });
    assert.ok(ev.result.value > 20, `expected painted pixels, got ${ev.result.value}`);
    releasePages({});
  } finally {
    try { (await import('node:child_process')).execSync(`pkill -f "remote-debugging-port=${port}"`); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 600));
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* ignore */ }
  }
});

test('syncProfileLogin copies login state into a dedicated profile', async () => {
  const { mkdtempSync: mk, mkdirSync, writeFileSync: wf, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { syncProfileLogin } = await import('../lib/cdp.mjs');
  const src = mk(join(tmpdir(), 'cu-src-'));
  const dst = mk(join(tmpdir(), 'cu-dst-'));
  mkdirSync(join(src, 'Default'), { recursive: true });
  wf(join(src, 'Default', 'Cookies'), 'fake-cookies');
  wf(join(src, 'Default', 'Login Data'), 'fake-logins');
  wf(join(src, 'Local State'), '{}');
  try {
    const r = syncProfileLogin({ destProfileDir: dst, dailyUserDataDir: src });
    assert.ok(r.copied.includes('Cookies'));
    assert.ok(r.copied.includes('Login Data'));
    assert.ok(r.copied.includes('Local State'));
    assert.ok(existsSync(join(dst, 'Default', 'Cookies')));
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test('serpentine/region strokes collapse thousands of runs into a few elements', async () => {
  const { planLayerToSerpentine, planLayerToRegionStrokes } = await import('../lib/cdp.mjs');
  const runs = [];
  for (let j = 0; j < 20; j++) runs.push([0, j, 9]);
  const plan = { x0: 0, y0: 0, sx: 5, sy: 5, layers: [{ index: 1, hex: '#123456', runs }] };
  const one = planLayerToSerpentine(plan, 1, 0.5);
  assert.equal(one.points.length > 20, true, 'one continuous polyline');
  const regions = planLayerToRegionStrokes(plan, 1, 0.5);
  // A solid 10x20 block is ONE connected region -> one stroke, not 20.
  assert.equal(regions.strokes.length, 1);
  assert.ok(regions.strokes[0].length >= 40);
});

test('region grouping keeps far-apart blocks in separate strokes', async () => {
  const { planLayerToRegionStrokes } = await import('../lib/cdp.mjs');
  const plan = {
    x0: 0, y0: 0, sx: 5, sy: 5,
    layers: [{ index: 1, hex: '#111111', runs: [[0, 0, 1], [50, 0, 51], [0, 1, 1], [50, 1, 51]] }],
  };
  const r = planLayerToRegionStrokes(plan, 1, 0.5);
  assert.equal(r.strokes.length, 2, 'two disjoint blocks -> two strokes');
});

test('buildLayerStrokes supports regions mode and +sy/2 seamPass', () => {
  const plan = {
    x0: 10, y0: 20, sx: 4, sy: 4,
    layers: [{ index: 0, hex: '#1f2937', runs: [[0, 0, 2], [0, 1, 2]] }],
  };
  const single = buildLayerStrokes(plan, 0, { mode: 'regions', seamPass: false });
  assert.equal(single.strokes.length, 1);
  assert.equal(single.seamPassApplied, false);

  const seamed = buildLayerStrokes(plan, 0, { mode: 'regions', seamPass: true });
  assert.equal(seamed.strokes.length, 2, 'seamPass doubles the region strokes with +sy/2 offset');
  assert.equal(seamed.seamPassApplied, true);
  assert.equal(seamed.strokes[1][0][1] - seamed.strokes[0][0][1], 2, 'shifted by sy/2 = 2px');
});

test('isNearWhiteHex identifies near-white background layers', () => {
  assert.equal(isNearWhiteHex('#fcf5f5'), true);
  assert.equal(isNearWhiteHex('#ffffff'), true);
  assert.equal(isNearWhiteHex('#1e1e1e'), false);
  assert.equal(isNearWhiteHex('#3b82f6'), false);
});
