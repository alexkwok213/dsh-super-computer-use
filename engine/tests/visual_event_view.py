"""Render the real CursorLayerView offscreen and prove F6: a disabled edge rim
stays disabled through cursor/click/label, and demo mode can re-arm it.
No desktop window is opened.

    python3 -B engine/tests/visual_event_view.py
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent  # engine/
SOURCE = (ROOT / "Sources" / "VisualFeedback.swift").read_text()
START = "final class CursorLayerView: NSView {"
END = "// MARK: - capture daemon"
VIEW = SOURCE[SOURCE.index(START):]

CHECK = r"""
let view = CursorLayerView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
view.layout()
let rim = view.layer!.sublayers!.first!
view.setAura(false)
let disabled = Double(rim.opacity)
view.pulseAura()
let afterPulse = Double(rim.opacity)
view.showCursor(at: CGPoint(x: 120, y: 90), glide: true)
view.clickRipple(at: CGPoint(x: 120, y: 90))
view.showLabel("点击", at: CGPoint(x: 120, y: 90))
let afterActions = Double(rim.opacity)
view.setAura(true)
view.pulseAura()
let demoOn = Double(rim.opacity)

// Bounded, latest-wins scheduling: ten quick targets -> one applied, nine dropped.
for i in 0..<10 { view.scheduleCursor(at: CGPoint(x: i, y: i), glide: true) }
view.flushScheduledCursor()
let appliedCount = view.appliedCursorCount
let droppedCount = view.droppedCursorCount

// Runtime Reduce-Motion tears down a glide already in flight.
view.setReduceMotion(false)
view.showCursor(at: CGPoint(x: 10, y: 10), glide: true)   // first: direct
view.showCursor(at: CGPoint(x: 30, y: 30), glide: true)   // second: glide anim
let animBefore = view.animationKeyCountForTesting()
view.setReduceMotion(true)
let animAfter = view.animationKeyCountForTesting()

// Grapheme-safe truncation: a family emoji is one Character and must not split.
let family = "👨‍👩‍👧‍👦"
let long = String(repeating: family, count: 40)
let clamped = CursorLayerView.clampLabel(long)
let clampedCount = clamped.count
let intact = clamped == String(repeating: family, count: 28)

let out: [String: Any] = [
  "rimDisabledOpacity": disabled, "rimAfterPulse": afterPulse, "rimAfterActions": afterActions,
  "demoRimOpacity": demoOn, "appliedCursorCount": appliedCount, "droppedCursorCount": droppedCount,
  "animBefore": animBefore, "animAfter": animAfter,
  "clampedCount": clampedCount, "clampedIntact": intact,
]
let data = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
"""


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="scu-visual-event-") as directory:
        work = pathlib.Path(directory)
        main_swift = work / "main.swift"
        binary = work / "visual-event-view"
        main_swift.write_text("import AppKit\nimport QuartzCore\nimport Foundation\n" + VIEW + CHECK)
        subprocess.run(
            ["swiftc", "-swift-version", "5", "-module-cache-path", str(work / "cache"),
             "-framework", "AppKit", "-framework", "QuartzCore", str(main_swift), "-o", str(binary)],
            check=True,
        )
        result = subprocess.run([str(binary)], capture_output=True, text=True, check=True)
    payload = json.loads(result.stdout)
    ok = (
        payload["rimDisabledOpacity"] == 0.0
        and payload["rimAfterPulse"] == 0.0
        and payload["rimAfterActions"] == 0.0
        and payload["demoRimOpacity"] > 0.9
        and payload["appliedCursorCount"] == 1
        and payload["droppedCursorCount"] == 9
        and payload["animBefore"] > 0
        and payload["animAfter"] == 0
        and payload["clampedCount"] == 28
        and payload["clampedIntact"] is True
    )
    print(json.dumps({"ok": ok, **payload}, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
