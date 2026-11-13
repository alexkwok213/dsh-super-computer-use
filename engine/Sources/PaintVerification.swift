import Foundation
import CoreGraphics
import ImageIO

func paintImagePixels(_ path: String) -> (pixels: [UInt8], width: Int, height: Int)? {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
          let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    let width = image.width, height = image.height
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    let succeeded = pixels.withUnsafeMutableBytes { raw -> Bool in
        guard let context = CGContext(data: raw.baseAddress, width: width, height: height,
                                      bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: colorSpace,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return true
    }
    return succeeded ? (pixels, width, height) : nil
}

struct PaintInspection {
    let matched: Bool
    let failedStrokes: [Int]
}

private func paintHue(_ r: Int, _ g: Int, _ b: Int) -> Double? {
    let high = max(r, max(g, b)), low = min(r, min(g, b))
    let delta = high - low
    guard delta >= 40 else { return nil }
    let sector: Double
    if high == r { sector = Double(g - b) / Double(delta) }
    else if high == g { sector = 2 + Double(b - r) / Double(delta) }
    else { sector = 4 + Double(r - g) / Double(delta) }
    let degrees = sector * 60
    return degrees < 0 ? degrees + 360 : degrees
}

func inspectSwatch(pixels: [UInt8], width: Int, height: Int, center: CGPoint,
                   expected: (UInt8, UInt8, UInt8)) -> Bool {
    guard width > 0, height > 0, pixels.count == width * height * 4,
          center.x.isFinite, center.y.isFinite else { return false }
    let x = Int(center.x.rounded()), y = Int(center.y.rounded())
    guard x >= 2, y >= 2, x + 2 < width, y + 2 < height else { return false }
    var matches = 0
    for dy in -2...2 { for dx in -2...2 {
        let i = ((y + dy) * width + x + dx) * 4
        let differences = [abs(Int(pixels[i]) - Int(expected.0)), abs(Int(pixels[i + 1]) - Int(expected.1)), abs(Int(pixels[i + 2]) - Int(expected.2))]
        if differences.reduce(0, +) <= 24 && differences.max()! <= 12 { matches += 1 }
    } }
    return matches >= 20
}

/// Compare pixels near each dispatched path. This is evidence of changed pixels,
/// not proof that a particular tool or a semantically correct image was used.
func inspectPaint(before: [UInt8], after: [UInt8], width: Int, height: Int,
                  paths: [[CGPoint]], expected: (UInt8, UInt8, UInt8)) -> PaintInspection {
    guard width > 0, height > 0, before.count == width * height * 4,
          after.count == before.count, !paths.isEmpty else {
        return PaintInspection(matched: false, failedStrokes: Array(paths.indices))
    }
    func near(_ point: CGPoint, _ a: CGPoint, _ b: CGPoint) -> Bool {
        let dx = b.x - a.x, dy = b.y - a.y
        let length = dx * dx + dy * dy
        let t = length > 0 ? max(0, min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length)) : 0
        let x = point.x - (a.x + t * dx), y = point.y - (a.y + t * dy)
        return x * x + y * y <= 16
    }
    var failed: [Int] = []
    for (index, path) in paths.enumerated() {
        guard path.count >= 2, path.allSatisfy({ $0.x.isFinite && $0.y.isFinite && abs($0.x) < 10_000_000 && abs($0.y) < 10_000_000 }) else { failed.append(index); continue }
        var changed = 0, matches = 0
        var candidates = Set<Int>()
        var matchingPixels = Set<Int>()
        for (a, b) in zip(path, path.dropFirst()) {
            let minX = max(0, Int(floor(min(a.x, b.x) - 4)))
            let maxX = min(width - 1, Int(ceil(max(a.x, b.x) + 4)))
            let minY = max(0, Int(floor(min(a.y, b.y) - 4)))
            let maxY = min(height - 1, Int(ceil(max(a.y, b.y) + 4)))
            guard minX <= maxX, minY <= maxY else { continue }
            for y in minY...maxY { for x in minX...maxX {
                if near(CGPoint(x: x, y: y), a, b) { candidates.insert(y * width + x) }
            } }
        }
        for pixel in candidates {
                let i = pixel * 4
                let difference = (0..<3).reduce(0) { $0 + abs(Int(before[i + $1]) - Int(after[i + $1])) }
                if difference < 45 { continue }
                changed += 1
                let differences = [abs(Int(after[i]) - Int(expected.0)), abs(Int(after[i + 1]) - Int(expected.1)), abs(Int(after[i + 2]) - Int(expected.2))]
                var hueMatches = true
                if let expectedHue = paintHue(Int(expected.0), Int(expected.1), Int(expected.2)) {
                    if let actualHue = paintHue(Int(after[i]), Int(after[i + 1]), Int(after[i + 2])) {
                        let difference = abs(actualHue - expectedHue)
                        hueMatches = min(difference, 360 - difference) <= 12
                    } else { hueMatches = false }
                } else {
                    let actual = [Int(after[i]), Int(after[i + 1]), Int(after[i + 2])]
                    let expectedRange = Int(max(expected.0, max(expected.1, expected.2))) - Int(min(expected.0, min(expected.1, expected.2)))
                    hueMatches = actual.max()! - actual.min()! <= expectedRange + 20
                }
                if differences.reduce(0, +) <= 150 && differences.max()! <= 70 && hueMatches { matches += 1; matchingPixels.insert(pixel) }
        }
        var samples = 0, covered = 0, endpointsCovered = true
        for (segmentIndex, segment) in zip(path, path.dropFirst()).enumerated() {
            let (a, b) = segment
            let distance = hypot(b.x - a.x, b.y - a.y)
            let steps = max(2, min(2048, Int(ceil(distance / 8))))
            for step in 0...steps {
                let t = CGFloat(step) / CGFloat(steps)
                let x = Int((a.x + (b.x - a.x) * t).rounded())
                let y = Int((a.y + (b.y - a.y) * t).rounded())
                samples += 1
                var found = false
                for dy in -4...4 where !found {
                    for dx in -4...4 where dx * dx + dy * dy <= 16 {
                        let px = x + dx, py = y + dy
                        if px >= 0 && px < width && py >= 0 && py < height && matchingPixels.contains(py * width + px) { found = true; break }
                    }
                }
                if found { covered += 1 }
                if (segmentIndex == 0 && step == 0) || (segmentIndex == path.count - 2 && step == steps) {
                    endpointsCovered = endpointsCovered && found
                }
            }
        }
        if changed < 3 || matches < 3 || matches * 10 < changed * 3 || covered * 10 < samples * 9 || !endpointsCovered { failed.append(index) }
    }
    return PaintInspection(matched: failed.isEmpty, failedStrokes: failed)
}

