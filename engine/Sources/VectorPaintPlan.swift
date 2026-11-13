import Foundation
import CoreGraphics
import ImageIO

enum VectorPlanError: Error, CustomStringConvertible {
    case unreadableImage(String)
    case emptyImage
    case invalidPalette(Int)
    case invalidGrid(Int)
    case writeFailed(String)

    var description: String {
        switch self {
        case .unreadableImage(let path): return "cannot open \(path)"
        case .emptyImage: return "image is empty"
        case .invalidPalette(let count): return "colors must be 2...32, got \(count)"
        case .invalidGrid(let grid): return "grid must be 24...512, got \(grid)"
        case .writeFailed(let detail): return detail
        }
    }
}

struct VectorStrokeBatch {
    let index: Int
    let role: String
    let tool: String
    let brushWidthName: String
    let brushWidth: Double
    let rgb: (Int, Int, Int)
    let hex: String
    let strokes: [[[Double]]]
}

struct VectorPaintPlanResult {
    let grid: Int
    let colors: Int
    let rect: CGRect
    let palette: [(hex: String, rgb: (Int, Int, Int), pixels: Int)]
    let batches: [VectorStrokeBatch]
    let previewRGBA: [UInt8]
    let totalStrokes: Int
}

private func vecHex(_ r: Int, _ g: Int, _ b: Int) -> String {
    String(format: "#%02x%02x%02x", max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b)))
}

private func vecLuma(_ r: Int, _ g: Int, _ b: Int) -> Double {
    0.299 * Double(r) + 0.587 * Double(g) + 0.114 * Double(b)
}

private func rgbDistSq(_ a: (Int, Int, Int), _ b: (Int, Int, Int)) -> Double {
    let dr = Double(a.0 - b.0), dg = Double(a.1 - b.1), db = Double(a.2 - b.2)
    return 2.0 * dr * dr + 4.0 * dg * dg + 1.5 * db * db
}

private func euclideanRGBDist(_ a: (Int, Int, Int), _ b: (Int, Int, Int)) -> Double {
    let dr = Double(a.0 - b.0), dg = Double(a.1 - b.1), db = Double(a.2 - b.2)
    return sqrt(dr * dr + dg * dg + db * db)
}

private func loadSampledRGBA(imagePath: String, grid n: Int) throws -> [(r: Int, g: Int, b: Int, a: Int)] {
    let url = URL(fileURLWithPath: imagePath) as CFURL
    guard let source = CGImageSourceCreateWithURL(url, nil),
          let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw VectorPlanError.unreadableImage(imagePath)
    }
    guard cgImage.width > 0, cgImage.height > 0 else {
        throw VectorPlanError.emptyImage
    }
    var raw = [UInt8](repeating: 0, count: n * n * 4)
    let cs = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
    let drawn = raw.withUnsafeMutableBytes { ptr -> Bool in
        guard let ctx = CGContext(
            data: ptr.baseAddress, width: n, height: n,
            bitsPerComponent: 8, bytesPerRow: n * 4, space: cs, bitmapInfo: bitmapInfo.rawValue
        ) else { return false }
        ctx.interpolationQuality = .high
        ctx.clear(CGRect(x: 0, y: 0, width: n, height: n))
        ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: n, height: n))
        return true
    }
    guard drawn else { throw VectorPlanError.emptyImage }
    var pixels: [(Int, Int, Int, Int)] = []
    pixels.reserveCapacity(n * n)
    for i in 0..<(n * n) {
        let o = i * 4
        let a = Int(raw[o + 3])
        if a > 0 && a < 255 {
            let r = min(255, (Int(raw[o]) * 255 + a / 2) / a)
            let g = min(255, (Int(raw[o + 1]) * 255 + a / 2) / a)
            let b = min(255, (Int(raw[o + 2]) * 255 + a / 2) / a)
            pixels.append((r, g, b, a))
        } else {
            pixels.append((Int(raw[o]), Int(raw[o + 1]), Int(raw[o + 2]), a))
        }
    }
    return pixels
}

private func detectBackgroundMask(pixels: [(r: Int, g: Int, b: Int, a: Int)], grid n: Int, bgMode: String) -> [Bool] {
    var bg = [Bool](repeating: false, count: n * n)
    var transparentCount = 0
    for i in 0..<(n * n) where pixels[i].a < 128 {
        bg[i] = true
        transparentCount += 1
    }
    if bgMode == "none" { return bg }
    if transparentCount > (n * n) / 10 && bgMode == "auto" {
        return bg
    }

    let corners = [(0, 0), (n - 1, 0), (0, n - 1), (n - 1, n - 1)]
    var queue: [(Int, (Int, Int, Int))] = []
    for (cx, cy) in corners {
        let p = cy * n + cx
        if bg[p] { continue }
        let px = pixels[p]
        let rgb = (px.r, px.g, px.b)
        if bgMode == "white" {
            if rgb.0 >= 235 && rgb.1 >= 235 && rgb.2 >= 235 {
                bg[p] = true; queue.append((p, rgb))
            }
        } else if bgMode == "black" {
            if rgb.0 <= 35 && rgb.1 <= 35 && rgb.2 <= 35 {
                bg[p] = true; queue.append((p, rgb))
            }
        } else {
            let matchesAnother = corners.contains { (ox, oy) in
                guard !(ox == cx && oy == cy) else { return false }
                let op = pixels[oy * n + ox]
                return euclideanRGBDist(rgb, (op.r, op.g, op.b)) <= 36
            }
            if matchesAnother {
                bg[p] = true; queue.append((p, rgb))
            }
        }
    }

    var head = 0
    let dirs = [(-1, 0), (1, 0), (0, -1), (0, 1)]
    while head < queue.count {
        let (p, seedColor) = queue[head]
        head += 1
        let x = p % n, y = p / n
        for (dx, dy) in dirs {
            let nx = x + dx, ny = y + dy
            if nx < 0 || nx >= n || ny < 0 || ny >= n { continue }
            let np = ny * n + nx
            if bg[np] { continue }
            let px = pixels[np]
            if euclideanRGBDist((px.r, px.g, px.b), seedColor) <= 34 {
                bg[np] = true
                queue.append((np, seedColor))
            }
        }
    }
    return bg
}

