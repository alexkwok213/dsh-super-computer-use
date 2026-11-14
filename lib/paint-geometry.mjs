// Geometric containment & smooth spline expansion: the caller must derive the
// region from the reference and current canvas. This cannot establish semantic correctness.
const point = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

export function normalizeCurveMode(mode) {
  const m = String(mode ?? "linear").trim().toLowerCase();
  if (m === "catmull-rom" || m === "catmullrom" || m === "catmull" || m === "spline" || m === "smooth") {
    return "catmull-rom";
  }
  if (m === "bezier" || m === "cubic" || m === "quad" || m === "quadratic") {
    return "bezier";
  }
  return "linear";
}

function evalCatmullRomSegment(p0, p1, p2, p3, steps) {
  const knotDelta = (a, b) => Math.max(1e-3, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
  const t0 = 0;
  const t1 = t0 + knotDelta(p0, p1);
  const t2 = t1 + knotDelta(p1, p2);
  const t3 = t2 + knotDelta(p2, p3);
  const out = [];
  for (let s = 1; s <= steps; s++) {
    const t = t1 + (s / steps) * (t2 - t1);
    const a1x = ((t1 - t) / (t1 - t0)) * p0[0] + ((t - t0) / (t1 - t0)) * p1[0];
    const a1y = ((t1 - t) / (t1 - t0)) * p0[1] + ((t - t0) / (t1 - t0)) * p1[1];
    const a2x = ((t2 - t) / (t2 - t1)) * p1[0] + ((t - t1) / (t2 - t1)) * p2[0];
    const a2y = ((t2 - t) / (t2 - t1)) * p1[1] + ((t - t1) / (t2 - t1)) * p2[1];
    const a3x = ((t3 - t) / (t3 - t2)) * p2[0] + ((t - t2) / (t3 - t2)) * p3[0];
    const a3y = ((t3 - t) / (t3 - t2)) * p2[1] + ((t - t2) / (t3 - t2)) * p3[1];
    const b1x = ((t2 - t) / (t2 - t0)) * a1x + ((t - t0) / (t2 - t0)) * a2x;
    const b1y = ((t2 - t) / (t2 - t0)) * a1y + ((t - t0) / (t2 - t0)) * a2y;
    const b2x = ((t3 - t) / (t3 - t1)) * a2x + ((t - t1) / (t3 - t1)) * a3x;
    const b2y = ((t3 - t) / (t3 - t1)) * a2y + ((t - t1) / (t3 - t1)) * a3y;
    const cx = ((t2 - t) / (t2 - t1)) * b1x + ((t - t1) / (t2 - t1)) * b2x;
    const cy = ((t2 - t) / (t2 - t1)) * b1y + ((t - t1) / (t2 - t1)) * b2y;
    out.push([cx, cy]);
  }
  return out;
}

function evalQuadBezier(p0, p1, p2, steps) {
  const out = [];
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const u = 1 - t;
    out.push([
      u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
      u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    ]);
  }
  return out;
}

function evalCubicBezier(p0, p1, p2, p3, steps) {
  const out = [];
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const u = 1 - t;
    const b0 = u * u * u;
    const b1 = 3 * u * u * t;
    const b2 = 3 * u * t * t;
    const b3 = t * t * t;
    out.push([
      b0 * p0[0] + b1 * p1[0] + b2 * p2[0] + b3 * p3[0],
      b0 * p0[1] + b1 * p1[1] + b2 * p2[1] + b3 * p3[1],
    ]);
  }
  return out;
}

/**
 * Expand a control polygon into a smooth polyline according to `curveMode`:
 * - 'linear': returns control points unchanged.
 * - 'catmull-rom': centripetal Catmull-Rom C1 spline passing through every control point.
 * - 'bezier': quadratic Bézier (3 pts), composite cubic Bézier (3k+1 pts), or midpoint B-spline (other n >= 4).
 */
