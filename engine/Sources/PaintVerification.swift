import Foundation
import CoreGraphics
import CryptoKit
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

private func matchesExpectedColor(_ r: Int, _ g: Int, _ b: Int, _ expected: (UInt8, UInt8, UInt8)) -> Bool {
    let differences = [abs(r - Int(expected.0)), abs(g - Int(expected.1)), abs(b - Int(expected.2))]
    var hueMatches = true
    if let expectedHue = paintHue(Int(expected.0), Int(expected.1), Int(expected.2)) {
        if let actualHue = paintHue(r, g, b) {
            let difference = abs(actualHue - expectedHue)
            hueMatches = min(difference, 360 - difference) <= 12
        } else { hueMatches = false }
    } else {
        let actual = [r, g, b]
        let expectedRange = Int(max(expected.0, max(expected.1, expected.2))) - Int(min(expected.0, min(expected.1, expected.2)))
        hueMatches = actual.max()! - actual.min()! <= expectedRange + 20
    }
    return differences.reduce(0, +) <= 150 && differences.max()! <= 70 && hueMatches
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
    let expectedNearWhite = expected.0 >= 245 && expected.1 >= 245 && expected.2 >= 245
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
            if matchesExpectedColor(Int(after[i]), Int(after[i + 1]), Int(after[i + 2]), expected) {
                matches += 1; matchingPixels.insert(pixel)
            }
        }
        var samples = 0, covered = 0, overlapCovered = 0, endpointsCovered = true
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
                var preMatched = false
                for dy in -4...4 where !found {
                    for dx in -4...4 where dx * dx + dy * dy <= 16 {
                        let px = x + dx, py = y + dy
                        guard px >= 0 && px < width && py >= 0 && py < height else { continue }
                        let key = py * width + px
                        if matchingPixels.contains(key) { found = true; break }
                        if !preMatched && !expectedNearWhite {
                            let i = key * 4
                            if matchesExpectedColor(Int(after[i]), Int(after[i + 1]), Int(after[i + 2]), expected) &&
                               matchesExpectedColor(Int(before[i]), Int(before[i + 1]), Int(before[i + 2]), expected) {
                                preMatched = true
                            }
                        }
                    }
                }
                if found { covered += 1 }
                else if preMatched { overlapCovered += 1 }
                if (segmentIndex == 0 && step == 0) || (segmentIndex == path.count - 2 && step == steps) {
                    endpointsCovered = endpointsCovered && (found || preMatched)
                }
            }
        }
        if changed < 3 || matches < 3 || covered < 1 || matches * 10 < changed * 3 ||
           (covered + overlapCovered) * 10 < samples * 9 || !endpointsCovered { failed.append(index) }
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

