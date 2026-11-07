#!/usr/bin/env python3
"""Live, isolated foreground drag guard regression; creates only a blank test window."""
import json
import os
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SWIFT = r'''
import AppKit
class DragView: NSView {
    override func mouseDown(with event: NSEvent) { print("DOWN"); fflush(stdout) }
    override func mouseDragged(with event: NSEvent) { print("DRAG"); fflush(stdout) }
    override func mouseUp(with event: NSEvent) { print("UP"); fflush(stdout) }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 300, y: 300, width: 480, height: 320), styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "CU drag guard fixture"
window.contentView = DragView(frame: NSRect(x: 0, y: 0, width: 480, height: 320))
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
print("\(ProcessInfo.processInfo.processIdentifier) \(window.windowNumber)")
fflush(stdout)
app.run()
'''
with tempfile.TemporaryDirectory(prefix="cu-drag-guard-") as tmp:
    tmp = Path(tmp)
    src, fixture = tmp / "main.swift", tmp / "fixture"
    src.write_text(SWIFT)
    subprocess.run(["swiftc", str(src), "-o", str(fixture)], check=True, timeout=60)
    app = subprocess.Popen([str(fixture)], stdout=subprocess.PIPE, text=True)
    try:
        if not select.select([app.stdout], [], [], 15)[0]:
            raise RuntimeError("fixture did not open")
        pid, window = map(int, app.stdout.readline().split())
        env = {**os.environ, "CU_STATE_DIR": str(tmp / "state"), "CU_NO_USER_PAUSE": "1"}
        cu = os.environ.get("CU_DRAG_TEST_BIN", str(ROOT / "bin/cu"))
        def run(*args):
            result = subprocess.run([cu, *args], capture_output=True, text=True, env=env, timeout=20)
            lines = result.stdout.strip().splitlines()
            return json.loads(lines[-1]) if lines else {"stderr": result.stderr, "returncode": result.returncode}
        target = None
        for _ in range(30):
            windows = run("windows").get("windows", [])
            target = next((w for w in windows if w["windowId"] == window), None)
            if target:
                break
            time.sleep(0.1)
        if target is None:
            raise RuntimeError(f"fixture window {window} absent: {windows}")
        b = target["bounds"]
        point = f'{b["x"] + b["width"] / 2},{b["y"] + b["height"] / 2}'
        # The initial press is always on the blank fixture; no file or UI item can be dragged.
        wrong_owner = run("drag", "--window", str(window), "--pid", str(os.getpid()), "--from", point, "--to", point)
        outside = run("drag", "--window", str(window), "--pid", str(pid), "--from", point, "--to", "-10000,-10000")
        outside_start = run("drag", "--window", str(window), "--pid", str(pid), "--from", "-10000,-10000", "--to", point)
        failures = []
        if wrong_owner.get("error") != "target_mismatch":
            failures.append(("mismatched owner accepted", wrong_owner))
        if outside.get("error") != "point_outside_target_window":
            failures.append(("outside destination accepted", outside))
        if outside_start.get("error") != "point_outside_target_window":
            failures.append(("outside start accepted", outside_start))
        assert not failures, failures
        assert not select.select([app.stdout], [], [], 0.3)[0], "rejected drag reached the fixture"
        end = f'{b["x"] + b["width"] / 2 + 50},{b["y"] + b["height"] / 2}'
        valid = run("drag", "--window", str(window), "--pid", str(pid), "--from", point, "--to", end)
        assert valid.get("ok") is True, ("valid drag refused", valid)
        events = ""
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if select.select([app.stdout], [], [], 0.1)[0]:
                events += os.read(app.stdout.fileno(), 4096).decode()
                if "UP\n" in events:
                    break
        assert "DOWN\n" in events and "DRAG\n" in events and "UP\n" in events, events
        print("PASS: invalid drags refused without events; valid drag reached the fixture")
    finally:
        app.terminate()
        app.wait(timeout=5)
