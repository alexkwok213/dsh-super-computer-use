"""Observe normal overlay EOF cleanup. Own demo + own helper only.

Never pauses the daily service; never uses broad pkill. Reports whether its
preview child survives the parent's EOF, then cleans up exact owned PIDs.
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

demo = subprocess.Popen([str(CU), 'demo', '--seconds', '45'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
overlay = None
owned_preview_pids = []
try:
    window = None
    for _ in range(30):
        time.sleep(.15)
        listing = json.loads(subprocess.check_output([str(CU), 'windows'], text=True, timeout=5))
        window = next((w for w in listing.get('windows', [])
                       if w.get('pid') == demo.pid and w.get('windowId', 0) > 0
                       and w.get('title') == 'cu demo window'), None)
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
    for _ in range(30):
        time.sleep(.1)
        owned_preview_pids = [pid for pid, ppid, cmd in processes()
                              if ppid == overlay.pid and f'preview --window {wid}' in cmd]
        if owned_preview_pids:
            break
    assert owned_preview_pids, 'preview child did not start'
    time.sleep(1)
    overlay.stdin.close()
    overlay.wait(timeout=5)
    time.sleep(1)
    survivors = [pid for pid, _, cmd in processes()
                 if pid in owned_preview_pids and f'preview --window {wid}' in cmd]
    print(json.dumps({'parentExited': overlay.returncode == 0,
                      'previewChildrenBeforeEOF': owned_preview_pids,
                      'previewChildrenSurvivingEOF': survivors,
                      'orphanReproduced': bool(survivors)}, indent=2))
finally:
    if overlay and overlay.poll() is None:
        overlay.terminate()
        try:
            overlay.wait(timeout=3)
        except subprocess.TimeoutExpired:
            overlay.kill()
            overlay.wait()
    for pid, _, cmd in processes():
        if pid in owned_preview_pids and str(CU) in cmd and ' preview --window ' in cmd:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    demo.terminate()
    try:
        demo.wait(timeout=3)
    except subprocess.TimeoutExpired:
        demo.kill()
        demo.wait()
