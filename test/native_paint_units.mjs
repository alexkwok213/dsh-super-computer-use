import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const [source, fixture] of [
  ['PaintVerification.swift', 'paint_verification.swift'],
  ['StrokeInterpolation.swift', 'stroke_interpolation.swift'],
  ['PaintCancellation.swift', 'paint_cancellation.swift'],
]) {
  test(`native ${source} behavior`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'cu-swift-test-'));
    try {
      const bin = join(dir, 'test');
      execFileSync('swiftc', ['-parse-as-library', `engine/Sources/${source}`, `engine/tests/${fixture}`, '-o', bin], { timeout: 60000 });
      assert.match(execFileSync(bin, { encoding: 'utf8', timeout: 10000 }), /tests passed/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
