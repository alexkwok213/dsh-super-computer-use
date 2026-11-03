#!/usr/bin/env python3
"""Render the real halo layers offscreen; never opens or activates a window."""
from pathlib import Path
import subprocess
import tempfile
root = Path(__file__).resolve().parents[1]
source = (root / 'Sources/main.swift').read_text()
views = source[source.index('final class HaloView:'):source.index('final class HaloPanel:')]
program = r'''
let size = NSSize(width: 760, height: 480)
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1520, pixelsHigh: 960,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
bitmap.size = size
let context = NSGraphicsContext(bitmapImageRep: bitmap)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
NSColor(srgbRed: 0.045, green: 0.055, blue: 0.08, alpha: 1).setFill()
NSRect(origin: .zero, size: size).fill()
NSColor(srgbRed: 0.10, green: 0.12, blue: 0.16, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 40, y: 40, width: 680, height: 400), xRadius: 12, yRadius: 12).fill()
("Computer Use · Native preview" as NSString).draw(at: NSPoint(x: 72, y: 355),
    withAttributes: [.font: NSFont.systemFont(ofSize: 23, weight: .semibold), .foregroundColor: NSColor.white])
("Blue / cyan / violet • Core Animation" as NSString).draw(at: NSPoint(x: 72, y: 320),
    withAttributes: [.font: NSFont.systemFont(ofSize: 14), .foregroundColor: NSColor.lightGray])
for y in [220, 178, 136] {
    NSColor.white.withAlphaComponent(0.06).setFill()
    NSBezierPath(roundedRect: NSRect(x: 72, y: y, width: 580, height: 26), xRadius: 6, yRadius: 6).fill()
}
let halo = HaloView(frame: NSRect(x: 0, y: 0, width: 704, height: 424))
context.cgContext.saveGState()
context.cgContext.translateBy(x: 28, y: 28)
halo.layer!.render(in: context.cgContext)
context.cgContext.restoreGState()
let stop = HaloStopView(frame: NSRect(x: 0, y: 0, width: 300, height: 28))
stop.label = "DSH · Inspecting the target window"
context.cgContext.saveGState()
context.cgContext.translateBy(x: 44, y: 406)
stop.draw(stop.bounds)
context.cgContext.restoreGState()
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
'''
with tempfile.TemporaryDirectory(prefix='cu-halo-preview-') as tmp:
    main = Path(tmp) / 'main.swift'
    binary = Path(tmp) / 'preview'
    main.write_text('import AppKit\nimport QuartzCore\n' + views + program)
    subprocess.run(['swiftc', '-swift-version', '5', '-target', 'arm64-apple-macos14.0',
                    '-framework', 'AppKit', '-framework', 'QuartzCore', str(main), '-o', str(binary)], check=True)
    subprocess.run([str(binary), str(root / 'build/halo-preview.png')], check=True)
print(root / 'build/halo-preview.png')
