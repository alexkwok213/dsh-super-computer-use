import CoreGraphics
import Foundation
import ImageIO

// Image -> layered stroke plan.
//
// The plan is a deterministic posterization of the reference: colours are
// clustered (k-means), the border-connected background is removed, speckle is
// filtered, and every horizontal same-colour run becomes one brush stroke.
// Nothing here touches the screen; `cu drawplan` only reads a file and writes
// JSON (and optionally a preview PNG).

struct DrawPlanLayer {
    let label: Int
    let rgb: (Int, Int, Int)
    let hex: String
    let runs: [[Int]]

    var luminance: Double {
        0.299 * Double(rgb.0) + 0.587 * Double(rgb.1) + 0.114 * Double(rgb.2)
    }
}

enum DrawPlanError: Error, CustomStringConvertible {
    case imageUnreadable(String)
    case badGrid
    case badColors
    case emptyImage

    var description: String {
        switch self {
        case .imageUnreadable(let path): return "cannot decode image at \(path)"
        case .badGrid: return "grid must be between 24 and 400"
        case .badColors: return "colors must be between 2 and 24"
        case .emptyImage: return "image produced no drawable pixels"
        }
    }
}

private func isWhiteish(_ r: Int, _ g: Int, _ b: Int, _ a: Int) -> Bool {
    if a < 40 { return true }
    let mx = max(r, max(g, b))
    let mn = min(r, min(g, b))
    return mx > 238 && (mx - mn) < 10
}

private func hexString(_ r: Int, _ g: Int, _ b: Int) -> String {
    String(format: "#%02x%02x%02x", r, g, b)
}

/// Rasterize the image into a `grid x grid` RGBA buffer with a top-left origin.
private func rasterize(_ image: CGImage, grid: Int) -> [UInt8] {
    var buffer = [UInt8](repeating: 255, count: grid * grid * 4)
    let space = CGColorSpaceCreateDeviceRGB()
    buffer.withUnsafeMutableBytes { raw in
        guard let context = CGContext(
            data: raw.baseAddress,
            width: grid,
            height: grid,
            bitsPerComponent: 8,
            bytesPerRow: grid * 4,
            space: space,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: grid, height: grid))
    }
    return buffer
}

