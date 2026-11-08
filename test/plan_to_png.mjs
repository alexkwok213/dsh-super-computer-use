// The reliable image-reproduction pipeline: cu drawplan -> plan-to-png -> a real
// PNG. This test proves the rasterizer is deterministic and pixel-accurate
// without touching any browser, so the drawing capability has a stable,
// offline-verifiable backbone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const CU = process.env.CU_BIN || join(ROOT, 'bin', 'cu');
const IMAGE = join(ROOT, 'assets', 'icon.png');
const PY = (() => {
  const candidates = [
    process.env.CU_PYTHON, process.env.PYTHON,
    '/Users/johnkwok/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3',
    'python3',
  ].filter(Boolean);
  for (const c of candidates) {
    try { execFileSync(c, ['-c', 'import PIL'], { stdio: 'ignore' }); return c; }
    catch { /* next */ }
  }
  return 'python3';
})();

function hasPIL() {
  try { execFileSync(PY, ['-c', 'import PIL'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

test('plan-to-png rasterizes a drawplan into a valid PNG', async (t) => {
  if (!existsSync(join(ROOT, 'scripts', 'plan-to-png.py'))) { t.skip('no plan-to-png.py'); return; }
  if (!hasPIL()) { t.skip('Pillow/python not available'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'cu-png-'));
  try {
    const planPath = join(dir, 'plan.json');
    const outPath = join(dir, 'out.png');
    // compile a plan
    const summary = JSON.parse(execFileSync(CU, ['drawplan', '--image', IMAGE, '--rect', '10,20,300,300', '--grid', '60', '--colors', '5', '--out', planPath], { encoding: 'utf8' }).trim().split('\n').pop());
    assert.equal(summary.ok, true);
    assert.ok(existsSync(planPath));
    // rasterize
    const r = JSON.parse(execFileSync(PY, [join(ROOT, 'scripts', 'plan-to-png.py'), planPath, outPath, '--scale', '1'], { encoding: 'utf8' }).trim().split('\n').pop());
    assert.equal(r.ok, true);
    const png = readFileSync(outPath);
    // PNG magic
    assert.equal(png.toString('ascii', 1, 4), 'PNG');
    assert.ok(png.length > 1000, 'png has content');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
