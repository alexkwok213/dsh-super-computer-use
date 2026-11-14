import Foundation
import CoreGraphics

enum StrokeCurveMode: String {
    case linear = "linear"
    case catmullRom = "catmull-rom"
    case bezier = "bezier"

    init(parsing raw: String?) {
        switch raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? "" {
        case "catmull-rom", "catmullrom", "catmull", "spline", "smooth":
            self = .catmullRom
        case "bezier", "cubic", "quad", "quadratic":
            self = .bezier
        default:
            self = .linear
        }
    }
}

private func evalCatmullRomSegment(_ p0: CGPoint, _ p1: CGPoint, _ p2: CGPoint, _ p3: CGPoint, steps: Int) -> [CGPoint] {
    func knotDelta(_ a: CGPoint, _ b: CGPoint) -> CGFloat {
        max(1e-3, sqrt(hypot(b.x - a.x, b.y - a.y)))
    }
    let t0: CGFloat = 0
    let t1 = t0 + knotDelta(p0, p1)
    let t2 = t1 + knotDelta(p1, p2)
    let t3 = t2 + knotDelta(p2, p3)
    var out: [CGPoint] = []
    out.reserveCapacity(steps)
    for s in 1...steps {
        let t = t1 + (CGFloat(s) / CGFloat(steps)) * (t2 - t1)
        let a1x = ((t1 - t) / (t1 - t0)) * p0.x + ((t - t0) / (t1 - t0)) * p1.x
        let a1y = ((t1 - t) / (t1 - t0)) * p0.y + ((t - t0) / (t1 - t0)) * p1.y
        let a2x = ((t2 - t) / (t2 - t1)) * p1.x + ((t - t1) / (t2 - t1)) * p2.x
        let a2y = ((t2 - t) / (t2 - t1)) * p1.y + ((t - t1) / (t2 - t1)) * p2.y
        let a3x = ((t3 - t) / (t3 - t2)) * p2.x + ((t - t2) / (t3 - t2)) * p3.x
        let a3y = ((t3 - t) / (t3 - t2)) * p2.y + ((t - t2) / (t3 - t2)) * p3.y
        let b1x = ((t2 - t) / (t2 - t0)) * a1x + ((t - t0) / (t2 - t0)) * a2x
        let b1y = ((t2 - t) / (t2 - t0)) * a1y + ((t - t0) / (t2 - t0)) * a2y
        let b2x = ((t3 - t) / (t3 - t1)) * a2x + ((t - t1) / (t3 - t1)) * a3x
        let b2y = ((t3 - t) / (t3 - t1)) * a2y + ((t - t1) / (t3 - t1)) * a3y
        let cx = ((t2 - t) / (t2 - t1)) * b1x + ((t - t1) / (t2 - t1)) * b2x
        let cy = ((t2 - t) / (t2 - t1)) * b1y + ((t - t1) / (t2 - t1)) * b2y
        out.append(CGPoint(x: cx, y: cy))
    }
    return out
}

private func evalQuadBezier(_ p0: CGPoint, _ p1: CGPoint, _ p2: CGPoint, steps: Int) -> [CGPoint] {
    var out: [CGPoint] = []
    out.reserveCapacity(steps)
    for s in 1...steps {
        let t = CGFloat(s) / CGFloat(steps)
        let u = 1 - t
        out.append(CGPoint(
            x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
            y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y
        ))
    }
    return out
}

private func evalCubicBezier(_ p0: CGPoint, _ p1: CGPoint, _ p2: CGPoint, _ p3: CGPoint, steps: Int) -> [CGPoint] {
    var out: [CGPoint] = []
    out.reserveCapacity(steps)
    for s in 1...steps {
        let t = CGFloat(s) / CGFloat(steps)
        let u = 1 - t
        let b0 = u * u * u
        let b1 = 3 * u * u * t
        let b2 = 3 * u * t * t
        let b3 = t * t * t
        out.append(CGPoint(
            x: b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x,
            y: b0 * p0.y + b1 * p1.y + b2 * p2.y + b3 * p3.y
        ))
    }
    return out
}