private func extractThinInkMask(
    pixels: [(r: Int, g: Int, b: Int, a: Int)],
    bg: [Bool],
    grid n: Int
) -> (thinInk: [Bool], luma: [Double]) {
    let total = n * n
    var luma = [Double](repeating: 255, count: total)
    var chroma = [Int](repeating: 0, count: total)
    var isDark = [Bool](repeating: false, count: total)

    for p in 0..<total {
        let px = pixels[p]
        let y = vecLuma(px.r, px.g, px.b)
        let c = max(px.r, max(px.g, px.b)) - min(px.r, min(px.g, px.b))
        luma[p] = y
        chroma[p] = c
        if !bg[p] && y < 82 && c < 58 {
            isDark[p] = true
        }
    }

    // Distance transform on dark pixels to separate wide bulk fills from thin ink strokes.
    var dist = [Double](repeating: 0, count: total)
    for p in 0..<total where isDark[p] { dist[p] = 1e6 }
    for y in 0..<n {
        for x in 0..<n {
            let p = y * n + x
            if !isDark[p] { continue }
            var d = dist[p]
            if x > 0 { d = min(d, dist[p - 1] + 1.0) }
            if y > 0 { d = min(d, dist[p - n] + 1.0) }
            if x > 0 && y > 0 { d = min(d, dist[p - n - 1] + 1.414) }
            if x + 1 < n && y > 0 { d = min(d, dist[p - n + 1] + 1.414) }
            dist[p] = d
        }
    }
    for y in stride(from: n - 1, through: 0, by: -1) {
        for x in stride(from: n - 1, through: 0, by: -1) {
            let p = y * n + x
            if !isDark[p] { continue }
            var d = dist[p]
            if x + 1 < n { d = min(d, dist[p + 1] + 1.0) }
            if y + 1 < n { d = min(d, dist[p + n] + 1.0) }
            if x + 1 < n && y + 1 < n { d = min(d, dist[p + n + 1] + 1.414) }
            if x > 0 && y + 1 < n { d = min(d, dist[p + n - 1] + 1.414) }
            dist[p] = d
        }
    }

    // Core threshold scales mildly with resolution; thin ink half-width stays <= ~4 cells.
    let bulkThreshold = max(3.6, min(5.2, Double(n) * 0.0135))
    var bulkDark = [Bool](repeating: false, count: total)
    var bfs: [(Int, Int)] = []
    for p in 0..<total where isDark[p] && dist[p] > bulkThreshold {
        bulkDark[p] = true
        bfs.append((p, 0))
    }
    var head = 0
    let stepLimit = Int(ceil(bulkThreshold))
    while head < bfs.count {
        let (p, steps) = bfs[head]
        head += 1
        if steps >= stepLimit { continue }
        let x = p % n, y = p / n
        for (dx, dy) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
            let nx = x + dx, ny = y + dy
            if nx < 0 || nx >= n || ny < 0 || ny >= n { continue }
            let np = ny * n + nx
            if isDark[np] && !bulkDark[np] {
                bulkDark[np] = true
                bfs.append((np, steps + 1))
            }
        }
    }

    // Measure background luminance so anti-aliasing transition pixels against a dark
    // removed backdrop (e.g. sticker border on black) don't turn into dashed outer ink noise.
    var bgLumaSum = 0.0
    var bgCount = 0
    for p in 0..<total where bg[p] {
        bgLumaSum += luma[p]
        bgCount += 1
    }
    let darkBg = bgCount > 0 && (bgLumaSum / Double(bgCount)) < 85.0
    var nearDarkBg = [Bool](repeating: false, count: total)
    if darkBg {
        for y in 0..<n {
            for x in 0..<n where !bg[y * n + x] {
                var touchesBg = (y <= 1 || y >= n - 2 || x <= 1 || x >= n - 2)
                for dy in -2...2 where !touchesBg {
                    for dx in -2...2 {
                        let nx = x + dx, ny = y + dy
                        if nx >= 0 && nx < n && ny >= 0 && ny < n && bg[ny * n + nx] {
                            touchesBg = true; break
                        }
                    }
                }
                nearDarkBg[y * n + x] = touchesBg
            }
        }
    }

    // Valley detector captures narrow interior dark lines (lashes, folds, strand seams)
    // slightly lighter than pure black due to antialiasing.
    var valley = [Bool](repeating: false, count: total)
    for y in 0..<n {
        for x in 0..<n {
            let p = y * n + x
            if bg[p] || bulkDark[p] || nearDarkBg[p] { continue }
            if luma[p] >= 112 || chroma[p] >= 75 { continue }
            var localBright = 0.0
            let y0 = max(0, y - 3), y1 = min(n - 1, y + 3)
            let x0 = max(0, x - 3), x1 = min(n - 1, x + 3)
            for yy in y0...y1 {
                for xx in x0...x1 {
                    let np = yy * n + xx
                    if !bg[np] { localBright = max(localBright, luma[np]) }
                }
            }
            if localBright >= 132 && localBright - luma[p] >= 56 { valley[p] = true }
        }
    }

    var thinInk = [Bool](repeating: false, count: total)
    for p in 0..<total {
        thinInk[p] = !nearDarkBg[p] && ((isDark[p] && !bulkDark[p]) || valley[p])
    }

    // Prune isolated ink dust (< 5 pixels) so minor dithering doesn't spawn micro-dots.
    var inkSeen = [Bool](repeating: false, count: total)
    for p in 0..<total where thinInk[p] && !inkSeen[p] {
        var comp = [p]
        inkSeen[p] = true
        var h = 0
        while h < comp.count {
            let cur = comp[h]; h += 1
            let cx = cur % n, cy = cur / n
            for dy in -1...1 {
                for dx in -1...1 where !(dx == 0 && dy == 0) {
                    let nx = cx + dx, ny = cy + dy
                    if nx >= 0 && nx < n && ny >= 0 && ny < n {
                        let np = ny * n + nx
                        if thinInk[np] && !inkSeen[np] {
                            inkSeen[np] = true; comp.append(np)
                        }
                    }
                }
            }
        }
        if comp.count < 5 {
            for np in comp { thinInk[np] = false }
        }
    }
    return (thinInk, luma)
}

private func pruneSkeletonSpurs(_ skel: inout [Bool], grid n: Int, maxSpurSteps: Int = 3) {
    let dirList = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]
    func neighbors(of p: Int) -> [Int] {
        let x = p % n, y = p / n
        var out: [Int] = []
        for (dx, dy) in dirList {
            let nx = x + dx, ny = y + dy
            if nx >= 0 && nx < n && ny >= 0 && ny < n {
                let np = ny * n + nx
                if skel[np] { out.append(np) }
            }
        }
        return out
    }
    let endpoints = (0..<(n * n)).filter { skel[$0] && neighbors(of: $0).count == 1 }
    for ep in endpoints where skel[ep] {
        var branch: [Int] = [ep]
        var prev = -1
        var cur = ep
        var hitsJunction = false
        for _ in 0..<maxSpurSteps {
            let nbs = neighbors(of: cur).filter { $0 != prev }
            if nbs.isEmpty { break }
            if nbs.count >= 2 { hitsJunction = true; break }
            let next = nbs[0]
            let nextNbs = neighbors(of: next)
            if nextNbs.count >= 3 { hitsJunction = true; break }
            branch.append(next)
            prev = cur; cur = next
        }
        if hitsJunction {
            for p in branch { skel[p] = false }
        }
    }
}

private func zhangSuenThin(_ input: [Bool], grid n: Int) -> [Bool] {
    var img = input
    func at(_ x: Int, _ y: Int) -> Int {
        (x >= 0 && x < n && y >= 0 && y < n && img[y * n + x]) ? 1 : 0
    }
    var changed = true
    var passCount = 0
    while changed && passCount < 32 {
        changed = false
        passCount += 1
        for sub in 0...1 {
            var toClear: [Int] = []
            for y in 1..<(n - 1) {
                for x in 1..<(n - 1) {
                    let p = y * n + x
                    if !img[p] { continue }
                    let p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y)
                    let p5 = at(x + 1, y + 1), p6 = at(x, y + 1), p7 = at(x - 1, y + 1)
                    let p8 = at(x - 1, y), p9 = at(x - 1, y - 1)
                    let neighbors = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
                    if neighbors < 2 || neighbors > 6 { continue }
                    let ring = [p2, p3, p4, p5, p6, p7, p8, p9, p2]
                    var transitions = 0
                    for k in 0..<8 where ring[k] == 0 && ring[k + 1] == 1 { transitions += 1 }
                    if transitions != 1 { continue }
                    if sub == 0 {
                        if p2 * p4 * p6 != 0 || p4 * p6 * p8 != 0 { continue }
                    } else {
                        if p2 * p4 * p8 != 0 || p2 * p6 * p8 != 0 { continue }
                    }
                    toClear.append(p)
                }
            }
            if !toClear.isEmpty {
                changed = true
                for p in toClear { img[p] = false }
            }
        }
    }
    return img
}

private func rdpOpen(_ points: [CGPoint], epsilon: CGFloat) -> [CGPoint] {
    guard points.count > 2 else { return points }
    let first = points[0], last = points[points.count - 1]
    let dx = last.x - first.x, dy = last.y - first.y
    let lenSq = dx * dx + dy * dy
    var maxDist: CGFloat = 0
    var maxIdx = 0
    for i in 1..<(points.count - 1) {
        let p = points[i]
        let d: CGFloat
        if lenSq <= 1e-9 {
            d = hypot(p.x - first.x, p.y - first.y)
        } else {
            d = abs(dy * p.x - dx * p.y + last.x * first.y - last.y * first.x) / sqrt(lenSq)
        }
        if d > maxDist {
            maxDist = d; maxIdx = i
        }
    }
    if maxDist > epsilon {
        let left = rdpOpen(Array(points[0...maxIdx]), epsilon: epsilon)
        let right = rdpOpen(Array(points[maxIdx..<points.count]), epsilon: epsilon)
        return Array(left.dropLast()) + right
    }
    return [first, last]
}

