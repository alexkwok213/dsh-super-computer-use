import Foundation
import CoreGraphics
@main struct StrokeInterpolationTest {
    static func main() {
        let path = interpolateStroke([CGPoint(x: 0, y: 0), CGPoint(x: 24, y: 0)], spacing: 6)
        precondition(path.count == 5)
        precondition(path.first == CGPoint(x: 0, y: 0) && path.last == CGPoint(x: 24, y: 0))
        precondition(path[1] == CGPoint(x: 6, y: 0))
        let curved = interpolateStroke([CGPoint(x: 0, y: 0), CGPoint(x: 0, y: 12), CGPoint(x: 12, y: 12)], spacing: 6)
        precondition(curved.contains(CGPoint(x: 0, y: 12)) && curved.last == CGPoint(x: 12, y: 12))
        precondition(strokeWithinLimits([CGPoint(x: 0, y: 0), CGPoint(x: 1200, y: 0)], paceMs: 13))
        precondition(!strokeWithinLimits([CGPoint(x: 0, y: 0), CGPoint(x: 1201, y: 0)], paceMs: 13))
        precondition(!strokeWithinLimits(Array(repeating: CGPoint(x: 1, y: 1), count: 257), paceMs: 13))
        precondition(!strokeWithinLimits([CGPoint(x: 0, y: 0), CGPoint(x: 1200, y: 0)], paceMs: 200))
        let popup = CGRect(x: 40, y: 40, width: 20, height: 20)
        precondition(strokeIntersectsRect([CGPoint(x: 0, y: 50), CGPoint(x: 100, y: 50)], popup))
        precondition(!strokeIntersectsRect([CGPoint(x: 0, y: 10), CGPoint(x: 100, y: 10)], popup))
        precondition(strokeIntersectsRect([CGPoint(x: 50, y: 50), CGPoint(x: 52, y: 52)], popup))
        print("stroke interpolation tests passed")
    }
}
