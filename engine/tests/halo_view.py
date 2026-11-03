#!/usr/bin/env python3
"""Compile actual native halo view code and exercise its input behavior without UI.

The engine is a single-file executable. Extract only its view declarations so
this regression never dispatches an engine command or changes a user's desktop.
"""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
source = (root / 'Sources/main.swift').read_text()
views = source[source.index('final class HaloView:'):source.index('final class HaloPanel:')]
checks = r'''
let view = HaloView(frame: NSRect(x: 0, y: 0, width: 640, height: 480))
view.label = "Test target"
for point in [NSPoint(x: 20, y: 460), NSPoint(x: 300, y: 460),
              NSPoint(x: 320, y: 240), NSPoint(x: 3, y: 3)] {
    if view.hitTest(point) != nil {
        fputs("FAIL: decorative halo captures input at \(point)\n", stderr)
        exit(1)
    }
}
view.setReducedMotion(false)
let glow = view.layer!.sublayers!.first!
assert(glow.animation(forKey: "breathing") != nil)
view.setReducedMotion(true)
assert(glow.animation(forKey: "breathing") == nil)
view.setReducedMotion(false)
assert(glow.animation(forKey: "breathing") != nil)
let stop = HaloStopView(frame: NSRect(x: 0, y: 0, width: 300, height: 28))
var stopped = 0
stop.onStop = { stopped += 1 }
assert(stop.accessibilityPerformPress())
assert(stopped == 1)
assert(stop.hitTest(NSPoint(x: 290, y: 14)) === stop)
assert(stop.hitTest(NSPoint(x: 310, y: 14)) == nil)
view.frame.size = NSSize(width: 800, height: 600)
view.layout()
assert(view.layer!.sublayers!.last!.bounds.size == view.bounds.size)
print("PASS: halo input, resize, reduced-motion transitions and accessible Stop")
'''
with tempfile.TemporaryDirectory(prefix='cu-halo-test-') as tmp:
    main = Path(tmp) / 'main.swift'
    binary = Path(tmp) / 'test'
    main.write_text('import AppKit\nimport QuartzCore\n' + views + checks)
    subprocess.run(['swiftc', '-swift-version', '5', '-target', 'arm64-apple-macos14.0',
                    '-framework', 'AppKit', '-framework', 'QuartzCore',
                    str(main), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
