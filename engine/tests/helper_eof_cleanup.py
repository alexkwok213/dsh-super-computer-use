"""R8 regression: a cursor helper that goes away must not orphan its preview child.

Derived from docs/reviews/third-review-native-preview-probe.py, but asserts the
CORRECT behaviour (no orphan) instead of reproducing the defect. Only processes
this test created are touched; no global pkill.
"""
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
CU = ROOT / 'engine/bin/cu'


def processes():
    text = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,args='], text=True)
    rows = []
    for line in text.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3:
            rows.append((int(parts[0]), int(parts[1]), parts[2]))
    return rows


def read_line(process, seconds=8):
    ready, _, _ = select.select([process.stdout], [], [], seconds)
    if not ready:
        raise RuntimeError('helper ready timeout')
    return json.loads(process.stdout.readline())


def demo_window(window_title='cu demo window'):
    listing = json.loads(subprocess.check_output([str(CU), 'windows'], text=True, timeout=5))
    return next((w for w in listing.get('windows', [])
                 if w.get('windowId', 0) > 0 and w.get('title') == window_title), None)


def preview_children(ppid, wid):
    return [pid for pid, parent, cmd in processes()
            if parent == ppid and ' preview --window ' in cmd and f'--window {wid}' in cmd]


def run():
    demo = subprocess.Popen([str(CU), 'demo', '--seconds', '60'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    overlay = None
    owned_preview = []
    try:
        window = None
        for _ in range(40):
            time.sleep(.15)
            try:
                window = demo_window()
            except Exception:
                window = None
            if window:
                break
        if not window:
            raise RuntimeError('own demo window did not appear')
        wid = window['windowId']

        overlay = subprocess.Popen([str(CU), 'cursor-overlay'], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        ready = read_line(overlay)
        assert ready.get('cursor') == 'ready', ready
        overlay.stdin.write(json.dumps({'cmd': 'preview.start', 'windowId': wid}) + '\n')
        overlay.stdin.flush()
        for _ in range(40):
            time.sleep(.1)
            owned_preview = preview_children(overlay.pid, wid)
            if owned_preview:
                break
        assert owned_preview, 'preview child did not start'

        # EOF without any preview.stop: the helper AND every preview child it
        # created must be gone.
        overlay.stdin.close()
        overlay.wait(timeout=8)
        time.sleep(1.0)
        survivors = [pid for pid, _, cmd in processes()
                     if pid in owned_preview and ' preview --window ' in cmd]
        result = {
            'ok': overlay.returncode == 0 and not survivors,
            'parentExited': overlay.returncode == 0,
            'previewChildrenBeforeEOF': owned_preview,
            'previewChildrenSurvivingEOF': survivors,
        }
    finally:
        if overlay and overlay.poll() is None:
            overlay.terminate()
            try:
                overlay.wait(timeout=3)
            except subprocess.TimeoutExpired:
                overlay.kill(); overlay.wait()
        for pid, _, cmd in processes():
            if pid in owned_preview and str(CU) in cmd and ' preview --window ' in cmd:
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        demo.terminate()
        try:
            demo.wait(timeout=3)
        except subprocess.TimeoutExpired:
            demo.kill(); demo.wait()
    print(json.dumps(result, indent=2))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(run())