struct BrushWidthInspection {
    let matched: Bool
    let measuredWidth: Double
}

/// Measure contiguous changed pixels across the middle of dispatched segments.
/// Existing marks or overlap can make width unobservable: fail closed rather
/// than infer the selected tool's width from the requested width.
func inspectBrushWidth(before: [UInt8], after: [UInt8], width: Int, height: Int,
                       paths: [[CGPoint]], expectedWidth: Double) -> BrushWidthInspection {
    let failed = BrushWidthInspection(matched: false, measuredWidth: 0)
    guard width > 0, height > 0, before.count == width * height * 4,
          after.count == before.count, expectedWidth.isFinite,
          expectedWidth > 0, expectedWidth <= 256 else { return failed }
    func changed(_ x: Int, _ y: Int) -> Bool {
        guard x >= 0, y >= 0, x < width, y < height else { return false }
        let i = (y * width + x) * 4
        return (0..<3).map { abs(Int(after[i + $0]) - Int(before[i + $0])) }.max()! >= 24
    }
    var measurements: [Double] = []
    let reach = min(384, max(8, Int(ceil(expectedWidth * 2 + 4))))
    for path in paths {
        // Measurement tangents need a few pixels of support even when the
        // dispatched path is densely sampled. Keep the original input intact.
        guard let first = path.first, let last = path.last else { continue }
        var measuringPath = [first]
        for p in path.dropFirst() {
            if hypot(p.x - measuringPath.last!.x, p.y - measuringPath.last!.y) >= 4 { measuringPath.append(p) }
        }
        if measuringPath.last! != last { measuringPath.append(last) }
        for (a, b) in zip(measuringPath, measuringPath.dropFirst()) {
            let dx = b.x - a.x, dy = b.y - a.y, length = hypot(dx, dy)
            guard length.isFinite, length >= 4 else { continue }
            for t in [0.3, 0.5, 0.7] {
                let center = CGPoint(x: a.x + dx * t, y: a.y + dy * t)
                var samples: [(Int, Bool)] = [], seen = Set<Int>()
                for step in -reach...reach {
                    let x = Int((center.x - dy / length * Double(step)).rounded())
                    let y = Int((center.y + dx / length * Double(step)).rounded())
                    guard x >= 0, x < width, y >= 0, y < height else { continue }
                    let key = y * width + x
                    if seen.insert(key).inserted { samples.append((step, changed(x, y))) }
                }
                guard let middle = samples.indices.min(by: { abs(samples[$0].0) < abs(samples[$1].0) }), samples[middle].1 else { continue }
                var low = middle, high = middle
                while low > 0 && samples[low - 1].1 { low -= 1 }
                while high + 1 < samples.count && samples[high + 1].1 { high += 1 }
                // A mark extending to our search boundary cannot establish width.
                if low == 0 || high == samples.count - 1 { return failed }
                measurements.append(Double(samples[high].0 - samples[low].0 + 1))
            }
        }
    }
    guard !measurements.isEmpty else { return failed }
    measurements.sort()
    let measured = measurements[measurements.count / 2]
    let tolerance = max(1.5, expectedWidth * 0.35)
    return BrushWidthInspection(matched: abs(measured - expectedWidth) <= tolerance, measuredWidth: measured)
}