private func smoothOpenPolyline(_ points: [CGPoint], passes: Int) -> [CGPoint] {
    guard points.count >= 3 else { return points }
    var cur = points
    for _ in 0..<passes {
        var next = [cur[0]]
        next.reserveCapacity(cur.count)
        for i in 1..<(cur.count - 1) {
            let a = cur[i - 1], b = cur[i], c = cur[i + 1]
            next.append(CGPoint(
                x: 0.22 * a.x + 0.56 * b.x + 0.22 * c.x,
                y: 0.22 * a.y + 0.56 * b.y + 0.22 * c.y
            ))
        }
        next.append(cur[cur.count - 1])
        cur = next
    }
    return cur
}

private func smoothClosedPolygon(_ points: [CGPoint], passes: Int) -> [CGPoint] {
    guard points.count >= 4 else { return points }
    var ring = points.first == points.last ? Array(points.dropLast()) : points
    guard ring.count >= 3 else { return points }
    for _ in 0..<passes {
        var next: [CGPoint] = []
        next.reserveCapacity(ring.count * 2)
        for i in ring.indices {
            let a = ring[i]
            let b = ring[(i + 1) % ring.count]
            next.append(CGPoint(x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y))
            next.append(CGPoint(x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y))
        }
        ring = next
    }
    ring.append(ring[0])
    return ring
}

private func rdpClosedPolygon(_ closed: [CGPoint], epsilon: CGFloat) -> [CGPoint] {
    let ring = (closed.count >= 2 && closed.first == closed.last) ? Array(closed.dropLast()) : closed
    guard ring.count >= 4 else { return closed }
    // Anchor at the two farthest vertices so closed loop simplification stays balanced.
    let anchor0 = 0
    var anchor1 = 0
    var bestD = -1.0
    for i in 1..<ring.count {
        let d = hypot(Double(ring[i].x - ring[anchor0].x), Double(ring[i].y - ring[anchor0].y))
        if d > bestD { bestD = d; anchor1 = i }
    }
    guard anchor1 > 0 else { return closed }
    let halfA = rdpOpen(Array(ring[anchor0...anchor1]), epsilon: epsilon)
    let halfB = rdpOpen(Array(ring[anchor1..<ring.count]) + [ring[anchor0]], epsilon: epsilon)
    var merged = Array(halfA.dropLast()) + Array(halfB.dropLast())
    guard merged.count >= 3 else { return [ring[0], ring[ring.count / 3], ring[(2 * ring.count) / 3], ring[0]] }
    merged.append(merged[0])
    return merged
}

private func polylineLength(_ pts: [CGPoint]) -> CGFloat {
    var total: CGFloat = 0
    for (a, b) in zip(pts, pts.dropFirst()) {
        total += hypot(b.x - a.x, b.y - a.y)
    }
    return total
}

private func signedShoelaceArea(_ pts: [CGPoint]) -> Double {
    guard pts.count >= 3 else { return 0 }
    var sum = 0.0
    for i in pts.indices {
        let a = pts[i]
        let b = pts[(i + 1) % pts.count]
        sum += Double(a.x * b.y - b.x * a.y)
    }
    return 0.5 * sum
}

private func splitOpenStrokeToLimits(_ pts: [CGPoint], maxLength: CGFloat = 1040, maxPoints: Int = 200) -> [[CGPoint]] {
    guard pts.count >= 2 else { return [] }
    if pts.count <= maxPoints && polylineLength(pts) <= maxLength {
        // Guard single long segments cleanly
        var dense: [CGPoint] = [pts[0]]
        for p in pts.dropFirst() {
            let prev = dense.last!
            let d = hypot(p.x - prev.x, p.y - prev.y)
            if d > maxLength {
                let chunks = Int(ceil(d / (maxLength * 0.8)))
                for k in 1...chunks {
                    let t = CGFloat(k) / CGFloat(chunks)
                    dense.append(CGPoint(x: prev.x + (p.x - prev.x) * t, y: prev.y + (p.y - prev.y) * t))
                }
            } else {
                dense.append(p)
            }
        }
        if dense.count <= maxPoints && polylineLength(dense) <= maxLength {
            return [dense]
        }
        return splitOpenStrokeToLimits(dense, maxLength: maxLength, maxPoints: maxPoints)
    }
    var out: [[CGPoint]] = []
    var current: [CGPoint] = [pts[0]]
    var curLen: CGFloat = 0
    for i in 1..<pts.count {
        let p = pts[i]
        let prev = current.last!
        let seg = hypot(p.x - prev.x, p.y - prev.y)
        if seg > maxLength {
            if current.count >= 2 { out.append(current) }
            let chunks = Int(ceil(seg / (maxLength * 0.8)))
            var sub = [prev]
            for k in 1...chunks {
                let t = CGFloat(k) / CGFloat(chunks)
                sub.append(CGPoint(x: prev.x + (p.x - prev.x) * t, y: prev.y + (p.y - prev.y) * t))
            }
            for s in splitOpenStrokeToLimits(sub, maxLength: maxLength, maxPoints: maxPoints) {
                out.append(s)
            }
            current = [p]
            curLen = 0
            continue
        }
        if current.count >= maxPoints || (current.count >= 2 && curLen + seg > maxLength) {
            out.append(current)
            current = [prev, p]
            curLen = seg
        } else {
            current.append(p)
            curLen += seg
        }
    }
    if current.count >= 2 { out.append(current) }
    return out
}

