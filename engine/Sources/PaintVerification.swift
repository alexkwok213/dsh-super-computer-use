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
