#!/usr/bin/env python3
"""Compile the actual cursor-overlay view and assert its screen-edge rim behaviour.

The rim used to be a radial gradient with a ~1000 pt radius, which washed a huge
tint over the desktop and stayed on for the whole session. This regression pins
the corrected contract, without touching the user's screen:

  * armed but idle  -> fully transparent (no ambient glow)
  * an action pulse -> a narrow rim (<= 100 pt) on all four edges, centre clear
  * ~2 s later      -> transparent again (the fade is scheduled, not permanent)
  * breath animation exists; overlay notes activity for the idle-exit watchdog
"""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
source = (root / 'Sources/VisualFeedback.swift').read_text()
start = source.index('final class CursorLayerView: NSView {')
views = source[start:]

checks = r'''
let width: CGFloat = 1728
let height: CGFloat = 1117
let view = CursorLayerView(frame: NSRect(x: 0, y: 0, width: width, height: height))
view.layout()

let rootLayer = view.layer!
guard let auraContainer = rootLayer.sublayers?.first,
      let auraBreath = auraContainer.sublayers?.first else {
    fputs("FAIL: aura layers missing\n", stderr); exit(1)
}
let bands = auraBreath.sublayers ?? []
if bands.count != 4 { fputs("FAIL: expected 4 rim bands, got \(bands.count)\n", stderr); exit(1) }
if auraBreath.animation(forKey: "breath") == nil {
    fputs("FAIL: breathing animation missing\n", stderr); exit(1)
}

func render() -> NSBitmapImageRep {
    let w = Int(width), h = Int(height)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h,
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                               isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    let context = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.current = context
    context.cgContext.clear(CGRect(x: 0, y: 0, width: w, height: h))
    view.layer!.render(in: context.cgContext)
    NSGraphicsContext.restoreGraphicsState()
    return rep
}

func alpha(_ rep: NSBitmapImageRep, _ x: Int, _ y: Int) -> Int {
    guard let data = rep.bitmapData else { return 0 }
    let offset = y * rep.bytesPerRow + x * 4
    return Int(data[offset + 3])
}

func rimDepth(_ rep: NSBitmapImageRep, _ xs: [Int], _ ys: [Int]) -> Int {
    var maxRun = 0
    for (x, y) in zip(xs, ys) {
        var run = 0
        var (px, py) = (x, y)
        while px >= 0 && px < Int(width) && py >= 0 && py < Int(height) && alpha(rep, px, py) > 6 {
            run += 1
            px += (x == 0 ? 1 : (x == Int(width) - 1 ? -1 : 0))
            py += (y == 0 ? 1 : (y == Int(height) - 1 ? -1 : 0))
        }
        maxRun = max(maxRun, run)
    }
    return maxRun
}

func edgeAlphas(_ rep: NSBitmapImageRep) -> [Int] {
    let w = Int(width), h = Int(height)
    // Bitmap row 0 is the top and the layer origin is bottom-left; probe both
    // symmetric edges so orientation cannot hide a failure.
    return [alpha(rep, w / 2, 2), alpha(rep, w / 2, h - 3),
            alpha(rep, 2, h / 2), alpha(rep, w - 3, h / 2)]
}

// 1. Armed but idle: nothing on screen.
view.setAura(true)
var frame = render()
if edgeAlphas(frame).contains(where: { $0 > 2 }) {
    fputs("FAIL: armed state draws ambient rim (old permanent-glow bug)\n", stderr); exit(1)
}

// 2. An action pulse lights a narrow rim on every edge and keeps the centre clear.
view.pulseAura()
frame = render()
let edges = edgeAlphas(frame)
if !edges.allSatisfy({ $0 > 15 }) {
    fputs("FAIL: pulse did not light all four edges: \(edges)\n", stderr); exit(1)
}
let w = Int(width), h = Int(height)
for x in stride(from: 200, to: w - 200, by: 120) {
    for y in stride(from: 200, to: h - 200, by: 120) {
        if alpha(frame, x, y) > 2 {
            fputs("FAIL: centre pixel (\(x),\(y)) tinted alpha=\(alpha(frame, x, y))\n", stderr); exit(1)
        }
    }
}
let depth = rimDepth(frame, [0, w - 1, w / 2, w / 2], [h / 2, h / 2, 0, h - 1])
if depth > 100 {
    fputs("FAIL: rim is \(depth)pt wide; it must stay a narrow edge band\n", stderr); exit(1)
}

// 3. The rim is transient: fading removes it completely.
view.fadeAura()
frame = render()
if edgeAlphas(frame).contains(where: { $0 > 2 }) {
    fputs("FAIL: rim still visible after fade\n", stderr); exit(1)
}

// 4. Activity is recorded for the overlay's idle-exit watchdog.
let before = view.lastActivityAt
usleep(30_000)
view.noteActivity()
if !(view.lastActivityAt > before) {
    fputs("FAIL: noteActivity did not update the activity timestamp\n", stderr); exit(1)
}

print("PASS: aura armed-idle transparent, pulse draws <=\(depth)pt four-edge rim, centre clear, fade clears, activity tracked")
'''

with tempfile.TemporaryDirectory(prefix='cu-aura-test-') as tmp:
    main = Path(tmp) / 'main.swift'
    binary = Path(tmp) / 'test'
    main.write_text('import AppKit\nimport QuartzCore\n' + views + checks)
    subprocess.run(['swiftc', '-swift-version', '5', '-target', 'arm64-apple-macos14.0',
                    '-framework', 'AppKit', '-framework', 'QuartzCore',
                    str(main), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