func buildDrawPlan(imagePath: String, grid: Int, colors: Int, seed: Int = 12345)
    throws -> (layers: [DrawPlanLayer], preview: [UInt8]) {
    guard grid >= 24 && grid <= 400 else { throw DrawPlanError.badGrid }
    guard colors >= 2 && colors <= 24 else { throw DrawPlanError.badColors }
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: imagePath) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw DrawPlanError.imageUnreadable(imagePath)
    }

    let n = grid
    let pixels = rasterize(image, grid: n)

    // 1. Remove the background connected to the border.
    var background = [Bool](repeating: false, count: n * n)
    var stack: [Int] = []
    stack.reserveCapacity(n * n / 4)
    func consider(_ p: Int) {
        if background[p] { return }
        let o = p * 4
        if isWhiteish(Int(pixels[o]), Int(pixels[o + 1]), Int(pixels[o + 2]), Int(pixels[o + 3])) {
            background[p] = true
            stack.append(p)
        }
    }
    for i in 0..<n {
        consider(i)
        consider((n - 1) * n + i)
    }
    for j in 0..<n {
        consider(j * n)
        consider(j * n + n - 1)
    }
    while let p = stack.popLast() {
        let j = p / n
        let i = p % n
        if j > 0 { consider(p - n) }
        if j < n - 1 { consider(p + n) }
        if i > 0 { consider(p - 1) }
        if i < n - 1 { consider(p + 1) }
    }

    // 2. K-means over the remaining pixels.
    var points: [(Int, Int, Int)] = []
    points.reserveCapacity(n * n)
    for p in 0..<(n * n) where !background[p] {
        let o = p * 4
        points.append((Int(pixels[o]), Int(pixels[o + 1]), Int(pixels[o + 2])))
    }
    guard points.count >= colors else { throw DrawPlanError.emptyImage }

    var state = Int64(seed)
    func nextRandom() -> Double {
        state = (state &* 1103515245 &+ 12345) & 0x7fffffff
        return Double(state) / Double(0x7fffffff)
    }

    var centroids: [(Double, Double, Double)] = []
    for _ in 0..<colors {
        let pick = points[Int(nextRandom() * Double(points.count)) % points.count]
        centroids.append((Double(pick.0), Double(pick.1), Double(pick.2)))
    }
    var labels = [Int](repeating: 0, count: points.count)
    for _ in 0..<24 {
        for (index, point) in points.enumerated() {
            var best = 0
            var bestDistance = Double.greatestFiniteMagnitude
            for (k, centroid) in centroids.enumerated() {
                let dr = Double(point.0) - centroid.0
                let dg = Double(point.1) - centroid.1
                let db = Double(point.2) - centroid.2
                let distance = dr * dr + dg * dg + db * db
                if distance < bestDistance {
                    bestDistance = distance
                    best = k
                }
            }
            labels[index] = best
        }
        var sums = [(Double, Double, Double, Double)](repeating: (0, 0, 0, 0), count: colors)
        for (index, point) in points.enumerated() {
            let k = labels[index]
            sums[k].0 += Double(point.0)
            sums[k].1 += Double(point.1)
            sums[k].2 += Double(point.2)
            sums[k].3 += 1
        }
        for k in 0..<colors where sums[k].3 > 0 {
            centroids[k] = (sums[k].0 / sums[k].3, sums[k].1 / sums[k].3, sums[k].2 / sums[k].3)
        }
    }

    var gridLabels = [Int](repeating: -1, count: n * n)
    var pointIndex = 0
    for p in 0..<(n * n) where !background[p] {
        gridLabels[p] = labels[pointIndex]
        pointIndex += 1
    }

    // 3. Two majority-filter passes to remove single-cell speckle.
    for _ in 0..<2 {
        var output = gridLabels
        for j in 1..<(n - 1) {
            for i in 1..<(n - 1) {
                let p = j * n + i
                if gridLabels[p] < 0 { continue }
                var counts = [Int](repeating: 0, count: colors)
                for dj in -1...1 {
                    for di in -1...1 {
                        let value = gridLabels[(j + dj) * n + (i + di)]
                        if value >= 0 { counts[value] += 1 }
                    }
                }
                var best = gridLabels[p]
                var bestCount = 0
                for k in 0..<colors where counts[k] > bestCount {
                    bestCount = counts[k]
                    best = k
                }
                output[p] = best
            }
        }
        gridLabels = output
    }

    // 4. Absorb one-cell horizontal islands into a neighbour.
    for j in 0..<n {
        var i = 0
        while i < n {
            let value = gridLabels[j * n + i]
            var k = i
            while k + 1 < n && gridLabels[j * n + (k + 1)] == value { k += 1 }
            if value >= 0 && k == i {
                let left = i > 0 ? gridLabels[j * n + i - 1] : -1
                let right = i + 1 < n ? gridLabels[j * n + i + 1] : -1
                if left >= 0 { gridLabels[j * n + i] = left }
                else if right >= 0 { gridLabels[j * n + i] = right }
            }
            i = k + 1
        }
    }

    // 5. Absorb thin near-white streaks (the gloss highlight artefact).
    var whiteLabel = 0
    var whiteDistance = Double.greatestFiniteMagnitude
    for (k, centroid) in centroids.enumerated() {
        let dr = centroid.0 - 251
        let dg = centroid.1 - 244
        let db = centroid.2 - 246
        let distance = dr * dr + dg * dg + db * db
        if distance < whiteDistance {
            whiteDistance = distance
            whiteLabel = k
        }
    }
    for _ in 0..<2 {
        var output = gridLabels
        for j in 1..<(n - 1) {
            var i = 0
            while i < n {
                if gridLabels[j * n + i] != whiteLabel {
                    i += 1
                    continue
                }
                var k = i
                while k + 1 < n && gridLabels[j * n + (k + 1)] == whiteLabel { k += 1 }
                let length = k - i + 1
                var above = 0
                var below = 0
                for t in i...k {
                    let a = gridLabels[(j - 1) * n + t]
                    let b = gridLabels[(j + 1) * n + t]
                    if a >= 0 && a != whiteLabel { above += 1 }
                    if b >= 0 && b != whiteLabel { below += 1 }
                }
                if length >= 4 && above + below > length {
                    for t in i...k {
                        let a = gridLabels[(j - 1) * n + t]
                        let b = gridLabels[(j + 1) * n + t]
                        let value = (a >= 0 && a != whiteLabel) ? a : ((b >= 0 && b != whiteLabel) ? b : whiteLabel)
                        if value != whiteLabel { output[j * n + t] = value }
                    }
                }
                i = k + 1
            }
        }
        gridLabels = output
    }

    // 6. Horizontal runs per colour.
    var runs = [[[Int]]](repeating: [], count: colors)
    for j in 0..<n {
        var i = 0
        while i < n {
            let value = gridLabels[j * n + i]
            var k = i
            while k + 1 < n && gridLabels[j * n + (k + 1)] == value { k += 1 }
            if value >= 0 { runs[value].append([i, j, k]) }
            i = k + 1
        }
    }

    var layers: [DrawPlanLayer] = []
    for k in 0..<colors {
        let centroid = centroids[k]
        let r = Int(centroid.0.rounded())
        let g = Int(centroid.1.rounded())
        let b = Int(centroid.2.rounded())
        layers.append(DrawPlanLayer(label: k, rgb: (r, g, b), hex: hexString(r, g, b), runs: runs[k]))
    }

    // Posterized preview, same grid, top-left origin.
    var preview = [UInt8](repeating: 255, count: n * n * 4)
    for p in 0..<(n * n) {
        let value = gridLabels[p]
        let o = p * 4
        if value < 0 {
            preview[o] = 255
            preview[o + 1] = 255
            preview[o + 2] = 255
            preview[o + 3] = 255
        } else {
            let rgb = layers[value].rgb
            preview[o] = UInt8(clamping: rgb.0)
            preview[o + 1] = UInt8(clamping: rgb.1)
            preview[o + 2] = UInt8(clamping: rgb.2)
            preview[o + 3] = 255
        }
    }

    return (layers, preview)
}

func writePreviewPNG(_ pixels: [UInt8], grid: Int, to path: String) throws {
    let space = CGColorSpaceCreateDeviceRGB()
    guard let provider = CGDataProvider(data: Data(pixels) as CFData),
          let image = CGImage(
            width: grid,
            height: grid,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: grid * 4,
            space: space,
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent
          ) else {
        throw DrawPlanError.emptyImage
    }
    let url = URL(fileURLWithPath: path) as CFURL
    guard let destination = CGImageDestinationCreateWithURL(url, "public.png" as CFString, 1, nil) else {
        throw DrawPlanError.emptyImage
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw DrawPlanError.emptyImage }
}
