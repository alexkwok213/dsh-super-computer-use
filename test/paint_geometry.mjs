import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandStrokeCurve, normalizeStrokePaths, validatePaintGeometry } from '../lib/paint-geometry.mjs';

const square = [[0, 0], [100, 0], [100, 100], [0, 100]];
test('rejects a stroke leaving its intended region before any input', () => {
  assert.equal(validatePaintGeometry([[[20, 20], [110, 20]]], square, 2).ok, false);
});
test('brush footprint must fit even when its centerline fits', () => {
  assert.equal(validatePaintGeometry([[[1, 20], [1, 80]]], square, 6).ok, false);
  assert.equal(validatePaintGeometry([[[4, 20], [4, 80]]], square, 6).ok, true);
});
test('segments cannot cross a concave cutout between valid endpoints', () => {
  const region = [[0, 0], [100, 0], [100, 30], [30, 30], [30, 100], [0, 100]];
  assert.equal(validatePaintGeometry([[[20, 80], [80, 20]]], region, 2).ok, false);
  assert.equal(validatePaintGeometry([[[20, 80], [20, 20], [80, 20]]], region, 2).ok, true);
});
test('narrow cutouts cannot hide between sampled positions', () => {
  const region = [[0, 0], [100, 0], [100, 100], [50.1, 100], [50.1, 10], [50, 10], [50, 100], [0, 100]];
  assert.equal(validatePaintGeometry([[[20, 50], [80, 50]]], region, 0.01).ok, false);
});
test('malformed regions, paths and widths fail closed', () => {
  for (const [paths, region, width] of [
    [[[[20, 20], [80, 20]]], undefined, 2],
    [[[[20, 20], [80, 20]]], square, 0],
    [[[[20, 20], [80, 20]]], square, Infinity],
    [[[[20, 20], [NaN, 20]]], square, 2],
    [[], square, 2],
    [[[[20, 20], [80, 20]]], [[0, 0], [100, 100], [0, 100], [100, 0]], 2],
  ]) assert.equal(validatePaintGeometry(paths, region, width).ok, false);
});
test('expandStrokeCurve generates smooth Catmull-Rom and Bezier trajectories', () => {
  const control = [[20, 20], [50, 70], [80, 20]];
  const catmull = expandStrokeCurve(control, 'catmull-rom', 4);
  assert.ok(catmull.length > control.length);
  assert.deepEqual(catmull[0], [20, 20]);
  assert.deepEqual(catmull[catmull.length - 1], [80, 20]);
  // Catmull-Rom passes through interior control points
  assert.ok(catmull.some(([x, y]) => Math.hypot(x - 50, y - 70) < 0.01));

  const bezier = expandStrokeCurve(control, 'bezier', 4);
  assert.ok(bezier.length > control.length);
  assert.deepEqual(bezier[0], [20, 20]);
  assert.deepEqual(bezier[bezier.length - 1], [80, 20]);
  // Quadratic Bezier midpoint at t=0.5 is [50, 45]
  assert.ok(bezier.some(([x, y]) => Math.hypot(x - 50, y - 45) < 1.5));
});
test('normalizeStrokePaths expands per-stroke curve objects and validatePaintGeometry checks curved overshoot', () => {
  const normalized = normalizeStrokePaths([
    { curve: 'catmull-rom', points: [[20, 20], [50, 60], [80, 20]] },
    [[20, 80], [80, 80]],
  ], 'linear', 4);
  assert.equal(normalized.length, 2);
  assert.ok(normalized[0].length > 3);
  assert.equal(normalized[1].length, 2);
  assert.equal(validatePaintGeometry(normalized, square, 4).ok, true);
  // A curve whose control points are near the top edge (y=4 -> y=2 -> y=4) overshoots y < 2 with brushWidth=4 (radius 2)
  assert.equal(
    validatePaintGeometry([[[10, 10], [50, 2.5], [90, 10]]], square, 6, { curve: 'catmull-rom' }).ok,
    false,
  );
});
