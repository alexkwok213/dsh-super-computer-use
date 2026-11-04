"""R7 regression: a target switch must retire the old preview card and show the
new window, using the real cursor-helper stdin protocol (`preview.start`).

Only processes this test creates are touched; exact-PID cleanup, no pkill.
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
    out = []
    for line in text.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3:
            out.append((int(parts[0]), int(parts[1]), parts[2]))
    return out


def read_line(proc, seconds=8):
    ready, _, _ = select.select([proc.stdout], [], [], seconds)
    if not ready:
        raise RuntimeError('helper ready timeout')
    return json.loads(proc.stdout.readline())


def windows_for(pid):
    listing = json.loads(subprocess.check_output([str(CU), 'windows'], text=True, timeout=5))
    return [w for w in listing.get('windows', [])
            if w.get('pid') == pid and w.get('windowId', 0) > 0 and w.get('title') == 'cu demo window']


def preview_args(ppid):
    return [(pid, cmd) for pid, parent, cmd in processes()
            if parent == ppid and ' preview --window ' in cmd]


def run():
    demo_a = subprocess.Popen([str(CU), 'demo', '--seconds', '60'],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    demo_b = subprocess.Popen([str(CU), 'demo', '--seconds', '60'],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    overlay = None
    owned = []
    try:
        wa = wb = None
        for _ in range(50):
            time.sleep(.15)
            if not wa:
                try: wa = (windows_for(demo_a.pid) or [None])[0]
                except Exception: wa = None
            if not wb:
                try: wb = (windows_for(demo_b.pid) or [None])[0]
                except Exception: wb = None
            if wa and wb:
                break
        if not wa or not wb:
            raise RuntimeError('two owned demo windows did not appear')
        wid_a, wid_b = wa['windowId'], wb['windowId']
        assert wid_a != wid_b

        overlay = subprocess.Popen([str(CU), 'cursor-overlay'], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        assert read_line(overlay).get('cursor') == 'ready'

        overlay.stdin.write(json.dumps({'cmd': 'preview.start', 'windowId': wid_a}) + '\n')
        overlay.stdin.flush()
        for _ in range(40):
            time.sleep(.1)
            first = preview_args(overlay.pid)
            if first: break
        assert first and f'--window {wid_a}' in first[0][1], first
        owned.append(first[0][0])

        overlay.stdin.write(json.dumps({'cmd': 'preview.start', 'windowId': wid_b}) + '\n')
        overlay.stdin.flush()
        second = []
        for _ in range(60):
            time.sleep(.1)
            second = preview_args(overlay.pid)
            if second and all(f'--window {wid_b}' in cmd for _, cmd in second) and len(second) == 1:
                break
        owned.extend(pid for pid, _ in second)
        old_alive = any(pid == first[0][0] for pid, _, _ in processes())
        result = {
            'ok': bool(second) and len(second) == 1 and f'--window {wid_b}' in second[0][1] and not old_alive,
            'oldPreviewPid': first[0][0],
            'oldStillAlive': old_alive,
            'currentPreview': second,
            'newWindowId': wid_b,
        }
    finally:
        if overlay and overlay.poll() is None:
            try:
                overlay.stdin.write(json.dumps({'cmd': 'preview.stop'}) + '\n')
                overlay.stdin.close()
            except Exception:
                pass
            try:
                overlay.wait(timeout=4)
            except subprocess.TimeoutExpired:
                overlay.terminate(); overlay.wait()
        for pid, _, cmd in processes():
            if pid in owned and str(CU) in cmd and ' preview --window ' in cmd:
                try: os.kill(pid, signal.SIGTERM)
                except ProcessLookupError: pass
        for demo in (demo_a, demo_b):
            demo.terminate()
            try:
                demo.wait(timeout=3)
            except subprocess.TimeoutExpired:
                demo.kill(); demo.wait()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(run())
