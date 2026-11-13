// Geometric containment only: the caller must derive the region from the
// reference and current canvas. This cannot establish semantic correctness.
const point = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function distanceToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function segmentDistance(a, b, c, d) {
  const abC = cross(a, b, c), abD = cross(a, b, d);
  const cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) &&
      ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return 0;
  return Math.min(distanceToSegment(a, c, d), distanceToSegment(b, c, d),
    distanceToSegment(c, a, b), distanceToSegment(d, a, b));
}
function inside(p, polygon) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) &&
        p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}
export function validatePaintGeometry(paths, region, brushWidth) {
  const invalid = { ok: false, error: 'invalid_paint_region' };
  if (!Array.isArray(region) || region.length < 3 || region.length > 256 || !region.every(point) ||
      !Number.isFinite(brushWidth) || brushWidth <= 0 ||
      !Array.isArray(paths) || !paths.length || paths.some(p => !Array.isArray(p) || p.length < 2 || !p.every(point))) return invalid;
  const edges = region.map((a, i) => [a, region[(i + 1) % region.length]]);
  const area = edges.reduce((sum, [a, b]) => sum + a[0] * b[1] - a[1] * b[0], 0);
  if (Math.abs(area) < 1e-9 || edges.some(([a, b]) => distanceToSegment(a, b, b) === 0)) return invalid;
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    if (j === i + 1 || (i === 0 && j === edges.length - 1)) continue;
    if (segmentDistance(...edges[i], ...edges[j]) < 1e-9) return invalid;
  }
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index];
    for (let i = 1; i < path.length; i++) {
      if (!inside(path[i - 1], region) || !inside(path[i], region) ||
          edges.some(([a, b]) => segmentDistance(path[i - 1], path[i], a, b) < brushWidth / 2)) {
        return { ok: false, error: 'stroke_outside_paint_region', failedStroke: index };
      }
    }
  }
  return { ok: true };
}
