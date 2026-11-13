import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePaintGeometry } from '../lib/paint-geometry.mjs';

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