/// Extract closed contours from a binary 2D grid subwindow using subpixel 0.5 Marching Squares.
private func marchingSquaresContours(
    grid: [Bool], w: Int, h: Int,
    offsetX: Int, offsetY: Int,
    x0: Double, y0: Double, sx: Double, sy: Double
) -> [[CGPoint]] {
    // Padded (w+2) x (h+2) binary grid so components touching border always close.
    let pw = w + 2, ph = h + 2
    var pad = [Int](repeating: 0, count: pw * ph)
    for y in 0..<h {
        for x in 0..<w where grid[y * w + x] {
            pad[(y + 1) * pw + (x + 1)] = 1
        }
    }

    // Marching squares cell (cx, cy) spans vertices:
    // tl=(cx,cy), tr=(cx+1,cy), br=(cx+1,cy+1), bl=(cx,cy+1)
    // Edge indices on a vertex boundary: top=0, right=1, bottom=2, left=3
    struct DirectedSeg {
        let a: (Int, Int) // quantized 2x vertex coords to avoid float hash instability
        let b: (Int, Int)
    }

    var edgesByStart: [Int64: [Int]] = [:]
    var allSegs: [DirectedSeg] = []

    func edgePoint(_ cx: Int, _ cy: Int, _ side: Int) -> (Int, Int) {
        switch side {
        case 0: return (2 * cx + 1, 2 * cy)       // top midpoint
        case 1: return (2 * cx + 2, 2 * cy + 1)   // right midpoint
        case 2: return (2 * cx + 1, 2 * cy + 2)   // bottom midpoint
        default: return (2 * cx, 2 * cy + 1)      // left midpoint
        }
    }
    func key(_ p: (Int, Int)) -> Int64 { (Int64(p.0) << 24) | Int64(p.1 & 0xFFFFFF) }
    func addSeg(_ cx: Int, _ cy: Int, _ s0: Int, _ s1: Int) {
        let a = edgePoint(cx, cy, s0), b = edgePoint(cx, cy, s1)
        let idx = allSegs.count
        allSegs.append(DirectedSeg(a: a, b: b))
        edgesByStart[key(a), default: []].append(idx)
    }

    // Standard CW winding around foreground=1 interior (in top-left coordinates):
    // Foregound right of directed segment edge.
    for cy in 0..<(ph - 1) {
        for cx in 0..<(pw - 1) {
            let tl = pad[cy * pw + cx]
            let tr = pad[cy * pw + cx + 1]
            let br = pad[(cy + 1) * pw + cx + 1]
            let bl = pad[(cy + 1) * pw + cx]
            let mask = (tl << 3) | (tr << 2) | (br << 1) | bl
            switch mask {
            case 0, 15: break
            case 1: addSeg(cx, cy, 3, 2)
            case 2: addSeg(cx, cy, 2, 1)
            case 3: addSeg(cx, cy, 3, 1)
            case 4: addSeg(cx, cy, 1, 0)
            case 5: addSeg(cx, cy, 3, 0); addSeg(cx, cy, 1, 2)
            case 6: addSeg(cx, cy, 2, 0)
            case 7: addSeg(cx, cy, 3, 0)
            case 8: addSeg(cx, cy, 0, 3)
            case 9: addSeg(cx, cy, 0, 2)
            case 10: addSeg(cx, cy, 0, 1); addSeg(cx, cy, 2, 3)
            case 11: addSeg(cx, cy, 0, 1)
            case 12: addSeg(cx, cy, 1, 3)
            case 13: addSeg(cx, cy, 1, 2)
            case 14: addSeg(cx, cy, 2, 3)
            default: break
            }
        }
    }

    var used = [Bool](repeating: false, count: allSegs.count)
    var loops: [[CGPoint]] = []
    for startIdx in allSegs.indices where !used[startIdx] {
        var pts2x: [(Int, Int)] = []
        var curIdx: Int? = startIdx
        let startKey = key(allSegs[startIdx].a)
        while let idx = curIdx, !used[idx] {
            used[idx] = true
            let seg = allSegs[idx]
            pts2x.append(seg.a)
            let nextKey = key(seg.b)
            if nextKey == startKey {
                pts2x.append(seg.b)
                break
            }
            let candidates = edgesByStart[nextKey] ?? []
            curIdx = candidates.first(where: { !used[$0] })
        }
        guard pts2x.count >= 4 else { continue }
        // Convert padded 2x midpoint coords back into original pixel center coords:
        // padded vertex (vx, vy) corresponds to cell (vx - 0.5, vy - 0.5) in local unpadded coords!
        let mapped = pts2x.map { p in
            let gx = Double(p.0) * 0.5 - 0.5 + Double(offsetX)
            let gy = Double(p.1) * 0.5 - 0.5 + Double(offsetY)
            return CGPoint(x: x0 + gx * sx, y: y0 + gy * sy)
        }
        // Keep only outer contours (positive shoelace area in screen coords means clockwise enclosing foreground)
        if signedShoelaceArea(mapped) > 0 {
            loops.append(mapped)
        }
    }
    return loops
}

private func traceSkeletonPolylines(
    skel: [Bool], grid n: Int, x0: Double, y0: Double, sx: Double, sy: Double
) -> [([CGPoint], [Int])] {
    let dirList = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]
    var degree = [Int](repeating: 0, count: n * n)
    for y in 0..<n {
        for x in 0..<n {
            let p = y * n + x
            if !skel[p] { continue }
            var deg = 0
            for (dx, dy) in dirList {
                let nx = x + dx, ny = y + dy
                if nx >= 0 && nx < n && ny >= 0 && ny < n && skel[ny * n + nx] { deg += 1 }
            }
            degree[p] = deg
        }
    }

    var visitedEdge = Set<UInt64>()
    func edgeKey(_ a: Int, _ b: Int) -> UInt64 {
        let lo = UInt64(min(a, b)), hi = UInt64(max(a, b))
        return (lo << 32) | hi
    }

    var results: [([CGPoint], [Int])] = []

    func traceFrom(startPixel: Int, firstNext: Int) -> ([CGPoint], [Int]) {
        var idxPath = [startPixel, firstNext]
        visitedEdge.insert(edgeKey(startPixel, firstNext))
        var prev = startPixel
        var curr = firstNext
        while idxPath.count < 8000 {
            let cx = curr % n, cy = curr / n
            let px = prev % n, py = prev / n
            let vx = Double(cx - px), vy = Double(cy - py)
            let vLen = max(1e-6, hypot(vx, vy))
            var bestNext: Int?
            var bestDot = -2.0
            for (dx, dy) in dirList {
                let nx = cx + dx, ny = cy + dy
                if nx < 0 || nx >= n || ny < 0 || ny >= n { continue }
                let np = ny * n + nx
                if !skel[np] || np == prev { continue }
                if visitedEdge.contains(edgeKey(curr, np)) { continue }
                let dLen = hypot(Double(dx), Double(dy))
                let dot = (Double(dx) * vx + Double(dy) * vy) / (dLen * vLen)
                if dot > bestDot {
                    bestDot = dot
                    bestNext = np
                }
            }
            // Break gently at severe acute hair-pin corners so corners stay clean or end naturally.
            guard let nxt = bestNext, bestDot >= -0.35 else { break }
            visitedEdge.insert(edgeKey(curr, nxt))
            idxPath.append(nxt)
            prev = curr
            curr = nxt
        }
        let pts = idxPath.map { p -> CGPoint in
            let gx = Double(p % n) + 0.5
            let gy = Double(p / n) + 0.5
            return CGPoint(x: x0 + gx * sx, y: y0 + gy * sy)
        }
        return (pts, idxPath)
    }

    // Phase 1: Start from endpoints (degree == 1) and junctions (degree >= 3) for longest clean chains.
    for p in 0..<(n * n) where skel[p] && (degree[p] == 1 || degree[p] >= 3) {
        let x = p % n, y = p / n
        for (dx, dy) in dirList {
            let nx = x + dx, ny = y + dy
            if nx < 0 || nx >= n || ny < 0 || ny >= n { continue }
            let np = ny * n + nx
            if !skel[np] || visitedEdge.contains(edgeKey(p, np)) { continue }
            results.append(traceFrom(startPixel: p, firstNext: np))
        }
    }

    // Phase 2: Closed loops with no endpoints/junctions.
    for p in 0..<(n * n) where skel[p] && degree[p] == 2 {
        let x = p % n, y = p / n
        for (dx, dy) in dirList {
            let nx = x + dx, ny = y + dy
            if nx < 0 || nx >= n || ny < 0 || ny >= n { continue }
            let np = ny * n + nx
            if !skel[np] || visitedEdge.contains(edgeKey(p, np)) { continue }
            results.append(traceFrom(startPixel: p, firstNext: np))
        }
    }

    // Isolated 1px dots (degree == 0) become tiny 3px dabs if standalone.
    for p in 0..<(n * n) where skel[p] && degree[p] == 0 {
        let gx = Double(p % n) + 0.5, gy = Double(p / n) + 0.5
        let cx = x0 + gx * sx, cy = y0 + gy * sy
        results.append(([CGPoint(x: cx - 1.5, y: cy), CGPoint(x: cx + 1.5, y: cy)], [p]))
    }

    return results
}

private func clampPolygon(_ pts: [CGPoint], inside rect: CGRect, margin: CGFloat) -> [CGPoint] {
    let minX = rect.minX + margin, maxX = max(minX + 1, rect.maxX - margin)
    let minY = rect.minY + margin, maxY = max(minY + 1, rect.maxY - margin)
    return pts.map { p in
        CGPoint(
            x: ((min(maxX, max(minX, p.x)) * 10).rounded()) / 10,
            y: ((min(maxY, max(minY, p.y)) * 10).rounded()) / 10
        )
    }
}

private struct PendingShape {
    let role: String
    let tool: String
    let brushWidthName: String
    let brushWidth: Double
    let rgb: (Int, Int, Int)
    let hex: String
    let enclosedArea: Double
    let parentBBox: CGRect
    let bbox: CGRect
    let strokes: [[CGPoint]]
}

