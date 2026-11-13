import Foundation
import CoreGraphics
import ImageIO

@main
struct VectorPaintPlanTest {
    static func writeTestPNG(_ pixels: [UInt8], width: Int, height: Int, to url: URL) {
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        let prov = CGDataProvider(data: Data(pixels) as CFData)!
        let img = CGImage(
            width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: width * 4, space: cs,
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue),
            provider: prov, decode: nil, shouldInterpolate: false, intent: .defaultIntent
        )!
        let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)!
        CGImageDestinationAddImage(dest, img, nil)
        precondition(CGImageDestinationFinalize(dest))
    }

    static func length(_ pts: [[Double]]) -> Double {
        var total = 0.0
        for i in 1..<pts.count {
            total += hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
        }
        return total
    }

    static func main() throws {
        // Synthetic composition on black backdrop (like anime sticker):
        // Outer white frame/circle, blue base disc, peach face inside, thin black line + white dot highlight.
        let side = 160
        var rgba = [UInt8](repeating: 0, count: side * side * 4)
        for p in 0..<(side * side) { rgba[p * 4 + 3] = 255 }
        for y in 0..<side {
            for x in 0..<side {
                let dx = Double(x - 80), dy = Double(y - 80), r = hypot(dx, dy)
                let i = (y * side + x) * 4
                if r <= 64 && r > 56 {
                    // White outer sticker ring enclosing blue interior
                    rgba[i] = 255; rgba[i + 1] = 255; rgba[i + 2] = 255
                } else if r <= 56 && r > 32 {
                    // Blue hair ring enclosing inner skin circle
                    rgba[i] = 30; rgba[i + 1] = 90; rgba[i + 2] = 210
                } else if r <= 32 {
                    // Inner peach circle
                    rgba[i] = 250; rgba[i + 1] = 225; rgba[i + 2] = 205
                }
                // Thin dark mouth arc across inner peach circle
                if abs(dy - 8.0) <= 1.2 && abs(dx) <= 14 {
                    rgba[i] = 15; rgba[i + 1] = 15; rgba[i + 2] = 20
                }
            }
        }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("vp-test-\(UUID().uuidString).png")
        let previewURL = FileManager.default.temporaryDirectory.appendingPathComponent("vp-prev-\(UUID().uuidString).png")
        writeTestPNG(rgba, width: side, height: side, to: tmp)
        defer { try? FileManager.default.removeItem(at: tmp); try? FileManager.default.removeItem(at: previewURL) }

        let rect = CGRect(x: 100, y: 120, width: 600, height: 600)
        let plan = try buildVectorPaintPlan(imagePath: tmp.path, rect: rect, grid: 160, colors: 8, seed: 12345, bgMode: "auto")
        precondition(!plan.batches.isEmpty, "must produce vector batches")
        precondition(plan.totalStrokes >= 4 && plan.totalStrokes < 80, "vector compiler must produce compact stroke count, got \(plan.totalStrokes)")

        // Every emitted stroke must obey Freeform / cu strokes geometry limits and stay inside rect.
        for batch in plan.batches {
            precondition(!batch.strokes.isEmpty)
            for s in batch.strokes {
                precondition(s.count >= 2 && s.count <= 240, "stroke points out of range: \(s.count)")
                precondition(length(s) <= 1150, "stroke length exceeds engine limit: \(length(s))")
                for pt in s {
                    precondition(pt[0] >= rect.minX && pt[0] <= rect.maxX && pt[1] >= rect.minY && pt[1] <= rect.maxY, "point escaped rect")
                }
                if batch.tool == "Fill" {
                    precondition(s.count >= 4 && abs(s.first![0] - s.last![0]) < 1e-6 && abs(s.first![1] - s.last![1]) < 1e-6, "Fill stroke must be closed loop")
                }
            }
        }

        // Verify painter Z-order: outer Fill polygons run before smaller enclosed peach/fill polygons, and ink runs after fills.
        let batchRoles = plan.batches.map(\.role)
        let lastFill = batchRoles.lastIndex(of: "fill") ?? -1
        let firstInk = batchRoles.firstIndex(of: "ink") ?? batchRoles.count
        precondition(lastFill < firstInk, "fills must complete before ink lineart runs")

        let blueFillIdx = plan.batches.firstIndex { $0.role == "fill" && $0.rgb.2 > 150 && $0.rgb.0 < 90 }!
        let skinFillIdx = plan.batches.firstIndex { $0.role == "fill" && $0.rgb.0 > 210 && $0.rgb.1 > 190 && $0.rgb.2 < 230 }!
        precondition(blueFillIdx < skinFillIdx, "outer enclosing blue ring must paint before enclosed skin circle")

        try writeVectorPreviewPNG(plan.previewRGBA, grid: plan.grid, to: previewURL.path)
        let bytes = try Data(contentsOf: previewURL)
        precondition(bytes.count > 100 && bytes[0] == 0x89 && bytes[1] == 0x50, "must write valid preview PNG")
        print("vector paint plan tests passed (batches=\(plan.batches.count) strokes=\(plan.totalStrokes))")
    }
}