private func pointInPolygon(_ p: CGPoint, _ polygon: [CGPoint]) -> Bool {
    guard polygon.count >= 3 else { return false }
    var result = false
    var j = polygon.count - 1
    for i in polygon.indices {
        let a = polygon[i], b = polygon[j]
        if (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x { result.toggle() }
        j = i
    }
    return result
}

/// Inspect changed pixels around this stroke, not just its centerline. Other
/// unchanged artwork is irrelevant. The region is supplied from visual review.
func inspectPaintRegion(before: [UInt8], after: [UInt8], width: Int, height: Int,
                        paths: [[CGPoint]], region: [CGPoint], expectedWidth: Double) -> Bool {
    guard width > 0, height > 0, before.count == width * height * 4,
          after.count == before.count, region.count >= 3, !paths.isEmpty,
          expectedWidth.isFinite, expectedWidth > 0, expectedWidth <= 256,
          (region + paths.flatMap { $0 }).allSatisfy({ $0.x.isFinite && $0.y.isFinite && abs($0.x) < 10_000_000 && abs($0.y) < 10_000_000 }) else { return false }
    let points = paths.flatMap { $0 }
    guard let first = points.first else { return false }
    let padding = expectedWidth * 2 + 4
    let minX = max(0, Int(floor(points.map(\.x).min()! - padding)))
    let maxX = min(width - 1, Int(ceil(points.map(\.x).max()! + padding)))
    let minY = max(0, Int(floor(points.map(\.y).min()! - padding)))
    let maxY = min(height - 1, Int(ceil(points.map(\.y).max()! + padding)))
    guard pointInPolygon(first, region), minX <= maxX, minY <= maxY else { return false }
    for y in minY...maxY { for x in minX...maxX {
        let i = (y * width + x) * 4
        if (0..<3).contains(where: { abs(Int(after[i + $0]) - Int(before[i + $0])) >= 24 }) &&
            !pointInPolygon(CGPoint(x: Double(x) + 0.5, y: Double(y) + 0.5), region) { return false }
    } }
    return true
}

/// Verify that closed paths painted with Freeform's Fill tool actually filled
/// their interior with the expected color rather than leaving only an outline.
func inspectFillInterior(before: [UInt8], after: [UInt8], width: Int, height: Int,
                         paths: [[CGPoint]], expected: (UInt8, UInt8, UInt8),
                         aggregate: Bool = false) -> Bool {
    guard width > 0, height > 0, before.count == width * height * 4,
          after.count == before.count, !paths.isEmpty else { return false }
    let expectedNearWhite = expected.0 >= 245 && expected.1 >= 245 && expected.2 >= 245
    var totalInterior = 0
    var totalMatchedAfter = 0
    var totalChangedMatched = 0
    var totalPreMatched = 0
    var totalExpectedWeighted = 0
    for path in paths {
        guard path.count >= 3,
              path.allSatisfy({ $0.x.isFinite && $0.y.isFinite && abs($0.x) < 10_000_000 && abs($0.y) < 10_000_000 }) else { return false }
        let minX = max(0, Int(floor(path.map(\.x).min()!)))
        let maxX = min(width - 1, Int(ceil(path.map(\.x).max()!)))
        let minY = max(0, Int(floor(path.map(\.y).min()!)))
        let maxY = min(height - 1, Int(ceil(path.map(\.y).max()!)))
        guard minX <= maxX, minY <= maxY else { return false }
        let strideX = max(1, (maxX - minX + 1) / 14)
        let strideY = max(1, (maxY - minY + 1) / 14)
        var interiorCount = 0, matchedAfter = 0, changedMatched = 0, preMatched = 0
        var seen = Set<Int>()
        func sample(_ x: Int, _ y: Int) {
            guard x >= 0, x < width, y >= 0, y < height else { return }
            let key = y * width + x
            guard seen.insert(key).inserted else { return }
            guard pointInPolygon(CGPoint(x: Double(x) + 0.5, y: Double(y) + 0.5), path) else { return }
            interiorCount += 1
            let i = key * 4
            guard matchesExpectedColor(Int(after[i]), Int(after[i + 1]), Int(after[i + 2]), expected) else { return }
            matchedAfter += 1
            let diff = (0..<3).reduce(0) { $0 + abs(Int(before[i + $1]) - Int(after[i + $1])) }
            if diff >= 36 {
                changedMatched += 1
            } else if !expectedNearWhite && matchesExpectedColor(Int(before[i]), Int(before[i + 1]), Int(before[i + 2]), expected) {
                preMatched += 1
            }
        }
        let cx = Int((path.map(\.x).reduce(0, +) / Double(path.count)).rounded())
        let cy = Int((path.map(\.y).reduce(0, +) / Double(path.count)).rounded())
        sample(cx, cy)
        var y = minY
        while y <= maxY {
            var x = minX
            while x <= maxX {
                sample(x, y)
                x += strideX
            }
            y += strideY
        }
        let minSpan = min(maxX - minX + 1, maxY - minY + 1)
        let minNumerator = aggregate ? (minSpan < 24 ? 3 : (minSpan < 56 ? 4 : 6)) : 7
        let minPreNumerator = aggregate ? 5 : 7
        guard interiorCount >= 3,
              matchedAfter * 10 >= interiorCount * minNumerator,
              changedMatched >= 1 || (!expectedNearWhite && preMatched * 10 >= interiorCount * minPreNumerator) else {
            return false
        }
        totalInterior += interiorCount
        totalMatchedAfter += matchedAfter
        totalChangedMatched += changedMatched
        totalPreMatched += preMatched
        totalExpectedWeighted += interiorCount * (minSpan < 56 ? 5 : 7)
    }
    if aggregate {
        guard totalInterior > 0,
              totalMatchedAfter * 10 >= totalExpectedWeighted,
              totalChangedMatched >= 1 || (!expectedNearWhite && totalPreMatched * 10 >= totalInterior * 7) else {
            return false
        }
    }
    return true
}

/// Aggregate verification for multi-stroke batches where adjacent or layered
/// strokes intentionally touch, blend or overlap inside paintRegion.
struct AggregatePaintInspection {
    let matched: Bool
    let changedPixels: Int
    let matchedPixels: Int
    let totalSamples: Int
    let coveredSamples: Int
}

func inspectAggregatePaint(before: [UInt8], after: [UInt8], width: Int, height: Int,
                           paths: [[CGPoint]], expected: (UInt8, UInt8, UInt8),
                           brushRadius: Double = 4) -> AggregatePaintInspection {
    let failed = AggregatePaintInspection(matched: false, changedPixels: 0, matchedPixels: 0, totalSamples: 0, coveredSamples: 0)
    guard width > 0, height > 0, before.count == width * height * 4,
          after.count == before.count, !paths.isEmpty else { return failed }
    guard paths.allSatisfy({ $0.count >= 2 && $0.allSatisfy({ $0.x.isFinite && $0.y.isFinite && abs($0.x) < 10_000_000 && abs($0.y) < 10_000_000 }) }) else {
        return failed
    }
    let radius = max(4.0, min(32.0, brushRadius + 2.5))
    let radiusSq = radius * radius
    let pad = Int(ceil(radius)) + 1
    let allPts = paths.flatMap { $0 }
    let boxMinX = max(0, Int(floor(allPts.map(\.x).min()!)) - pad)
    let boxMaxX = min(width - 1, Int(ceil(allPts.map(\.x).max()!)) + pad)
    let boxMinY = max(0, Int(floor(allPts.map(\.y).min()!)) - pad)
    let boxMaxY = min(height - 1, Int(ceil(allPts.map(\.y).max()!)) + pad)
    guard boxMinX <= boxMaxX, boxMinY <= boxMaxY else { return failed }

    let boxW = boxMaxX - boxMinX + 1
    let boxH = boxMaxY - boxMinY + 1
    // State: 0 = ignored, 1 = stroke neighborhood candidate, 2 = changed & matched expected color
    var mask = [UInt8](repeating: 0, count: boxW * boxH)

    for path in paths {
        for (a, b) in zip(path, path.dropFirst()) {
            let sMinX = max(boxMinX, Int(floor(min(a.x, b.x) - radius)))
            let sMaxX = min(boxMaxX, Int(ceil(max(a.x, b.x) + radius)))
            let sMinY = max(boxMinY, Int(floor(min(a.y, b.y) - radius)))
            let sMaxY = min(boxMaxY, Int(ceil(max(a.y, b.y) + radius)))
            guard sMinX <= sMaxX, sMinY <= sMaxY else { continue }
            let dx = b.x - a.x, dy = b.y - a.y
            let segLenSq = dx * dx + dy * dy
            for y in sMinY...sMaxY {
                let rowOff = (y - boxMinY) * boxW - boxMinX
                let py = Double(y)
                for x in sMinX...sMaxX {
                    let px = Double(x)
                    let t = segLenSq > 0 ? max(0, min(1, ((px - a.x) * dx + (py - a.y) * dy) / segLenSq)) : 0
                    let rx = px - (a.x + t * dx), ry = py - (a.y + t * dy)
                    if rx * rx + ry * ry <= radiusSq { mask[rowOff + x] = 1 }
                }
            }
        }
    }

    var changed = 0, matches = 0
    for ly in 0..<boxH {
        let wy = boxMinY + ly
        for lx in 0..<boxW {
            let mIdx = ly * boxW + lx
            if mask[mIdx] == 0 { continue }
            let i = (wy * width + (boxMinX + lx)) * 4
            let diff = abs(Int(before[i]) - Int(after[i])) + abs(Int(before[i + 1]) - Int(after[i + 1])) + abs(Int(before[i + 2]) - Int(after[i + 2]))
            if diff < 36 { continue }
            changed += 1
            if matchesExpectedColor(Int(after[i]), Int(after[i + 1]), Int(after[i + 2]), expected) {
                matches += 1
                mask[mIdx] = 2
            }
        }
    }

    let expectedNearWhite = expected.0 >= 245 && expected.1 >= 245 && expected.2 >= 245
    let searchR = Int(ceil(radius))
    let spacing = max(6.0, min(12.0, radius * 1.5))
    var samples = 0, covered = 0, overlapCovered = 0
    for path in paths {
        for (a, b) in zip(path, path.dropFirst()) {
            let dist = hypot(b.x - a.x, b.y - a.y)
            let steps = max(1, min(1024, Int(ceil(dist / spacing))))
            for step in 0...steps {
                let t = CGFloat(step) / CGFloat(steps)
                let sx = Int((a.x + (b.x - a.x) * t).rounded())
                let sy = Int((a.y + (b.y - a.y) * t).rounded())
                samples += 1
                var foundNew = false
                var preMatched = false
                let y0 = max(boxMinY, sy - searchR), y1 = min(boxMaxY, sy + searchR)
                let x0 = max(boxMinX, sx - searchR), x1 = min(boxMaxX, sx + searchR)
                if x0 <= x1 && y0 <= y1 {
                    for py in y0...y1 where !foundNew {
                        let dy = py - sy
                        for px in x0...x1 {
                            let dx = px - sx
                            if Double(dx * dx + dy * dy) > radiusSq { continue }
                            if mask[(py - boxMinY) * boxW + (px - boxMinX)] == 2 {
                                foundNew = true; break
                            }
                            if !preMatched {
                                let i = (py * width + px) * 4
                                if matchesExpectedColor(Int(after[i]), Int(after[i + 1]), Int(after[i + 2]), expected) &&
                                   matchesExpectedColor(Int(before[i]), Int(before[i + 1]), Int(before[i + 2]), expected) {
                                    preMatched = true
                                }
                            }
                        }
                    }
                }
                if foundNew { covered += 1 }
                else if preMatched { overlapCovered += 1 }
            }
        }
    }

    let minChanges = max(3, min(paths.count, 8))
    let whiteOverlapGuard = !expectedNearWhite || covered * 10 >= samples * 2
    let ok = samples >= 1 && changed >= minChanges && matches >= minChanges && covered >= 1 &&
        whiteOverlapGuard && matches * 10 >= changed * 3 && (covered + overlapCovered) * 10 >= samples * 7
    return AggregatePaintInspection(matched: ok, changedPixels: changed, matchedPixels: matches,
                                    totalSamples: samples, coveredSamples: covered + overlapCovered)
}

/// Hash already-decoded RGBA pixels of the interior canvas region.
func canvasInteriorHashPixels(pixels: [UInt8], width: Int, height: Int,
                              insetLeft: Int, insetTop: Int,
                              insetRight: Int, insetBottom: Int) -> String? {
    guard width > 0, height > 0, pixels.count == width * height * 4 else { return nil }
    let x0 = max(0, min(width, insetLeft))
    let x1 = max(x0, width - max(0, insetRight))
    let y0 = max(0, min(height, insetTop))
    let y1 = max(y0, height - max(0, insetBottom))
    guard x1 > x0, y1 > y0 else { return nil }
    var hasher = SHA256()
    let dims = [UInt32(x1 - x0).littleEndian, UInt32(y1 - y0).littleEndian]
    dims.withUnsafeBytes { hasher.update(data: Data($0)) }
    pixels.withUnsafeBytes { raw in
        guard let base = raw.baseAddress else { return }
        let rowBytes = (x1 - x0) * 4
        for y in y0..<y1 {
            let offset = (y * width + x0) * 4
            hasher.update(bufferPointer: UnsafeRawBufferPointer(start: base.advanced(by: offset), count: rowBytes))
        }
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}

/// Hash decoded RGBA pixels of the interior canvas region, excluding outer
/// toolbars and auto-hiding scrollbars so UI chrome fades don't look like
/// canvas changes.
func canvasInteriorHash(imagePath: String, insetLeft: Int, insetTop: Int,
                        insetRight: Int, insetBottom: Int) -> String? {
    guard let image = paintImagePixels(imagePath) else { return nil }
    return canvasInteriorHashPixels(pixels: image.pixels, width: image.width, height: image.height,
                                    insetLeft: insetLeft, insetTop: insetTop,
                                    insetRight: insetRight, insetBottom: insetBottom)
}