private func emitFillSubpolygons(
    localMask: [Bool], w: Int, h: Int,
    offsetX: Int, offsetY: Int,
    x0: Double, y0: Double, sx: Double, sy: Double,
    safeRect: CGRect, margin: CGFloat,
    depth: Int = 0
) -> [([CGPoint], Double, CGRect)] {
    let rawContours = marchingSquaresContours(
        grid: localMask, w: w, h: h, offsetX: offsetX, offsetY: offsetY,
        x0: x0, y0: y0, sx: sx, sy: sy
    )
    var out: [([CGPoint], Double, CGRect)] = []
    for contour in rawContours {
        let rawArea = signedShoelaceArea(contour)
        if rawArea < 16 { continue }
        var simplified = rdpClosedPolygon(smoothClosedPolygon(contour, passes: 1), epsilon: 1.0)
        if simplified.count > 220 || polylineLength(simplified) > 1060 {
            simplified = rdpClosedPolygon(contour, epsilon: 1.8)
        }
        if (simplified.count > 220 || polylineLength(simplified) > 1060), depth < 6, max(w, h) >= 16 {
            let splitX = w >= h
            let overlap = 3
            if splitX {
                let mid = w / 2
                let w1 = min(w, mid + overlap)
                var m1 = [Bool](repeating: false, count: w1 * h)
                for y in 0..<h { for x in 0..<w1 { m1[y * w1 + x] = localMask[y * w + x] } }
                out.append(contentsOf: emitFillSubpolygons(
                    localMask: m1, w: w1, h: h, offsetX: offsetX, offsetY: offsetY,
                    x0: x0, y0: y0, sx: sx, sy: sy, safeRect: safeRect, margin: margin, depth: depth + 1
                ))
                let sx2 = max(0, mid - overlap), w2 = w - sx2
                var m2 = [Bool](repeating: false, count: w2 * h)
                for y in 0..<h { for x in 0..<w2 { m2[y * w2 + x] = localMask[y * w + sx2 + x] } }
                out.append(contentsOf: emitFillSubpolygons(
                    localMask: m2, w: w2, h: h, offsetX: offsetX + sx2, offsetY: offsetY,
                    x0: x0, y0: y0, sx: sx, sy: sy, safeRect: safeRect, margin: margin, depth: depth + 1
                ))
            } else {
                let mid = h / 2
                let h1 = min(h, mid + overlap)
                var m1 = [Bool](repeating: false, count: w * h1)
                for y in 0..<h1 { for x in 0..<w { m1[y * w + x] = localMask[y * w + x] } }
                out.append(contentsOf: emitFillSubpolygons(
                    localMask: m1, w: w, h: h1, offsetX: offsetX, offsetY: offsetY,
                    x0: x0, y0: y0, sx: sx, sy: sy, safeRect: safeRect, margin: margin, depth: depth + 1
                ))
                let sy2 = max(0, mid - overlap), h2 = h - sy2
                var m2 = [Bool](repeating: false, count: w * h2)
                for y in 0..<h2 { for x in 0..<w { m2[y * w + x] = localMask[(sy2 + y) * w + x] } }
                out.append(contentsOf: emitFillSubpolygons(
                    localMask: m2, w: w, h: h2, offsetX: offsetX, offsetY: offsetY + sy2,
                    x0: x0, y0: y0, sx: sx, sy: sy, safeRect: safeRect, margin: margin, depth: depth + 1
                ))
            }
            continue
        }
        var clamped = clampPolygon(simplified, inside: safeRect, margin: margin)
        if clamped.count >= 4 {
            clamped[clamped.count - 1] = clamped[0]
            if polylineLength(clamped) <= 1140 && clamped.count <= 240 {
                let xs = clamped.map(\.x), ys = clamped.map(\.y)
                let box = CGRect(x: xs.min()!, y: ys.min()!, width: max(1, xs.max()! - xs.min()!), height: max(1, ys.max()! - ys.min()!))
                out.append((clamped, max(1.0, abs(signedShoelaceArea(clamped))), box))
            }
        }
    }
    return out
}

