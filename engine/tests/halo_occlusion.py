#!/usr/bin/env python3
"""Live WindowServer regression: an unrelated foreground window covers a target halo."""
import json
import os
import select
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SWIFT = r'''
import AppKit
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let target = NSPanel(contentRect: NSRect(x: 200, y: 200, width: 500, height: 350), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
target.backgroundColor = .blue
target.orderFrontRegardless()
print(target.windowNumber); fflush(stdout)
let blocker = NSPanel(contentRect: NSRect(x: 300, y: 250, width: 350, height: 280), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
blocker.backgroundColor = .red
DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
    blocker.orderFrontRegardless()
}
DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
    let rows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? []
    let result = rows.compactMap { row -> [String: Int]? in
        guard let number = row[kCGWindowNumber as String] as? Int,
              let pid = row[kCGWindowOwnerPID as String] as? Int,
              let layer = row[kCGWindowLayer as String] as? Int else { return nil }
        return ["number": number, "pid": pid, "layer": layer]
    }
    let obj: [String: Any] = ["target": target.windowNumber, "blocker": blocker.windowNumber, "windows": result]
    print(String(data: try! JSONSerialization.data(withJSONObject: obj), encoding: .utf8)!); fflush(stdout)
}
DispatchQueue.main.asyncAfter(deadline: .now() + 4.5) { target.orderFrontRegardless() }
DispatchQueue.main.asyncAfter(deadline: .now() + 5.5) {
    let rows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? []
    let numbers = rows.compactMap { $0[kCGWindowNumber as String] as? Int }
    print(String(data: try! JSONSerialization.data(withJSONObject: numbers), encoding: .utf8)!); fflush(stdout)
}
DispatchQueue.main.asyncAfter(deadline: .now() + 6) { target.orderOut(nil) }
DispatchQueue.main.asyncAfter(deadline: .now() + 6.7) {
    let rows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? []
    print(String(data: try! JSONSerialization.data(withJSONObject: rows.compactMap { $0[kCGWindowNumber as String] as? Int }), encoding: .utf8)!); fflush(stdout)
}
DispatchQueue.main.asyncAfter(deadline: .now() + 7) { target.orderFrontRegardless() }
DispatchQueue.main.asyncAfter(deadline: .now() + 7.8) {
    let rows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? []
    print(String(data: try! JSONSerialization.data(withJSONObject: rows.compactMap { $0[kCGWindowNumber as String] as? Int }), encoding: .utf8)!); fflush(stdout)
    exit(0)
}
app.run()
'''
def read_line(process, timeout=10):
    if not select.select([process.stdout], [], [], timeout)[0]:
        raise TimeoutError(f"process {process.pid} did not report within {timeout}s")
    line = process.stdout.readline()
    if not line:
        raise RuntimeError(f"process {process.pid} exited without reporting")
    return line


with tempfile.TemporaryDirectory(prefix='cu-occlusion-') as tmp:
    src = Path(tmp) / 'main.swift'
    exe = Path(tmp) / 'fixture'
    src.write_text(SWIFT)
    subprocess.run(['swiftc', '-swift-version', '5', '-framework', 'AppKit', str(src), '-o', str(exe)], check=True)
    fixture = subprocess.Popen([str(exe)], stdout=subprocess.PIPE, text=True)
    halo = None
    try:
        target = int(read_line(fixture))
        halo = subprocess.Popen([os.environ.get('CU_HALO_TEST_BIN', str(ROOT / 'bin/cu')), 'halo', '--window', str(target), '--seconds', '11'], stdout=subprocess.PIPE, text=True)
        event = json.loads(read_line(halo))
        assert event.get('halo') == 'shown', event
        evidence = json.loads(read_line(fixture))
        rows = evidence['windows']
        blocker_index = next(i for i, row in enumerate(rows) if row['number'] == evidence['blocker'])
        overlays = [(i, row) for i, row in enumerate(rows) if row['pid'] == halo.pid]
        assert len(overlays) == 2 and all(i > blocker_index for i, _ in overlays), (blocker_index, overlays)
        raised = json.loads(read_line(fixture))
        target_index = raised.index(target)
        assert all(raised.index(row['number']) < target_index for _, row in overlays), raised
        hidden = json.loads(read_line(fixture))
        restored = json.loads(read_line(fixture))
        assert all(row['number'] not in hidden for _, row in overlays), hidden
        assert all(row['number'] in restored for _, row in overlays), restored
        print('PASS: hide/restore works; foreground blocker is above all target halo panels')
    finally:
        for process in (halo, fixture):
            if process and process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