/// Expand a control polygon into a smooth polyline according to `curve`:
/// - `.linear`: returns control points unchanged.
/// - `.catmullRom`: centripetal Catmull-Rom C1 spline passing through every control point.
/// - `.bezier`: quadratic Bézier (3 pts), composite cubic Bézier (3k+1 pts), or midpoint B-spline (other n >= 4).
func expandStrokeCurve(_ pts: [CGPoint], curve: StrokeCurveMode, step: CGFloat = 4.0) -> [CGPoint] {
    guard pts.count >= 2, pts.allSatisfy({ $0.x.isFinite && $0.y.isFinite }) else { return pts }
    if curve == .linear || pts.count == 2 { return pts }
    let sampleStep = max(1.5, min(24.0, step))
    let n = pts.count

    if curve == .catmullRom {
        let closed = n >= 4 && hypot(pts[n - 1].x - pts[0].x, pts[n - 1].y - pts[0].y) < 1e-2
        let pFirst = closed ? pts[n - 2] : CGPoint(x: 2 * pts[0].x - pts[1].x, y: 2 * pts[0].y - pts[1].y)
        let pLast = closed ? pts[1] : CGPoint(x: 2 * pts[n - 1].x - pts[n - 2].x, y: 2 * pts[n - 1].y - pts[n - 2].y)
        let ext = [pFirst] + pts + [pLast]
        var out = [pts[0]]
        for i in 0..<(n - 1) {
            let p0 = ext[i], p1 = ext[i + 1], p2 = ext[i + 2], p3 = ext[i + 3]
            let chord = hypot(p2.x - p1.x, p2.y - p1.y)
            if chord < 1e-4 { continue }
            let steps = max(2, min(64, Int(ceil((chord * 1.25) / sampleStep))))
            for q in evalCatmullRomSegment(p0, p1, p2, p3, steps: steps) {
                if out.count < 256 { out.append(q) }
            }
        }
        return out
    }

    // .bezier
    var out = [pts[0]]
    if n == 3 {
        let net = hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) + hypot(pts[2].x - pts[1].x, pts[2].y - pts[1].y)
        let steps = max(3, min(96, Int(ceil(net / sampleStep))))
        for q in evalQuadBezier(pts[0], pts[1], pts[2], steps: steps) {
            if out.count < 256 { out.append(q) }
        }
        return out
    }
    if (n - 1) % 3 == 0 {
        var i = 0
        while i + 3 < n {
            let p0 = pts[i], p1 = pts[i + 1], p2 = pts[i + 2], p3 = pts[i + 3]
            let net = hypot(p1.x - p0.x, p1.y - p0.y) + hypot(p2.x - p1.x, p2.y - p1.y) + hypot(p3.x - p2.x, p3.y - p2.y)
            let steps = max(3, min(64, Int(ceil(net / sampleStep))))
            for q in evalCubicBezier(p0, p1, p2, p3, steps: steps) {
                if out.count < 256 { out.append(q) }
            }
            i += 3
        }
        return out
    }
    var prev = pts[0]
    for i in 1..<(n - 1) {
        let ctrl = pts[i]
        let next = (i == n - 2)
            ? pts[n - 1]
            : CGPoint(x: (ctrl.x + pts[i + 1].x) / 2, y: (ctrl.y + pts[i + 1].y) / 2)
        let net = hypot(ctrl.x - prev.x, ctrl.y - prev.y) + hypot(next.x - ctrl.x, next.y - ctrl.y)
        let steps = max(2, min(48, Int(ceil(net / sampleStep))))
        for q in evalQuadBezier(prev, ctrl, next, steps: steps) {
            if out.count < 256 { out.append(q) }
        }
        prev = next
    }
    return out
}

func strokeIntersectsRect(_ path: [CGPoint], _ rectangle: CGRect) -> Bool {
    let rect = rectangle.insetBy(dx: -2, dy: -2)
    for (a, b) in zip(path, path.dropFirst()) {
        let dx = b.x - a.x, dy = b.y - a.y
        var low: CGFloat = 0, high: CGFloat = 1
        var intersects = true
        for (p, q) in [(-dx, a.x - rect.minX), (dx, rect.maxX - a.x), (-dy, a.y - rect.minY), (dy, rect.maxY - a.y)] {
            if p == 0 { if q < 0 { intersects = false; break }; continue }
            let t = q / p
            if p < 0 { low = max(low, t) } else { high = min(high, t) }
            if low > high { intersects = false; break }
        }
        if intersects { return true }
    }
    return false
}

func strokeWithinLimits(_ path: [CGPoint], paceMs: Int) -> Bool {
    guard path.count >= 2, path.count <= 256, paceMs >= 2 && paceMs <= 200,
          path.allSatisfy({ $0.x.isFinite && $0.y.isFinite }) else { return false }
    var length: CGFloat = 0
    var steps = 3
    for (a, b) in zip(path, path.dropFirst()) {
        let segment = hypot(b.x - a.x, b.y - a.y)
        guard segment.isFinite && segment <= 1200 else { return false }
        length += segment
        guard length <= 1200 else { return false }
        steps += max(1, Int(ceil(segment / 6)))
    }
    return steps * paceMs <= 15_000
}

func interpolateStroke(_ path: [CGPoint], spacing: CGFloat, curve: StrokeCurveMode = .linear) -> [CGPoint] {
    let expanded = curve == .linear ? path : expandStrokeCurve(path, curve: curve, step: max(2.0, spacing))
    guard let first = expanded.first, spacing > 0 else { return expanded }
    var result = [first]
    for (a, b) in zip(expanded, expanded.dropFirst()) {
        let count = max(1, Int(ceil(hypot(b.x - a.x, b.y - a.y) / spacing)))
        for step in 1...count {
            let t = CGFloat(step) / CGFloat(count)
            result.append(CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t))
        }
    }
    return result
}
