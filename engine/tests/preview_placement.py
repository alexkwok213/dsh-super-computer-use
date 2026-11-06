#!/usr/bin/env python3
"""Preview dragging must leave the whole card reachable on its display."""
from pathlib import Path
import subprocess
import tempfile
root = Path(__file__).resolve().parents[1]
source = '''import Foundation
let visible = CGRect(x: -1280, y: 24, width: 1280, height: 776)
let dragged = CGRect(x: -1400, y: 740, width: 320, height: 200)
let result = PreviewGeometry.constrainCard(dragged, to: visible)
precondition(result == CGRect(x: -1280, y: 600, width: 320, height: 200))
let inside = CGRect(x: -900, y: 200, width: 320, height: 200)
precondition(PreviewGeometry.constrainCard(inside, to: visible) == inside)
let frame = CGRect(x: -100, y: 50, width: 800, height: 400)
let point = PreviewGeometry.feedbackPoint(global: CGPoint(x: 300, y: 150), observed: frame,
    captured: frame, current: frame, container: CGSize(width: 320, height: 200))
precondition(point == CGPoint(x: 160, y: 140))
precondition(PreviewGeometry.feedbackPoint(global: CGPoint(x: 300, y: 150), observed: frame,
    captured: frame, current: frame.offsetBy(dx: 1, dy: 0), container: CGSize(width: 320, height: 200)) == nil)
let cropped = PreviewGeometry.feedbackPoint(global: CGPoint(x: 300, y: 150), observed: frame,
    captured: frame, current: frame, container: CGSize(width: 320, height: 200),
    sourcePixels: CGSize(width: 1000, height: 600), sourceContent: CGRect(x: 100, y: 50, width: 800, height: 400))
precondition(cropped == CGPoint(x: 160, y: 148))
print("PASS: dragged previews remain reachable, including negative-origin displays")
'''
with tempfile.TemporaryDirectory(prefix='cu-placement-') as temp:
    main = Path(temp) / 'main.swift'
    binary = Path(temp) / 'test'
    main.write_text(source)
    subprocess.run(['swiftc', str(root / 'Sources/PreviewController.swift'), str(main), '-o', str(binary)], check=True, timeout=60)
    subprocess.run([str(binary)], check=True, timeout=10)