func buildVectorPaintPlan(
    imagePath: String,
    rect: CGRect,
    grid n: Int = 340,
    colors targetColors: Int = 18,
    seed: Int = 12345,
    bgMode: String = "auto"
) throws -> VectorPaintPlanResult {
    guard n >= 24 && n <= 512 else { throw VectorPlanError.invalidGrid(n) }
    guard targetColors >= 2 && targetColors <= 32 else { throw VectorPlanError.invalidPalette(targetColors) }

    let pixels = try loadSampledRGBA(imagePath: imagePath, grid: n)
    let bg = detectBackgroundMask(pixels: pixels, grid: n, bgMode: bgMode)
    let (thinInk, _) = extractThinInkMask(pixels: pixels, bg: bg, grid: n)

    let total = n * n
    let x0 = Double(rect.minX)
    let y0 = Double(rect.minY)
    let sx = Double(rect.width) / Double(n)
    let sy = Double(rect.height) / Double(n)

    var colorPoints: [(Int, Int, Int)] = []
    for p in 0..<total where !bg[p] && !thinInk[p] {
        let px = pixels[p]
        colorPoints.append((px.r, px.g, px.b))
    }
    if colorPoints.isEmpty {
        // Fallback if image consists purely of thin lines
        for p in 0..<total where !bg[p] {
            let px = pixels[p]
            colorPoints.append((px.r, px.g, px.b))
        }
    }
    guard !colorPoints.isEmpty else { throw VectorPlanError.emptyImage }

    let fillColorCount = max(2, min(targetColors - 1, min(28, colorPoints.count)))

    // Deterministic K-means++ initialization
    var lcgState = Int64(seed & 0x7fffffff)
    func nextRand() -> Double {
        lcgState = (lcgState &* 1103515245 &+ 12345) & 0x7fffffff
        return Double(lcgState) / Double(0x7fffffff)
    }
    var centroids: [(Double, Double, Double)] = []
    let strideSample = max(1, colorPoints.count / 12000)
    var sampled: [(Int, Int, Int)] = []
    for i in stride(from: 0, to: colorPoints.count, by: strideSample) { sampled.append(colorPoints[i]) }
    let firstPt = sampled[Int(nextRand() * Double(sampled.count)) % sampled.count]
    centroids.append((Double(firstPt.0), Double(firstPt.1), Double(firstPt.2)))
    var minDistSq = [Double](repeating: Double.greatestFiniteMagnitude, count: sampled.count)

    while centroids.count < fillColorCount {
        let latest = centroids.last!
        let li = (Int(latest.0.rounded()), Int(latest.1.rounded()), Int(latest.2.rounded()))
        var sumD = 0.0
        for (i, pt) in sampled.enumerated() {
            let d = rgbDistSq(pt, li)
            if d < minDistSq[i] { minDistSq[i] = d }
            sumD += minDistSq[i]
        }
        if sumD <= 1e-6 { break }
        let target = nextRand() * sumD
        var acc = 0.0
        var chosen = sampled[0]
        for (i, pt) in sampled.enumerated() {
            acc += minDistSq[i]
            if acc >= target { chosen = pt; break }
        }
        centroids.append((Double(chosen.0), Double(chosen.1), Double(chosen.2)))
    }

    let kActual = centroids.count
    var labels = [Int](repeating: -1, count: total)
    for iter in 0..<18 {
        var sums = [(Double, Double, Double, Double)](repeating: (0, 0, 0, 0), count: kActual)
        let activePts = iter < 12 ? sampled : colorPoints
        let assignAll = (iter == 17)
        if assignAll {
            for p in 0..<total where !bg[p] && !thinInk[p] {
                let px = pixels[p]
                let pt = (px.r, px.g, px.b)
                var bestK = 0, bestD = Double.greatestFiniteMagnitude
                for (k, c) in centroids.enumerated() {
                    let d = rgbDistSq(pt, (Int(c.0.rounded()), Int(c.1.rounded()), Int(c.2.rounded())))
                    if d < bestD { bestD = d; bestK = k }
                }
                labels[p] = bestK
            }
            break
        }
        for pt in activePts {
            var bestK = 0, bestD = Double.greatestFiniteMagnitude
            for (k, c) in centroids.enumerated() {
                let dr = Double(pt.0) - c.0, dg = Double(pt.1) - c.1, db = Double(pt.2) - c.2
                let d = 2.0 * dr * dr + 4.0 * dg * dg + 1.5 * db * db
                if d < bestD { bestD = d; bestK = k }
            }
            sums[bestK].0 += Double(pt.0)
            sums[bestK].1 += Double(pt.1)
            sums[bestK].2 += Double(pt.2)
            sums[bestK].3 += 1
        }
        for k in 0..<kActual where sums[k].3 > 0 {
            centroids[k] = (sums[k].0 / sums[k].3, sums[k].1 / sums[k].3, sums[k].2 / sums[k].3)
        }
    }

    // Single isolated pixel cleanup (preserve 2px highlights cleanly)
    var denoised = labels
    for y in 1..<(n - 1) {
        for x in 1..<(n - 1) {
            let p = y * n + x
            let cur = labels[p]
            if cur < 0 { continue }
            var same = 0
            var counts = [Int](repeating: 0, count: kActual)
            for dy in -1...1 {
                for dx in -1...1 where !(dx == 0 && dy == 0) {
                    let nb = labels[(y + dy) * n + x + dx]
                    if nb >= 0 {
                        counts[nb] += 1
                        if nb == cur { same += 1 }
                    }
                }
            }
            if same == 0 {
                if let best = counts.indices.max(by: { counts[$0] < counts[$1] }), counts[best] >= 3 {
                    denoised[p] = best
                }
            }
        }
    }
    labels = denoised

    // Underpaint dilation under thin ink lines so Fill polygons overlap seamlessly beneath ink strokes.
    var expandQueue: [(Int, Int)] = []
    for p in 0..<total where labels[p] >= 0 {
        expandQueue.append((p, 0))
    }
    var qHead = 0
    while qHead < expandQueue.count {
        let (p, step) = expandQueue[qHead]
        qHead += 1
        if step >= 5 { continue }
        let x = p % n, y = p / n
        for (dx, dy) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
            let nx = x + dx, ny = y + dy
            if nx < 0 || nx >= n || ny < 0 || ny >= n { continue }
            let np = ny * n + nx
            if thinInk[np] && labels[np] < 0 {
                labels[np] = labels[p]
                expandQueue.append((np, step + 1))
            }
        }
    }

    var colorPixelCounts = [Int](repeating: 0, count: kActual)
    for p in 0..<total where labels[p] >= 0 { colorPixelCounts[labels[p]] += 1 }

    var pendingFills: [PendingShape] = []
    var pendingDetails: [PendingShape] = []
    var pendingHighlights: [PendingShape] = []

    let margin: CGFloat = 3.0
    let smallHighlightMaxArea = rect.width * rect.height * 0.0025

    // Trace each color component cleanly
    for k in 0..<kActual {
        let c = centroids[k]
        let rgb = (Int(c.0.rounded()), Int(c.1.rounded()), Int(c.2.rounded()))
        let hex = vecHex(rgb.0, rgb.1, rgb.2)
        let chromaK = max(rgb.0, max(rgb.1, rgb.2)) - min(rgb.0, min(rgb.1, rgb.2))
        let isVeryBright = vecLuma(rgb.0, rgb.1, rgb.2) >= 244.0 && chromaK <= 16
        let minComponentPixels = isVeryBright ? max(4, (n * n) / 26000) : max(14, (n * n) / 6000)

        var seen = [Bool](repeating: false, count: total)
        for p in 0..<total where labels[p] == k && !seen[p] {
            var comp: [Int] = [p]
            seen[p] = true
            var head = 0
            var minX = p % n, maxX = minX, minY = p / n, maxY = minY
            while head < comp.count {
                let cur = comp[head]
                head += 1
                let cx = cur % n, cy = cur / n
                if cx < minX { minX = cx }
                if cx > maxX { maxX = cx }
                if cy < minY { minY = cy }
                if cy > maxY { maxY = cy }
                for (dx, dy) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
                    let nx = cx + dx, ny = cy + dy
                    if nx < 0 || nx >= n || ny < 0 || ny >= n { continue }
                    let np = ny * n + nx
                    if labels[np] == k && !seen[np] {
                        seen[np] = true
                        comp.append(np)
                    }
                }
            }
            if comp.count < minComponentPixels { continue }

            // Compute perimeter pixel edges of component to check thickness
            let lw = maxX - minX + 1
            let lh = maxY - minY + 1
            var localMask = [Bool](repeating: false, count: lw * lh)
            for idx in comp {
                let lx = (idx % n) - minX, ly = (idx / n) - minY
                localMask[ly * lw + lx] = true
            }
            let screenArea = Double(comp.count) * sx * sy
            var boundaryScreenLen = 0.0
            for ly in 0..<lh {
                for lx in 0..<lw where localMask[ly * lw + lx] {
                    if lx == 0 || !localMask[ly * lw + lx - 1] { boundaryScreenLen += sy }
                    if lx + 1 == lw || !localMask[ly * lw + lx + 1] { boundaryScreenLen += sy }
                    if ly == 0 || !localMask[(ly - 1) * lw + lx] { boundaryScreenLen += sx }
                    if ly + 1 == lh || !localMask[(ly + 1) * lw + lx] { boundaryScreenLen += sx }
                }
            }
            let meanThickness = 2.0 * screenArea / max(1.0, boundaryScreenLen)

            // Only truly skinny isolated streaks / pinpoint sparkles become Monoline strokes;
            // keep multi-cell shading/gradient bands as closed Fill polygons with 1-cell
            // interior seam dilation inside foreground so adjacent colors leave zero white gaps.
            if (comp.count < 10 || (meanThickness < 2.6 && min(Double(lw) * sx, Double(lh) * sy) < 4.5)) {
                // Build padded local skeleton for crisp ribbon strokes
                let pw = lw + 2, ph = lh + 2
                var skelMask = [Bool](repeating: false, count: pw * ph)
                for ly in 0..<lh {
                    for lx in 0..<lw where localMask[ly * lw + lx] {
                        skelMask[(ly + 1) * pw + (lx + 1)] = true
                    }
                }
                let side = max(pw, ph)
                var sq = [Bool](repeating: false, count: side * side)
                for ly in 0..<ph { for lx in 0..<pw { sq[ly * side + lx] = skelMask[ly * pw + lx] } }
                var thinned = zhangSuenThin(sq, grid: side)
                pruneSkeletonSpurs(&thinned, grid: side, maxSpurSteps: 2)
                let traced = traceSkeletonPolylines(
                    skel: thinned, grid: side,
                    x0: x0 + Double(minX - 1) * sx, y0: y0 + Double(minY - 1) * sy,
                    sx: sx, sy: sy
                )
                let bw = meanThickness >= 3.2 ? 5.0 : 2.5
                let bwName = meanThickness >= 3.2 ? "Medium" : "Fine"
                let sMargin = max(margin, CGFloat(bw * 0.5 + 1.5))
                var ribbonStrokes: [[CGPoint]] = []
                for (rawPts, _) in traced {
                    let smoothed = smoothOpenPolyline(rawPts, passes: 2)
                    let simp = rdpOpen(smoothed, epsilon: 1.0)
                    let clamped = clampPolygon(simp, inside: rect, margin: sMargin)
                    for piece in splitOpenStrokeToLimits(clamped) where polylineLength(piece) >= 2.2 {
                        ribbonStrokes.append(piece)
                    }
                }
                if !ribbonStrokes.isEmpty {
                    let pts = ribbonStrokes.flatMap { $0 }
                    let xs = pts.map(\.x), ys = pts.map(\.y)
                    let box = CGRect(x: xs.min()!, y: ys.min()!, width: max(1, xs.max()! - xs.min()!), height: max(1, ys.max()! - ys.min()!))
                    let shape = PendingShape(
                        role: isVeryBright && screenArea < smallHighlightMaxArea ? "highlight" : "detail",
                        tool: "Monoline", brushWidthName: bwName, brushWidth: bw,
                        rgb: rgb, hex: hex, enclosedArea: max(4.0, screenArea), parentBBox: box, bbox: box, strokes: ribbonStrokes
                    )
                    if shape.role == "highlight" { pendingHighlights.append(shape) }
                    else { pendingDetails.append(shape) }
                }
                continue
            }

            // Dilate fill component by 1 cell strictly inside foreground (!bg) so touching
            // gradient bands overlap beneath adjacent shapes with zero white canvas pinholes.
            let padMinX = max(0, minX - 1), padMaxX = min(n - 1, maxX + 1)
            let padMinY = max(0, minY - 1), padMaxY = min(n - 1, maxY + 1)
            let dw = padMaxX - padMinX + 1, dh = padMaxY - padMinY + 1
            var dilatedMask = [Bool](repeating: false, count: dw * dh)
            for idx in comp {
                let gx = idx % n, gy = idx / n
                for dy in -1...1 {
                    for dx in -1...1 {
                        let nx = gx + dx, ny = gy + dy
                        if nx >= padMinX && nx <= padMaxX && ny >= padMinY && ny <= padMaxY && !bg[ny * n + nx] {
                            dilatedMask[(ny - padMinY) * dw + (nx - padMinX)] = true
                        }
                    }
                }
            }

            let polys = emitFillSubpolygons(
                localMask: dilatedMask, w: dw, h: dh,
                offsetX: padMinX, offsetY: padMinY,
                x0: x0, y0: y0, sx: sx, sy: sy,
                safeRect: rect, margin: 4.0
            )
            let compBox = CGRect(
                x: x0 + Double(padMinX) * sx,
                y: y0 + Double(padMinY) * sy,
                width: max(1.0, Double(dw) * sx),
                height: max(1.0, Double(dh) * sy)
            )
            for (poly, enclosedArea, box) in polys {
                let shape = PendingShape(
                    role: isVeryBright && enclosedArea < smallHighlightMaxArea ? "highlight" : "fill",
                    tool: "Fill", brushWidthName: "Fine", brushWidth: 2.0,
                    rgb: rgb, hex: hex, enclosedArea: enclosedArea, parentBBox: compBox, bbox: box, strokes: [poly]
                )
                if shape.role == "highlight" { pendingHighlights.append(shape) }
                else { pendingFills.append(shape) }
            }
        }
    }

    // Distance map on thinInk for thickness-bucketed ink strokes
    var inkDist = [Double](repeating: 0, count: total)
    for p in 0..<total where thinInk[p] { inkDist[p] = 1e6 }
    for y in 0..<n {
        for x in 0..<n where thinInk[y * n + x] {
            let p = y * n + x
            var d = inkDist[p]
            if x > 0 { d = min(d, inkDist[p - 1] + 1) }
            if y > 0 { d = min(d, inkDist[p - n] + 1) }
            inkDist[p] = d
        }
    }
    for y in stride(from: n - 1, through: 0, by: -1) {
        for x in stride(from: n - 1, through: 0, by: -1) where thinInk[y * n + x] {
            let p = y * n + x
            var d = inkDist[p]
            if x + 1 < n { d = min(d, inkDist[p + 1] + 1) }
            if y + 1 < n { d = min(d, inkDist[p + n] + 1) }
            inkDist[p] = d
        }
    }

    var inkSkel = zhangSuenThin(thinInk, grid: n)
    pruneSkeletonSpurs(&inkSkel, grid: n, maxSpurSteps: 3)
    let inkChains = traceSkeletonPolylines(skel: inkSkel, grid: n, x0: x0, y0: y0, sx: sx, sy: sy)

    // Average color across thinInk pixels (near-black charcoal)
    var inkR = 0, inkG = 0, inkB = 0, inkN = 0
    for p in 0..<total where thinInk[p] {
        inkR += pixels[p].r; inkG += pixels[p].g; inkB += pixels[p].b; inkN += 1
    }
    let inkRGB = inkN > 0 ? (inkR / inkN, inkG / inkN, inkB / inkN) : (12, 14, 18)
    let inkHex = vecHex(inkRGB.0, inkRGB.1, inkRGB.2)

    var fineInk: [[CGPoint]] = []
    var medInk: [[CGPoint]] = []
    for (rawPts, idxPath) in inkChains {
        let rawLen = polylineLength(rawPts)
        if rawLen < 4.5 { continue }
        var radii = idxPath.map { inkDist[$0] * max(sx, sy) }
        radii.sort()
        let medianRadius = radii[radii.count / 2]
        let isMedium = (medianRadius * 2.0) >= 3.8 && rawLen >= 10.0
        let bw: Double = isMedium ? 5.0 : 2.2
        let sMargin: CGFloat = CGFloat(bw * 0.5 + 1.5)
        let smoothed = smoothOpenPolyline(rawPts, passes: 3)
        let simplified = rdpOpen(smoothed, epsilon: 1.05)
        let clamped = clampPolygon(simplified, inside: rect, margin: sMargin)
        for piece in splitOpenStrokeToLimits(clamped) where polylineLength(piece) >= 3.5 {
            if isMedium { medInk.append(piece) } else { fineInk.append(piece) }
        }
    }

    func pointInside(_ pt: CGPoint, _ poly: [CGPoint]) -> Bool {
        guard poly.count >= 3 else { return false }
        var inside = false
        var j = poly.count - 1
        for i in poly.indices {
            let a = poly[i], b = poly[j]
            if (a.y > pt.y) != (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x {
                inside.toggle()
            }
            j = i
        }
        return inside
    }

    func polygonsMayOverlap(_ a: PendingShape, _ b: PendingShape) -> Bool {
        guard a.bbox.intersects(b.bbox) else { return false }
        guard let polyA = a.strokes.first, let polyB = b.strokes.first else { return true }
        let stepB = max(1, polyB.count / 12)
        for idx in stride(from: 0, to: polyB.count, by: stepB) {
            let pt = polyB[idx]
            if a.bbox.contains(pt) && pointInside(pt, polyA) { return true }
        }
        let cxB = polyB.map(\.x).reduce(0, +) / CGFloat(polyB.count)
        let cyB = polyB.map(\.y).reduce(0, +) / CGFloat(polyB.count)
        if pointInside(CGPoint(x: cxB, y: cyB), polyA) { return true }
        let stepA = max(1, polyA.count / 12)
        for idx in stride(from: 0, to: polyA.count, by: stepA) {
            let pt = polyA[idx]
            if b.bbox.contains(pt) && pointInside(pt, polyB) { return true }
        }
        return false
    }

    func parentSpan(_ s: PendingShape) -> Double {
        Double(s.parentBBox.width * s.parentBBox.height)
    }

    // Topological schedule for Fill shapes: larger overlapping/enclosing container shapes MUST run before
    // inner ones, while disjoint shapes batch greedily by hex color to minimize color switches.
    func scheduleShapes(_ items: [PendingShape]) -> [PendingShape] {
        guard items.count > 1 else { return items }
        let sorted = items.sorted {
            let sa = parentSpan($0), sb = parentSpan($1)
            if abs(sa - sb) > 1.0 { return sa > sb }
            return $0.enclosedArea > $1.enclosedArea
        }
        let m = sorted.count
        var preds = [Int](repeating: 0, count: m)
        var succs = [[Int]](repeating: [], count: m)
        for i in 0..<m {
            let spanI = parentSpan(sorted[i])
            for j in (i + 1)..<m {
                let midJ = CGPoint(x: sorted[j].bbox.midX, y: sorted[j].bbox.midY)
                let encloses = sorted[i].hex != sorted[j].hex &&
                    spanI > parentSpan(sorted[j]) * 1.15 &&
                    sorted[i].parentBBox.contains(midJ)
                if encloses || polygonsMayOverlap(sorted[i], sorted[j]) {
                    succs[i].append(j)
                    preds[j] += 1
                }
            }
        }
        var ready = (0..<m).filter { preds[$0] == 0 }
        var scheduled: [PendingShape] = []
        scheduled.reserveCapacity(m)
        var currentHex = ""
        while !ready.isEmpty {
            let pickPos: Int
            if let sameHexPos = ready.firstIndex(where: { sorted[$0].hex == currentHex }) {
                pickPos = sameHexPos
            } else {
                pickPos = ready.indices.min(by: {
                    let a = sorted[ready[$0]], b = sorted[ready[$1]]
                    let sa = parentSpan(a), sb = parentSpan(b)
                    return abs(sa - sb) > 1.0 ? sa > sb : a.enclosedArea > b.enclosedArea
                })!
            }
            let node = ready.remove(at: pickPos)
            let item = sorted[node]
            currentHex = item.hex
            scheduled.append(item)
            for next in succs[node] {
                preds[next] -= 1
                if preds[next] == 0 { ready.append(next) }
            }
        }
        return scheduled
    }

    let highlightAreaCap = max(60.0, Double(rect.width * rect.height) * 0.0003)
    var inkSamplePts: [CGPoint] = []
    for stroke in medInk + fineInk {
        for i in stroke.indices {
            inkSamplePts.append(stroke[i])
            if i + 1 < stroke.count {
                let a = stroke[i], b = stroke[i + 1]
                inkSamplePts.append(CGPoint(x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5))
            }
        }
    }
    var deferredPreInkHighlights: [PendingShape] = []
    var keptHighlights: [PendingShape] = []
    for h in pendingHighlights {
        // Keep bright catchlights after ink only when isolated from ink outlines
        // (e.g. inside blue iris); sclera/ruffle glints touching ink go under ink.
        let padded = h.bbox.insetBy(dx: -4.0, dy: -4.0)
        let touchesInk = inkSamplePts.contains { padded.contains($0) }
        if h.enclosedArea <= highlightAreaCap && !touchesInk {
            keptHighlights.append(h)
        } else {
            deferredPreInkHighlights.append(h)
        }
    }

    var allOrderedShapes: [PendingShape] = []
    allOrderedShapes.append(contentsOf: scheduleShapes(pendingFills))
    let combinedDetails = (pendingDetails + deferredPreInkHighlights).sorted {
        ($0.tool, $0.brushWidthName, $0.hex) < ($1.tool, $1.brushWidthName, $1.hex)
    }
    allOrderedShapes.append(contentsOf: combinedDetails)

    if !medInk.isEmpty {
        let pts = medInk.flatMap { $0 }
        let box = CGRect(x: pts.map(\.x).min()!, y: pts.map(\.y).min()!, width: 10, height: 10)
        allOrderedShapes.append(PendingShape(
            role: "ink", tool: "Monoline", brushWidthName: "Medium", brushWidth: 5.0,
            rgb: inkRGB, hex: inkHex, enclosedArea: 0, parentBBox: box, bbox: box, strokes: medInk
        ))
    }
    if !fineInk.isEmpty {
        let pts = fineInk.flatMap { $0 }
        let box = CGRect(x: pts.map(\.x).min()!, y: pts.map(\.y).min()!, width: 10, height: 10)
        allOrderedShapes.append(PendingShape(
            role: "ink", tool: "Monoline", brushWidthName: "Fine", brushWidth: 2.2,
            rgb: inkRGB, hex: inkHex, enclosedArea: 0, parentBBox: box, bbox: box, strokes: fineInk
        ))
    }
    allOrderedShapes.append(contentsOf: keptHighlights.sorted { ($0.tool, $0.brushWidthName, $0.hex) < ($1.tool, $1.brushWidthName, $1.hex) })

    // Coalesce consecutive items sharing exact (role, tool, brushWidthName, hex)
    var batches: [VectorStrokeBatch] = []
    var totalStrokes = 0
    for shape in allOrderedShapes {
        let serializable = shape.strokes.map { stroke in
            stroke.map { [Double($0.x), Double($0.y)] }
        }
        totalStrokes += serializable.count
        if let last = batches.last,
           last.role == shape.role,
           last.tool == shape.tool,
           last.brushWidthName == shape.brushWidthName,
           last.hex == shape.hex {
            let combined = last.strokes + serializable
            batches[batches.count - 1] = VectorStrokeBatch(
                index: last.index, role: last.role, tool: last.tool,
                brushWidthName: last.brushWidthName, brushWidth: last.brushWidth,
                rgb: last.rgb, hex: last.hex, strokes: combined
            )
        } else {
            batches.append(VectorStrokeBatch(
                index: batches.count, role: shape.role, tool: shape.tool,
                brushWidthName: shape.brushWidthName, brushWidth: shape.brushWidth,
                rgb: shape.rgb, hex: shape.hex, strokes: serializable
            ))
        }
    }

    // Render faithful vector preview at n x n using CoreGraphics
    var previewRGBA = [UInt8](repeating: 255, count: n * n * 4)
    let cs = CGColorSpaceCreateDeviceRGB()
    if let pCtx = CGContext(
        data: &previewRGBA, width: n, height: n,
        bitsPerComponent: 8, bytesPerRow: n * 4, space: cs,
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue).rawValue
    ) {
        pCtx.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
        pCtx.fill(CGRect(x: 0, y: 0, width: n, height: n))
        // CoreGraphics context has bottom-left origin; flip vertically so row 0 is top edge.
        pCtx.translateBy(x: 0, y: CGFloat(n))
        pCtx.scaleBy(x: CGFloat(n) / rect.width, y: -CGFloat(n) / rect.height)
        pCtx.translateBy(x: -rect.minX, y: -rect.minY)
        pCtx.setLineCap(.round)
        pCtx.setLineJoin(.round)
        for batch in batches {
            let r = CGFloat(batch.rgb.0) / 255.0
            let g = CGFloat(batch.rgb.1) / 255.0
            let b = CGFloat(batch.rgb.2) / 255.0
            pCtx.setFillColor(red: r, green: g, blue: b, alpha: 1)
            pCtx.setStrokeColor(red: r, green: g, blue: b, alpha: 1)
            for pts in batch.strokes where pts.count >= 2 {
                pCtx.beginPath()
                pCtx.move(to: CGPoint(x: pts[0][0], y: pts[0][1]))
                for pt in pts.dropFirst() {
                    pCtx.addLine(to: CGPoint(x: pt[0], y: pt[1]))
                }
                if batch.tool == "Fill" && pts.count >= 3 {
                    pCtx.closePath()
                    pCtx.fillPath()
                } else {
                    pCtx.setLineWidth(CGFloat(batch.brushWidth))
                    pCtx.strokePath()
                }
            }
        }
    }

    var paletteSummary: [(String, (Int, Int, Int), Int)] = []
    for k in 0..<kActual where colorPixelCounts[k] > 0 {
        let c = centroids[k]
        let rgb = (Int(c.0.rounded()), Int(c.1.rounded()), Int(c.2.rounded()))
        paletteSummary.append((vecHex(rgb.0, rgb.1, rgb.2), rgb, colorPixelCounts[k]))
    }
    if inkN > 0 {
        paletteSummary.append((inkHex, inkRGB, inkN))
    }

    return VectorPaintPlanResult(
        grid: n, colors: targetColors, rect: rect, palette: paletteSummary,
        batches: batches, previewRGBA: previewRGBA, totalStrokes: totalStrokes
    )
}

func writeVectorPreviewPNG(_ pixels: [UInt8], grid: Int, to path: String) throws {
    let space = CGColorSpaceCreateDeviceRGB()
    guard let provider = CGDataProvider(data: Data(pixels) as CFData),
          let image = CGImage(
            width: grid, height: grid, bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: grid * 4, space: space,
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent
          ),
          let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, "public.png" as CFString, 1, nil) else {
        throw VectorPlanError.writeFailed("could not create preview PNG")
    }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else {
        throw VectorPlanError.writeFailed("could not finalize preview PNG")
    }
}
