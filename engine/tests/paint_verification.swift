import Foundation
import CoreGraphics
import ImageIO

@main
struct PaintVerificationTest {
    static func main() {
        let white: UInt8 = 255
        let before = [UInt8](repeating: white, count: 20 * 20 * 4)
        func painted(_ rgb: (UInt8, UInt8, UInt8)) -> [UInt8] {
            var bytes = before
            for x in 3...16 {
                let i = (10 * 20 + x) * 4
                bytes[i] = rgb.0; bytes[i + 1] = rgb.1; bytes[i + 2] = rgb.2
            }
            return bytes
        }
        let path = [[CGPoint(x: 3, y: 10), CGPoint(x: 16, y: 10)]]
        let red = (UInt8(220), UInt8(20), UInt8(30))
        var redSwatch = before
        for y in 8...12 { for x in 8...12 { let i = (y * 20 + x) * 4; redSwatch[i] = red.0; redSwatch[i + 1] = red.1; redSwatch[i + 2] = red.2 } }
        precondition(inspectSwatch(pixels: redSwatch, width: 20, height: 20, center: CGPoint(x: 10, y: 10), expected: red))
        precondition(!inspectSwatch(pixels: redSwatch, width: 20, height: 20, center: CGPoint(x: 10, y: 10), expected: (0, 0, 255)))
        var orangeSwatch = before
        for y in 8...12 { for x in 8...12 { let i = (y * 20 + x) * 4; orangeSwatch[i] = 255; orangeSwatch[i + 1] = 64; orangeSwatch[i + 2] = 0 } }
        precondition(!inspectSwatch(pixels: orangeSwatch, width: 20, height: 20, center: CGPoint(x: 10, y: 10), expected: (255, 0, 0)), "orange-red is not pure red")
        let success = inspectPaint(before: before, after: painted(red), width: 20, height: 20, paths: path, expected: red)
        precondition(success.matched && success.failedStrokes.isEmpty, "correct red stroke must pass")
        let wrong = inspectPaint(before: before, after: painted((20, 20, 220)), width: 20, height: 20, paths: path, expected: red)
        precondition(!wrong.matched && wrong.failedStrokes == [0], "wrong color must fail")
        let orange = inspectPaint(before: before, after: painted((220, 148, 30)), width: 20, height: 20, paths: path, expected: red)
        precondition(!orange.matched, "orange must not pass as red")
        let orangeRed = inspectPaint(before: before, after: painted((255, 64, 0)), width: 20, height: 20, paths: path, expected: (255, 0, 0))
        precondition(!orangeRed.matched, "orange-red stroke must not pass as pure red")
        let brown = inspectPaint(before: before, after: painted((160, 100, 100)), width: 20, height: 20, paths: path, expected: (128, 128, 128))
        precondition(!brown.matched, "a saturated brown stroke must not pass as neutral gray")
        let black = inspectPaint(before: before, after: painted((40, 40, 40)), width: 20, height: 20, paths: path, expected: (0, 0, 0))
        precondition(black.matched, "a dark antialiased black brush must pass")
        var antialiased = painted((40, 40, 40))
        for x in 3...16 { for y in [9, 11] { let i = (y * 20 + x) * 4; antialiased[i] = 215; antialiased[i + 1] = 215; antialiased[i + 2] = 215 } }
        let thin = inspectPaint(before: before, after: antialiased, width: 20, height: 20, paths: path, expected: (0, 0, 0))
        precondition(thin.matched, "antialiased edge pixels must not overwhelm a dark center")
        let none = inspectPaint(before: before, after: before, width: 20, height: 20, paths: path, expected: red)
        precondition(!none.matched && none.failedStrokes == [0], "no mark must fail")
        let outside = inspectPaint(before: before, after: painted(red), width: 20, height: 20, paths: [[CGPoint(x: 1, y: 1), CGPoint(x: 15, y: 1)]], expected: red)
        precondition(!outside.matched, "unrelated change must not pass")
        var partial = before
        for x in 3...5 { let i = (10 * 20 + x) * 4; partial[i] = red.0; partial[i + 1] = red.1; partial[i + 2] = red.2 }
        let incomplete = inspectPaint(before: before, after: partial, width: 20, height: 20, paths: path, expected: red)
        precondition(!incomplete.matched, "a partial mark must not verify the full stroke")
        let wideBefore = [UInt8](repeating: 255, count: 120 * 20 * 4)
        var wideAfter = wideBefore
        for x in 5...78 { let i = (10 * 120 + x) * 4; wideAfter[i] = red.0; wideAfter[i + 1] = red.1; wideAfter[i + 2] = red.2 }
        let truncated = inspectPaint(before: wideBefore, after: wideAfter, width: 120, height: 20, paths: [[CGPoint(x: 5, y: 10), CGPoint(x: 105, y: 10)]], expected: red)
        precondition(!truncated.matched, "a mostly drawn stroke with a missing end must fail")
        let pixelBytes: [UInt8] = [255, 0, 0, 255, 0, 0, 255, 255]
        let provider = CGDataProvider(data: Data(pixelBytes) as CFData)!
        let image = CGImage(width: 1, height: 2, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: 4,
                            space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue),
                            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".png")
        let destination = CGImageDestinationCreateWithURL(file as CFURL, "public.png" as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, image, nil)
        precondition(CGImageDestinationFinalize(destination))
        defer { try? FileManager.default.removeItem(at: file) }
        let decoded = paintImagePixels(file.path)!
        precondition(decoded.pixels[0] == 255 && decoded.pixels[2] == 0, "first row must stay at the top")
        let side = 800
        let largeBefore = [UInt8](repeating: 255, count: side * side * 4)
        var largeAfter = largeBefore
        for n in 0..<side { let i = (n * side + n) * 4; largeAfter[i] = 0; largeAfter[i + 1] = 0; largeAfter[i + 2] = 0 }
        let manyPoints = stride(from: 0, through: 795, by: 5).map { CGPoint(x: $0, y: $0) } + [CGPoint(x: 799, y: 799)]
        let started = Date()
        let complex = inspectPaint(before: largeBefore, after: largeAfter, width: side, height: side, paths: [manyPoints], expected: (0, 0, 0))
        precondition(complex.matched, "a complete complex stroke should match")
        precondition(Date().timeIntervalSince(started) < 8, "complex stroke verification must finish promptly")
        let widthBefore = [UInt8](repeating: 255, count: 80 * 80 * 4)
        func band(_ thickness: Int) -> [UInt8] {
            var bytes = widthBefore
            for y in (40 - thickness / 2)..<(40 - thickness / 2 + thickness) { for x in 10...70 {
                let i = (y * 80 + x) * 4
                bytes[i] = 220; bytes[i + 1] = 20; bytes[i + 2] = 30
            } }
            return bytes
        }
        let widthPath = [[CGPoint(x: 10, y: 40), CGPoint(x: 70, y: 40)]]
        let densePath = [Array(10...70).map { CGPoint(x: $0, y: 40) }]
        precondition(inspectBrushWidth(before: widthBefore, after: band(6), width: 80, height: 80, paths: densePath, expectedWidth: 6).matched, "dense short segments must not falsely reject a valid stroke")
        let correctWidth = inspectBrushWidth(before: widthBefore, after: band(6), width: 80, height: 80, paths: widthPath, expectedWidth: 6)
        precondition(correctWidth.matched && correctWidth.measuredWidth == 6, "actual six pixel mark should pass")
        precondition(!inspectBrushWidth(before: widthBefore, after: band(1), width: 80, height: 80, paths: widthPath, expectedWidth: 6).matched, "thin arcs are not a wide fill brush")
        precondition(!inspectBrushWidth(before: widthBefore, after: band(18), width: 80, height: 80, paths: widthPath, expectedWidth: 6).matched, "too-wide mark must stop before continuation")
        precondition(!inspectBrushWidth(before: widthBefore, after: widthBefore, width: 80, height: 80, paths: widthPath, expectedWidth: 6).matched, "no changed pixels cannot establish brush width")
        let allowed = [CGPoint(x: 5, y: 37), CGPoint(x: 75, y: 37), CGPoint(x: 75, y: 44), CGPoint(x: 5, y: 44)]
        precondition(inspectPaintRegion(before: widthBefore, after: band(6), width: 80, height: 80, paths: widthPath, region: allowed, expectedWidth: 6), "in-region marks pass")
        precondition(!inspectPaintRegion(before: widthBefore, after: band(18), width: 80, height: 80, paths: widthPath, region: allowed, expectedWidth: 6), "actual paint spilling outside its region must fail")
        // Same-color overlap at endpoints should pass when before & after both hold the expected non-white color
        var overlapBefore = widthBefore
        for y in 37...43 { for x in 8...22 {
            let i = (y * 80 + x) * 4
            overlapBefore[i] = 220; overlapBefore[i + 1] = 20; overlapBefore[i + 2] = 30
        } }
        var overlapAfter = overlapBefore
        for y in 38...42 { for x in 20...70 {
            let i = (y * 80 + x) * 4
            overlapAfter[i] = 220; overlapAfter[i + 1] = 20; overlapAfter[i + 2] = 30
        } }
        let overlapPass = inspectPaint(before: overlapBefore, after: overlapAfter, width: 80, height: 80, paths: widthPath, expected: (220, 20, 30))
        precondition(overlapPass.matched, "overlapping same-color paint at start endpoint must pass")
        var truncatedOnWhite = overlapBefore
        for y in 38...42 { for x in 20...50 {
            let i = (y * 80 + x) * 4
            truncatedOnWhite[i] = 220; truncatedOnWhite[i + 1] = 20; truncatedOnWhite[i + 2] = 30
        } }
        let overlapTruncated = inspectPaint(before: overlapBefore, after: truncatedOnWhite, width: 80, height: 80, paths: widthPath, expected: (220, 20, 30))
        precondition(!overlapTruncated.matched, "truncated stroke ending on empty canvas must still fail")
        // Fill interior check: solid box passes, thin hollow outline fails
        let fillPoly = [[CGPoint(x: 15, y: 15), CGPoint(x: 65, y: 15), CGPoint(x: 65, y: 65), CGPoint(x: 15, y: 65)]]
        var solidFill = widthBefore
        for y in 15...65 { for x in 15...65 {
            let i = (y * 80 + x) * 4
            solidFill[i] = 220; solidFill[i + 1] = 20; solidFill[i + 2] = 30
        } }
        precondition(inspectFillInterior(before: widthBefore, after: solidFill, width: 80, height: 80, paths: fillPoly, expected: (220, 20, 30)), "solid fill interior must pass")
        var hollowOutline = widthBefore
        for y in 15...65 { for x in 15...65 {
            if x <= 16 || x >= 64 || y <= 16 || y >= 64 {
                let i = (y * 80 + x) * 4
                hollowOutline[i] = 220; hollowOutline[i + 1] = 20; hollowOutline[i + 2] = 30
            }
        } }
        precondition(!inspectFillInterior(before: widthBefore, after: hollowOutline, width: 80, height: 80, paths: fillPoly, expected: (220, 20, 30)), "hollow outline without fill must fail inspectFillInterior")
        // Subtle layered fill contrast (L1 diff 43 < 45, e.g. #4065bf over #3057b2) must pass when matchesExpectedColor holds
        var subtleBefore = [UInt8](repeating: 255, count: 80 * 80 * 4)
        var subtleAfter = subtleBefore
        for y in 0..<80 { for x in 0..<80 {
            let i = (y * 80 + x) * 4
            subtleBefore[i] = 48; subtleBefore[i + 1] = 87; subtleBefore[i + 2] = 178
            subtleAfter[i] = 48; subtleAfter[i + 1] = 87; subtleAfter[i + 2] = 178
        } }
        for y in 15...65 { for x in 15...65 {
            let i = (y * 80 + x) * 4
            subtleAfter[i] = 64; subtleAfter[i + 1] = 101; subtleAfter[i + 2] = 191
        } }
        precondition(inspectFillInterior(before: subtleBefore, after: subtleAfter, width: 80, height: 80, paths: fillPoly, expected: (64, 101, 191)), "subtle layered fill contrast L1=43 must pass")
        // Aggregate fill mode allows a small rounded polygon (~58% interior) inside a >=70% batch while still rejecting hollow or dropped shapes
        let smallPoly = [CGPoint(x: 4, y: 4), CGPoint(x: 16, y: 4), CGPoint(x: 16, y: 16), CGPoint(x: 4, y: 16)]
        let largePoly = [CGPoint(x: 25, y: 10), CGPoint(x: 75, y: 10), CGPoint(x: 75, y: 70), CGPoint(x: 25, y: 70)]
        var aggFillAfter = widthBefore
        for y in 6...14 { for x in 6...14 {
            let i = (y * 80 + x) * 4
            aggFillAfter[i] = 96; aggFillAfter[i + 1] = 148; aggFillAfter[i + 2] = 235
        } }
        for y in 10...70 { for x in 25...75 {
            let i = (y * 80 + x) * 4
            aggFillAfter[i] = 96; aggFillAfter[i + 1] = 148; aggFillAfter[i + 2] = 235
        } }
        precondition(!inspectFillInterior(before: widthBefore, after: aggFillAfter, width: 80, height: 80, paths: [smallPoly, largePoly], expected: (96, 148, 235), aggregate: false), "strict mode rejects <70% corner-rounded small fill")
        precondition(inspectFillInterior(before: widthBefore, after: aggFillAfter, width: 80, height: 80, paths: [smallPoly, largePoly], expected: (96, 148, 235), aggregate: true), "aggregate fill mode accepts corner-rounded small fill when batch pooled >=70%")
        precondition(!inspectFillInterior(before: widthBefore, after: hollowOutline, width: 80, height: 80, paths: fillPoly, expected: (220, 20, 30), aggregate: true), "aggregate fill mode still rejects hollow outline")
        var partialDropAfter = widthBefore
        for y in 10...70 { for x in 25...75 {
            let i = (y * 80 + x) * 4
            partialDropAfter[i] = 96; partialDropAfter[i + 1] = 148; partialDropAfter[i + 2] = 235
        } }
        precondition(!inspectFillInterior(before: widthBefore, after: partialDropAfter, width: 80, height: 80, paths: [smallPoly, largePoly], expected: (96, 148, 235), aggregate: true), "aggregate fill mode still fails closed if any polygon was dropped")
        // Batch of small-only corner-rounded polygons (~62% pooled, like hair highlights) must pass aggregate fill mode
        let smallA = [CGPoint(x: 4, y: 4), CGPoint(x: 20, y: 4), CGPoint(x: 20, y: 20), CGPoint(x: 4, y: 20)]
        let smallB = [CGPoint(x: 30, y: 30), CGPoint(x: 46, y: 30), CGPoint(x: 46, y: 46), CGPoint(x: 30, y: 46)]
        var smallOnlyAfter = widthBefore
        for y in 6...17 { for x in 6...17 { let i = (y * 80 + x) * 4; smallOnlyAfter[i] = 173; smallOnlyAfter[i + 1] = 170; smallOnlyAfter[i + 2] = 174 } }
        for y in 32...43 { for x in 32...43 { let i = (y * 80 + x) * 4; smallOnlyAfter[i] = 173; smallOnlyAfter[i + 1] = 170; smallOnlyAfter[i + 2] = 174 } }
        precondition(inspectFillInterior(before: widthBefore, after: smallOnlyAfter, width: 80, height: 80, paths: [smallA, smallB], expected: (173, 170, 174), aggregate: true), "all-small aggregate fill batch (~60%) must pass")
        // Near-white highlight crossing from dark area onto white region passes with >=20% newly changed samples, while near-white on blank fails
        var whiteHighlightBefore = widthBefore
        for y in 20...26 { for x in 10...35 { let i = (y * 80 + x) * 4; whiteHighlightBefore[i] = 48; whiteHighlightBefore[i + 1] = 87; whiteHighlightBefore[i + 2] = 178 } }
        var whiteHighlightAfter = whiteHighlightBefore
        for y in 21...23 { for x in 10...35 { let i = (y * 80 + x) * 4; whiteHighlightAfter[i] = 251; whiteHighlightAfter[i + 1] = 251; whiteHighlightAfter[i + 2] = 252 } }
        let highlightPath = [[CGPoint(x: 10, y: 22), CGPoint(x: 50, y: 22)]]
        precondition(inspectAggregatePaint(before: whiteHighlightBefore, after: whiteHighlightAfter, width: 80, height: 80, paths: highlightPath, expected: (251, 251, 252), brushRadius: 2).matched, "near-white highlight crossing into white must pass when >=20% changed")
        precondition(!inspectAggregatePaint(before: widthBefore, after: widthBefore, width: 80, height: 80, paths: highlightPath, expected: (251, 251, 252), brushRadius: 2).matched, "near-white stroke on blank white must fail")
        // Inset corner-rounded fill (like small cheek/shadow polygons) passes verifyAggregateFill even when outer edge agg coverage < 70%
        let insetEdgeAggMissed = AggregatePaintInspection(matched: false, changedPixels: 200, matchedPixels: 170, totalSamples: 50, coveredSamples: 31)
        precondition(verifyAggregateFill(before: widthBefore, after: smallOnlyAfter, width: 80, height: 80, paths: [smallA, smallB], expected: (173, 170, 174), agg: insetEdgeAggMissed), "verifyAggregateFill accepts solid inset fill when boundary color match >=30%")
        let wrongEdgeSpillAgg = AggregatePaintInspection(matched: false, changedPixels: 200, matchedPixels: 20, totalSamples: 50, coveredSamples: 31)
        precondition(!verifyAggregateFill(before: widthBefore, after: smallOnlyAfter, width: 80, height: 80, paths: [smallA, smallB], expected: (173, 170, 174), agg: wrongEdgeSpillAgg), "verifyAggregateFill rejects severe wrong-color perimeter spill")
        // canvasInteriorHash ignores outer inset chrome and detects interior paint
        func writeRGBA(_ bytes: [UInt8], width w: Int, height h: Int) -> URL {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".png")
            let prov = CGDataProvider(data: Data(bytes) as CFData)!
            let cg = CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4,
                             space: CGColorSpaceCreateDeviceRGB(),
                             bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue),
                             provider: prov, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
            let dst = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)!
            CGImageDestinationAddImage(dst, cg, nil)
            precondition(CGImageDestinationFinalize(dst))
            return url
        }
        let roiA = [UInt8](repeating: 255, count: 40 * 40 * 4)
        var roiChromeChanged = roiA
        for x in 0..<40 {
            let topIdx = x * 4
            roiChromeChanged[topIdx] = 10; roiChromeChanged[topIdx + 1] = 20; roiChromeChanged[topIdx + 2] = 30
        }
        var roiInteriorChanged = roiA
        let midIdx = (20 * 40 + 20) * 4
        roiInteriorChanged[midIdx] = 10; roiInteriorChanged[midIdx + 1] = 20; roiInteriorChanged[midIdx + 2] = 30
        let urlA = writeRGBA(roiA, width: 40, height: 40)
        let urlB = writeRGBA(roiChromeChanged, width: 40, height: 40)
        let urlC = writeRGBA(roiInteriorChanged, width: 40, height: 40)
        defer { try? FileManager.default.removeItem(at: urlA); try? FileManager.default.removeItem(at: urlB); try? FileManager.default.removeItem(at: urlC) }
        let hashA = canvasInteriorHash(imagePath: urlA.path, insetLeft: 0, insetTop: 4, insetRight: 4, insetBottom: 4)!
        let hashB = canvasInteriorHash(imagePath: urlB.path, insetLeft: 0, insetTop: 4, insetRight: 4, insetBottom: 4)!
        let hashC = canvasInteriorHash(imagePath: urlC.path, insetLeft: 0, insetTop: 4, insetRight: 4, insetBottom: 4)!
        precondition(hashA == hashB, "chrome-only border changes outside ROI must produce identical hash")
        precondition(hashA != hashC, "interior canvas change must produce a different hash")

        // Aggregate batch verification: overlapping multi-stroke lines pass while wrong color or missing strokes fail
        var multiAfter = widthBefore
        for y in 20...22 { for x in 10...60 { let i = (y * 80 + x) * 4; multiAfter[i] = 220; multiAfter[i + 1] = 20; multiAfter[i + 2] = 30 } }
        for y in 22...24 { for x in 12...62 { let i = (y * 80 + x) * 4; multiAfter[i] = 220; multiAfter[i + 1] = 20; multiAfter[i + 2] = 30 } }
        let touchPaths = [
            [CGPoint(x: 10, y: 21), CGPoint(x: 60, y: 21)],
            [CGPoint(x: 12, y: 23), CGPoint(x: 62, y: 23)],
        ]
        precondition(!inspectBrushWidth(before: widthBefore, after: multiAfter, width: 80, height: 80, paths: touchPaths, expectedWidth: 3).matched, "strict per-stroke width can fail on touching batch strokes")
        let aggPass = inspectAggregatePaint(before: widthBefore, after: multiAfter, width: 80, height: 80, paths: touchPaths, expected: (220, 20, 30), brushRadius: 2)
        precondition(aggPass.matched, "aggregate paint verification must accept touching strokes of matching color")
        let aggWrongColor = inspectAggregatePaint(before: widthBefore, after: multiAfter, width: 80, height: 80, paths: touchPaths, expected: (20, 40, 220), brushRadius: 2)
        precondition(!aggWrongColor.matched, "aggregate paint verification must reject wrong color")
        let aggNoPaint = inspectAggregatePaint(before: widthBefore, after: widthBefore, width: 80, height: 80, paths: touchPaths, expected: (220, 20, 30), brushRadius: 2)
        precondition(!aggNoPaint.matched, "aggregate paint verification must reject blank canvas")

        // Brush-aware verification: Watercolor/Marker translucent blending + Pencil grain vs opaque strictness & wrong-hue rejection
        precondition(brushStyle(forTool: "Watercolor") == .translucent)
        precondition(brushStyle(forTool: "Marker") == .translucent)
        precondition(brushStyle(forTool: "Pencil") == .graphite)
        precondition(brushStyle(forTool: "Crayon") == .graphite)
        precondition(brushStyle(forTool: "Fountain Pen") == .calligraphic)
        precondition(brushStyle(forTool: "Monoline") == .opaque)
        precondition(brushStyle(forTool: nil) == .opaque)

        // Watercolor light blue glaze over white (#3888FF -> ~(153,194,253)) passes translucent, fails opaque, and fails wrong-hue
        var glazeAfter = widthBefore
        for y in 18...34 {
            for x in 12...64 {
                let i = (y * 80 + x) * 4
                glazeAfter[i] = 153; glazeAfter[i + 1] = 194; glazeAfter[i + 2] = 253
            }
        }
        let glazePaths = [[CGPoint(x: 12, y: 26), CGPoint(x: 64, y: 26)]]
        precondition(!inspectPaint(before: widthBefore, after: glazeAfter, width: 80, height: 80, paths: glazePaths, expected: (0x38, 0x88, 0xFF), style: .opaque).matched, "opaque strict verification must still reject dilute translucent glaze")
        precondition(inspectPaint(before: widthBefore, after: glazeAfter, width: 80, height: 80, paths: glazePaths, expected: (0x38, 0x88, 0xFF), style: .translucent).matched, "translucent mode accepts lightened glaze along white->expected")
        precondition(inspectBrushWidth(before: widthBefore, after: glazeAfter, width: 80, height: 80, paths: glazePaths, expectedWidth: 16, style: .translucent).matched, "translucent width check measures soft wash band")
        precondition(!inspectPaint(before: widthBefore, after: glazeAfter, width: 80, height: 80, paths: glazePaths, expected: (0xFF, 0x38, 0x48), style: .translucent).matched, "translucent mode must reject wrong red hue on blue glaze")
        precondition(!inspectAggregatePaint(before: widthBefore, after: glazeAfter, width: 80, height: 80, paths: glazePaths, expected: (0xFF, 0x38, 0x48), brushRadius: 8, style: .translucent).matched, "aggregate translucent mode must reject wrong red hue")
        precondition(inspectAggregatePaint(before: widthBefore, after: glazeAfter, width: 80, height: 80, paths: glazePaths, expected: (0x38, 0x88, 0xFF), brushRadius: 8, style: .translucent).matched, "aggregate translucent mode accepts watercolor wash")

        // Translucent Marker #FF6B8B over existing cobalt #2855B8 yields multiply/alpha mix ~(69,53,116)
        var cobaltBefore = widthBefore
        for i in stride(from: 0, to: cobaltBefore.count, by: 4) {
            cobaltBefore[i] = 40; cobaltBefore[i + 1] = 85; cobaltBefore[i + 2] = 184
        }
        var blushOverCobalt = cobaltBefore
        for y in 20...32 {
            for x in 15...60 {
                let i = (y * 80 + x) * 4
                blushOverCobalt[i] = 69; blushOverCobalt[i + 1] = 53; blushOverCobalt[i + 2] = 116
            }
        }
        precondition(inspectAggregatePaint(before: cobaltBefore, after: blushOverCobalt, width: 80, height: 80, paths: glazePaths, expected: (0xFF, 0x6B, 0x8B), brushRadius: 6, style: .translucent).matched, "translucent multiply hull accepts Marker #FF6B8B glazed over #2855B8")
        precondition(!inspectAggregatePaint(before: cobaltBefore, after: blushOverCobalt, width: 80, height: 80, paths: glazePaths, expected: (0x18, 0xC0, 0x40), brushRadius: 6, style: .translucent).matched, "translucent multiply hull rejects unrelated green hue over #2855B8")
        precondition(!inspectAggregatePaint(before: cobaltBefore, after: cobaltBefore, width: 80, height: 80, paths: glazePaths, expected: (0xFF, 0x6B, 0x8B), brushRadius: 6, style: .translucent).matched, "translucent mode rejects un-painted canvas")

        // Graphite Pencil sketch (#4C5B73): light ~32% opacity + 1px paper grain holes passes .graphite, rejects wrong orange hue
        var pencilAfter = widthBefore
        for y in 20...23 {
            for x in 12...64 {
                if (x + y) % 5 == 0 { continue } // simulated 1px paper grain gap
                let i = (y * 80 + x) * 4
                pencilAfter[i] = 180; pencilAfter[i + 1] = 186; pencilAfter[i + 2] = 196
            }
        }
        let pencilPath = [[CGPoint(x: 12, y: 22), CGPoint(x: 64, y: 22)]]
        precondition(inspectPaint(before: widthBefore, after: pencilAfter, width: 80, height: 80, paths: pencilPath, expected: (0x4C, 0x5B, 0x73), style: .graphite).matched, "graphite mode accepts light pencil line")
        precondition(inspectBrushWidth(before: widthBefore, after: pencilAfter, width: 80, height: 80, paths: pencilPath, expectedWidth: 4, style: .graphite).matched, "graphite width bridges 1px paper grain gaps")
        precondition(inspectAggregatePaint(before: widthBefore, after: pencilAfter, width: 80, height: 80, paths: pencilPath, expected: (0x4C, 0x5B, 0x73), brushRadius: 3, style: .graphite).matched, "aggregate graphite accepts pencil sketch strokes")
        precondition(!inspectPaint(before: widthBefore, after: pencilAfter, width: 80, height: 80, paths: pencilPath, expected: (0xF0, 0x70, 0x10), style: .graphite).matched, "graphite mode rejects warm orange expected hex on slate pencil mark")

        // Calligraphic Fountain Pen stroke varying 2..5px passes .calligraphic when declared expectedWidth=3
        var calAfter = widthBefore
        for x in 12...64 {
            let half = x < 38 ? 1 : 2
            for y in (22 - half)...(22 + half) {
                let i = (y * 80 + x) * 4
                calAfter[i] = 20; calAfter[i + 1] = 30; calAfter[i + 2] = 45
            }
        }
        precondition(inspectBrushWidth(before: widthBefore, after: calAfter, width: 80, height: 80, paths: pencilPath, expectedWidth: 3, style: .calligraphic).matched, "calligraphic mode tolerates natural nib taper")

        // Borderline pastel (#FFE6D7, chroma=40) rendered with P3 rounding (255,230,216) + AA (255,234,222) passes,
        // while neutral grey (225,225,225) and opposite blue pastel (215,230,255) remain rejected.
        var pastelAfter = widthBefore
        var greyAfter = widthBefore
        var bluePastelAfter = widthBefore
        for x in 12...64 {
            for y in 20...24 {
                let i = (y * 80 + x) * 4
                let edge = (y == 20 || y == 24)
                pastelAfter[i] = 255
                pastelAfter[i + 1] = edge ? 234 : 230
                pastelAfter[i + 2] = edge ? 222 : 216
                greyAfter[i] = 225; greyAfter[i + 1] = 225; greyAfter[i + 2] = 225
                bluePastelAfter[i] = 215; bluePastelAfter[i + 1] = 230; bluePastelAfter[i + 2] = 255
            }
        }
        precondition(inspectAggregatePaint(before: widthBefore, after: pastelAfter, width: 80, height: 80, paths: pencilPath, expected: (0xFF, 0xE6, 0xD7), brushRadius: 3, style: .opaque).matched, "borderline pastel accepts P3-rounded skin stroke")
        precondition(!inspectAggregatePaint(before: widthBefore, after: greyAfter, width: 80, height: 80, paths: pencilPath, expected: (0xFF, 0xE6, 0xD7), brushRadius: 3, style: .opaque).matched, "borderline pastel rejects neutral grey stroke")
        precondition(!inspectAggregatePaint(before: widthBefore, after: bluePastelAfter, width: 80, height: 80, paths: pencilPath, expected: (0xFF, 0xE6, 0xD7), brushRadius: 3, style: .opaque).matched, "borderline pastel rejects cool blue pastel stroke")

        print("paint verification tests passed")
    }
}