/// Inspect changed pixels around this stroke, not just its centerline. Other
/// unchanged artwork is irrelevant. The region is supplied from visual review.
func inspectPaintRegion(before: [UInt8], after: [UInt8], width: Int, height: Int,
                        paths: [[CGPoint]], region: [CGPoint], expectedWidth: Double) -> Bool {
    guard width > 0, height > 0, before.count == width * height * 4,
          after.count == before.count, region.count >= 3, !paths.isEmpty,
          expectedWidth.isFinite, expectedWidth > 0, expectedWidth <= 256,
          (region + paths.flatMap { $0 }).allSatisfy({ $0.x.isFinite && $0.y.isFinite && abs($0.x) < 10_000_000 && abs($0.y) < 10_000_000 }) else { return false }
    func inside(_ p: CGPoint) -> Bool {
        var result = false
        var j = region.count - 1
        for i in region.indices {
            let a = region[i], b = region[j]
            if (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x { result.toggle() }
            j = i
        }
        return result
    }
    let points = paths.flatMap { $0 }
    guard let first = points.first else { return false }
    let padding = expectedWidth * 2 + 4
    let minX = max(0, Int(floor(points.map(\.x).min()! - padding)))
    let maxX = min(width - 1, Int(ceil(points.map(\.x).max()! + padding)))
    let minY = max(0, Int(floor(points.map(\.y).min()! - padding)))
    let maxY = min(height - 1, Int(ceil(points.map(\.y).max()! + padding)))
    guard inside(first), minX <= maxX, minY <= maxY else { return false }
    for y in minY...maxY { for x in minX...maxX {
        let i = (y * width + x) * 4
        if (0..<3).contains(where: { abs(Int(after[i + $0]) - Int(before[i + $0])) >= 24 }) &&
            !inside(CGPoint(x: Double(x) + 0.5, y: Double(y) + 0.5)) { return false }
    } }
    return true
}
