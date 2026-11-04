#!/usr/bin/env python3
"""Offscreen: PreviewCardView fade-in animation (Task 7, 120 ms card fade)."""
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
let card = PreviewCardView(frame: NSRect(x: 0, y: 0, width: 320, height: 200))
card.layout()
let before = card.hasFadeInAnimationForTesting()
card.fadeIn()
let after = card.hasFadeInAnimationForTesting()
let out: [String: Any] = ["ok": (!before && after), "before": before, "after": after]
print(String(decoding: try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), as: UTF8.self))
'''
def main() -> int:
    with tempfile.TemporaryDirectory(prefix="scu-card-") as d:
        w=pathlib.Path(d); main_swift=w/"main.swift"; binp=w/"card"
        main_swift.write_text(VIEW+"\n"+CHECK)
        subprocess.run(["swiftc","-swift-version","5","-module-cache-path",str(w/"cache"),
                        "-framework","AppKit","-framework","AVFoundation","-framework","QuartzCore",
                        str(main_swift),"-o",str(binp)], check=True)
        r=subprocess.run([str(binp)],capture_output=True,text=True,check=True)
    p=json.loads(r.stdout); print(json.dumps(p,ensure_ascii=False)); return 0 if p.get("ok") else 1
if __name__=="__main__": sys.exit(main())
