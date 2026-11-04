"""Offscreen checks for the preview geometry / degradation contract (Task 7).

Compiles the pure `PreviewGeometry` code (no SCStream, no window) and pins:
letterbox mapping, the offset+(point-origin)*scale rule, and the exact cases that
must NOT be shown as live (no first frame / minimised / hidden / exited) or must
be marked stale (generation/geometry mismatch).

    python3 -B engine/tests/preview_geometry.py
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "Sources" / "PreviewController.swift"

CHECK = r'''
import Foundation
import CoreGraphics

func approx(_ a: CGFloat, _ b: CGFloat) -> Bool { abs(a - b) < 0.001 }

var failures: [String] = []
func expect(_ cond: Bool, _ msg: String) { if !cond { failures.append(msg) } }

// letterbox 1600x900 into 800x800
let scale = PreviewGeometry.fitScale(source: CGSize(width: 1600, height: 900),
                                     container: CGSize(width: 800, height: 800))
expect(approx(scale, 0.5), "fitScale \(scale)")
let rect = PreviewGeometry.fitRect(source: CGSize(width: 1600, height: 900),
                                   container: CGSize(width: 800, height: 800))
expect(approx(rect.width, 800) && approx(rect.height, 450) && approx(rect.minY, 175) && approx(rect.minX, 0),
       "fitRect \(rect)")

// offset + (global - contentOrigin) * scale
let p = PreviewGeometry.mapPoint(global: CGPoint(x: 300, y: 250),
                                 contentOrigin: CGPoint(x: 100, y: 50),
                                 fitScale: 0.5, offset: CGPoint(x: 10, y: 10))
expect(approx(p.x, 110) && approx(p.y, 110), "mapPoint \(p)")

let target = PreviewTarget(targetGeneration: 2, geometryVersion: 5)
let good = PreviewFrameMeta(frameId: "f1", sessionId: "s", targetGeneration: 2, geometryVersion: 5,
                            capturedAtNs: 1, contentRect: rect, pixelSize: CGSize(width: 1600, height: 900),
                            scale: 2, status: "ok")

func status(_ frame: PreviewFrameMeta?, _ state: PreviewWindowState, _ first: Bool) -> String {
    PreviewGeometry.placement(frame: frame, target: target, windowState: state, hasVisibleFirstFrame: first).status.rawValue
}

expect(status(good, .visible, true) == "live", "good frame should be live")
expect(status(nil, .visible, false) == "unavailable", "no first frame -> unavailable")
expect(status(good, .minimized, true) == "unavailable", "minimized -> unavailable")
expect(status(good, .hidden, true) == "unavailable", "hidden -> unavailable")
expect(status(good, .exited, true) == "unavailable", "exited -> unavailable")
var stale = good; stale.targetGeneration = 1
expect(status(stale, .visible, true) == "stale", "old generation -> stale")
var staleGeom = good; staleGeom.geometryVersion = 4
expect(status(staleGeom, .visible, true) == "stale", "old geometry -> stale")

expect(PreviewGeometry.firstFrameInBudget(elapsedMs: 1500) == true, "1500 in budget")
expect(PreviewGeometry.firstFrameInBudget(elapsedMs: 1600) == false, "1600 over 1500 budget")

let out: [String: Any] = ["ok": failures.isEmpty, "failures": failures]
let data = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
'''


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="scu-preview-geom-") as directory:
        work = pathlib.Path(directory)
        check = work / "main.swift"
        binary = work / "preview-geom"
        check.write_text(CHECK)
        subprocess.run(
            ["swiftc", "-swift-version", "5", "-module-cache-path", str(work / "cache"),
             "-framework", "CoreGraphics", str(SOURCE), str(check), "-o", str(binary)],
            check=True,
        )
        result = subprocess.run([str(binary)], capture_output=True, text=True, check=True)
    payload = json.loads(result.stdout)
    print(json.dumps(payload, ensure_ascii=False))
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
