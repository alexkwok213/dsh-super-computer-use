"""R7 regression: no valid first frame within 1500 ms must cancel the live stream
and degrade to ONE static frame with an explicit status marker.

Uses the deterministic CU_PREVIEW_FORCE_NO_FIRST_FRAME hook so the fallback path
is exercised on any machine; the hook only skips stream.startCapture(), it never
fabricates the fallback result. Only the owned demo window is created/cleaned.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
CU = ROOT / 'engine/bin/cu'


def run():
    demo = subprocess.Popen([str(CU), 'demo', '--seconds', '40'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        window = None
        for _ in range(40):
            time.sleep(.15)
            try:
                listing = json.loads(subprocess.check_output([str(CU), 'windows'], text=True, timeout=5))
                window = next((w for w in listing.get('windows', [])
                               if w.get('pid') == demo.pid and w.get('windowId', 0) > 0
                               and w.get('title') == 'cu demo window'), None)
            except Exception:
                window = None
            if window:
                break
        if not window:
            raise RuntimeError('own demo window did not appear')
        env = dict(os.environ, CU_PREVIEW_FORCE_NO_FIRST_FRAME='1')
        proc = subprocess.run([str(CU), 'preview', '--window', str(window['windowId']), '--seconds', '6'],
                              capture_output=True, text=True, timeout=25, env=env)
        lines = [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]
        degraded = next((l for l in lines if l.get('mode') == 'static-fallback'), None)
        result = {
            'ok': bool(degraded) and degraded.get('reason') == 'first_frame_timeout'
                  and degraded.get('budgetMs') == 1500 and degraded.get('pixelWidth', 0) > 0,
            'degraded': degraded,
            'allLines': lines,
        }
    finally:
        demo.terminate()
        try:
            demo.wait(timeout=3)
        except subprocess.TimeoutExpired:
            demo.kill(); demo.wait()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(run())
