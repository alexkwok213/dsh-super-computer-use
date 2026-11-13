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
        print("paint verification tests passed")
    }
}
