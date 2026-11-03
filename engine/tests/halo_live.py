#!/usr/bin/env python3
"""Opt-in live smoke test: shows only a temporary nonactivating fixture window.

Runs the candidate halo against it, moves/resizes the fixture, then makes it
transparent. Verifies both panels follow and exit; never clicks user windows.
"""
from pathlib import Path
import json
import subprocess
import tempfile
root = Path(__file__).resolve().parents[1]
fixture = r'''
import AppKit
let initialFrontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let panel = NSPanel(contentRect: NSRect(x: 300, y: 260, width: 640, height: 380),
    styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
panel.backgroundColor = NSColor(srgbRed: 0.1, green: 0.12, blue: 0.16, alpha: 1)
panel.title = "CU visual regression fixture"
panel.collectionBehavior = [.canJoinAllSpaces, .canJoinAllApplications, .stationary]
panel.orderFrontRegardless()
// orderFrontRegardless queues WindowServer work; publish readiness only after
// the same listing used by the engine can actually see this window.
let ready = Timer(timeInterval: 0.05, repeats: true) { timer in
    let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    if rows.contains(where: { ($0[kCGWindowNumber as String] as? Int) == panel.windowNumber }) {
        print(panel.windowNumber)
        fflush(stdout)
        timer.invalidate()
    }
}
RunLoop.main.add(ready, forMode: .common)
DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
    panel.setFrame(NSRect(x: 330, y: 280, width: 700, height: 400), display: true)
}
DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
    let rows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as! [[String: Any]]
    let candidates = rows.filter { ($0[kCGWindowOwnerPID as String] as? Int) == Int(CommandLine.arguments[1]) }
    let target = rows.first { ($0[kCGWindowNumber as String] as? Int) == panel.windowNumber }!
    print(String(data: try! JSONSerialization.data(withJSONObject: ["panels": candidates,
        "target": target, "appKitFrame": NSStringFromRect(panel.frame),
        "initialFrontmost": initialFrontmost,
        "currentFrontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0]), encoding: .utf8)!)
    fflush(stdout)
}
DispatchQueue.main.asyncAfter(deadline: .now() + 4) { panel.alphaValue = 0 }
DispatchQueue.main.asyncAfter(deadline: .now() + 6) { exit(0) }
app.run()
'''
# The fixture receives the candidate PID through a temp file to avoid racing its
# startup. Its only command-line argument is read when the delayed check runs.
fixture = fixture.replace('Int(CommandLine.arguments[1])',
    'Int((try! String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)).trimmingCharacters(in: .whitespacesAndNewlines))')
with tempfile.TemporaryDirectory(prefix='cu-halo-live-') as tmp:
    tmp = Path(tmp)
    (tmp / 'main.swift').write_text(fixture)
    subprocess.run(['swiftc', '-swift-version', '5', '-target', 'arm64-apple-macos14.0',
                    '-framework', 'AppKit', str(tmp / 'main.swift'), '-o', str(tmp / 'fixture')], check=True)
    owner = subprocess.Popen([str(tmp / 'fixture'), str(tmp / 'pid')], stdout=subprocess.PIPE, text=True)
    halo = None
    try:
        window = int(owner.stdout.readline())
        halo = subprocess.Popen([str(root / 'build/cu-visual-candidate'), 'halo', '--window', str(window),
                                 '--seconds', '8', '--label', 'DSH · Visual regression'], stdout=subprocess.PIPE, text=True)
        (tmp / 'pid').write_text(str(halo.pid))
        output, _ = halo.communicate(timeout=12)
        print('candidate events:', output.strip())
        rest, _ = owner.communicate(timeout=10)
        events = [json.loads(line) for line in output.splitlines()]
        if halo.returncode != 0:
            print('fixture evidence:', rest.strip())
        assert halo.returncode == 0, output
        assert events[0].get('halo') == 'shown', events
        assert events[-1].get('halo') == 'window_gone', events
        evidence = json.loads(rest.strip())
        rows = evidence['panels']
        sizes = sorted((round(r['kCGWindowBounds']['Width']), round(r['kCGWindowBounds']['Height'])) for r in rows)
        target = evidence['target']['kCGWindowBounds']
        expected = (round(target['Width'] + 24), round(target['Height'] + 24))
        assert expected in sizes, evidence
        assert (300, 28) in sizes, evidence
        assert len(rows) == 2, sizes
        assert evidence['initialFrontmost'] == evidence['currentFrontmost'], evidence
        print('PASS: focus preserved; panels follow resize; transparent target dismisses halo before timeout')
    finally:
        for process in [halo, owner]:
            if process is not None and process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