export function expandStrokeCurve(pts, curveMode = "linear", step = 4) {
  if (!Array.isArray(pts) || pts.length < 2 || !pts.every(point)) return pts;
  const mode = normalizeCurveMode(curveMode);
  if (mode === "linear" || pts.length === 2) return pts.map(([x, y]) => [x, y]);
  const sampleStep = Math.max(1.5, Math.min(24, Number(step) || 4));

  if (mode === "catmull-rom") {
    const n = pts.length;
    const closed = n >= 4 && Math.hypot(pts[n - 1][0] - pts[0][0], pts[n - 1][1] - pts[0][1]) < 1e-2;
    const pFirst = closed ? pts[n - 2] : [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]];
    const pLast = closed ? pts[1] : [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]];
    const ext = [pFirst, ...pts, pLast];
    const out = [[pts[0][0], pts[0][1]]];
    for (let i = 0; i < n - 1; i++) {
      const p0 = ext[i], p1 = ext[i + 1], p2 = ext[i + 2], p3 = ext[i + 3];
      const chord = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      if (chord < 1e-4) continue;
      const steps = Math.max(2, Math.min(64, Math.ceil((chord * 1.25) / sampleStep)));
      for (const q of evalCatmullRomSegment(p0, p1, p2, p3, steps)) {
        if (out.length < 256) out.push(q);
      }
    }
    return out;
  }

  // mode === 'bezier'
  const n = pts.length;
  const out = [[pts[0][0], pts[0][1]]];
  if (n === 3) {
    const net = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) + Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]);
    const steps = Math.max(3, Math.min(96, Math.ceil(net / sampleStep)));
    for (const q of evalQuadBezier(pts[0], pts[1], pts[2], steps)) {
      if (out.length < 256) out.push(q);
    }
    return out;
  }
  if ((n - 1) % 3 === 0) {
    for (let i = 0; i + 3 < n; i += 3) {
      const p0 = pts[i], p1 = pts[i + 1], p2 = pts[i + 2], p3 = pts[i + 3];
      const net = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
      const steps = Math.max(3, Math.min(64, Math.ceil(net / sampleStep)));
      for (const q of evalCubicBezier(p0, p1, p2, p3, steps)) {
        if (out.length < 256) out.push(q);
      }
    }
    return out;
  }
  // Smooth midpoint quadratic B-spline for general control polygons (n >= 4)
  let prev = pts[0];
  for (let i = 1; i < n - 1; i++) {
    const ctrl = pts[i];
    const next = i === n - 2 ? pts[n - 1] : [(ctrl[0] + pts[i + 1][0]) / 2, (ctrl[1] + pts[i + 1][1]) / 2];
    const net = Math.hypot(ctrl[0] - prev[0], ctrl[1] - prev[1]) + Math.hypot(next[0] - ctrl[0], next[1] - ctrl[1]);
    const steps = Math.max(2, Math.min(48, Math.ceil(net / sampleStep)));
    for (const q of evalQuadBezier(prev, ctrl, next, steps)) {
      if (out.length < 256) out.push(q);
    }
    prev = next;
  }
  return out;
}

export function normalizeStrokePaths(rawStrokes, defaultCurve = "linear", step = 4) {
  if (!Array.isArray(rawStrokes) || rawStrokes.length === 0) return null;
  const fallbackCurve = normalizeCurveMode(defaultCurve);
  const paths = [];
  for (const entry of rawStrokes) {
    let pts = null;
    let curve = fallbackCurve;
    if (Array.isArray(entry)) {
      pts = entry;
    } else if (entry && typeof entry === "object" && Array.isArray(entry.points)) {
      pts = entry.points;
      if (entry.curve !== undefined) curve = normalizeCurveMode(entry.curve);
    } else {
      return null;
    }
    if (!Array.isArray(pts) || pts.length < 2 || pts.some(p => !point(p))) return null;
    paths.push(expandStrokeCurve(pts, curve, step));
  }
  return paths;
}

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
export function validatePaintGeometry(paths, region, brushWidth, options = {}) {
  const invalid = { ok: false, error: 'invalid_paint_region' };
  const expanded = options?.curve ? normalizeStrokePaths(paths, options.curve) : paths;
  if (!Array.isArray(region) || region.length < 3 || region.length > 256 || !region.every(point) ||
      !Number.isFinite(brushWidth) || brushWidth <= 0 ||
      !Array.isArray(expanded) || !expanded.length || expanded.some(p => !Array.isArray(p) || p.length < 2 || !p.every(point))) return invalid;
  const edges = region.map((a, i) => [a, region[(i + 1) % region.length]]);
  const area = edges.reduce((sum, [a, b]) => sum + a[0] * b[1] - a[1] * b[0], 0);
  if (Math.abs(area) < 1e-9 || edges.some(([a, b]) => distanceToSegment(a, b, b) === 0)) return invalid;
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    if (j === i + 1 || (i === 0 && j === edges.length - 1)) continue;
    if (segmentDistance(...edges[i], ...edges[j]) < 1e-9) return invalid;
  }
  for (let index = 0; index < expanded.length; index++) {
    const path = expanded[index];
    for (let i = 1; i < path.length; i++) {
      if (!inside(path[i - 1], region) || !inside(path[i], region) ||
          edges.some(([a, b]) => segmentDistance(path[i - 1], path[i], a, b) < brushWidth / 2)) {
        return { ok: false, error: 'stroke_outside_paint_region', failedStroke: index };
      }
    }
  }
  return { ok: true };
}
