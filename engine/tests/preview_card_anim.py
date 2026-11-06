#!/usr/bin/env python3
"""Offscreen native animation behavior: interruption, stale feedback and reduced motion."""
from __future__ import annotations
import json, pathlib, subprocess, sys, tempfile
ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = (ROOT/"Sources"/"PreviewCapture.swift").read_text()
START = "final class PreviewCardView: NSView {"
END = "/// Show a floating preview card"
VIEW = SRC[SRC.index(START):SRC.index(END)]
CHECK = r'''
import AppKit
import AVFoundation
import QuartzCore
import Foundation
func emit(_ value: [String: Any]) {}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let card = PreviewCardView(frame: NSRect(x: 0, y: 0, width: 200, height: 130))
card.layout()
let pointer = card.layer!.sublayers!.first { $0.name == "agent-pointer" }!
card.feedback(at: CGPoint(x: 20, y: 30), click: false)
card.feedback(at: CGPoint(x: 150, y: 90), click: true)
assert(pointer.animation(forKey: "move") != nil, "successive points should glide")
for i in 0..<100 { card.feedback(at: CGPoint(x: i, y: 50), click: false) }
assert(pointer.position == CGPoint(x: 99, y: 50), "latest point wins")
assert((pointer.animationKeys() ?? []).count <= 2, "animation queue is bounded")
card.showStatus("Waiting for a fresh frame")
assert(pointer.opacity == 0 && (pointer.animationKeys() ?? []).isEmpty, "stale image must clear feedback")
card.setReducedMotion(true)
card.fadeIn()
card.feedback(at: CGPoint(x: 120, y: 80), click: true)
assert(!card.hasFadeInAnimationForTesting(), "reduced motion skips entrance")
assert((pointer.animationKeys() ?? []).isEmpty, "reduced motion skips glide")
card.setReducedMotion(false)
card.fadeIn()
assert(card.hasFadeInAnimationForTesting(), "normal entrance animates")
print("{\"ok\":true,\"latestWins\":true,\"staleClearsFeedback\":true,\"reducedMotion\":true}")
'''
def main() -> int:
    with tempfile.TemporaryDirectory(prefix="scu-card-") as d:
        w=pathlib.Path(d); main_swift=w/"main.swift"; binp=w/"card"
        main_swift.write_text((ROOT/"Sources"/"PreviewController.swift").read_text()+"\n"+VIEW+"\n"+CHECK)
        subprocess.run(["swiftc","-swift-version","5","-module-cache-path",str(w/"cache"),
                        "-framework","AppKit","-framework","AVFoundation","-framework","QuartzCore",
                        str(main_swift),"-o",str(binp)], check=True)
        r=subprocess.run([str(binp)],capture_output=True,text=True,check=True)
    p=json.loads(r.stdout); print(json.dumps(p,ensure_ascii=False)); return 0 if p.get("ok") else 1
if __name__=="__main__": sys.exit(main())
