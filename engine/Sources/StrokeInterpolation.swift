import Foundation
import CoreGraphics

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

func interpolateStroke(_ path: [CGPoint], spacing: CGFloat) -> [CGPoint] {
    guard let first = path.first, spacing > 0 else { return path }
    var result = [first]
    for (a, b) in zip(path, path.dropFirst()) {
        let count = max(1, Int(ceil(hypot(b.x - a.x, b.y - a.y) / spacing)))
        for step in 1...count {
            let t = CGFloat(step) / CGFloat(count)
            result.append(CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t))
        }
    }
    return result
}
