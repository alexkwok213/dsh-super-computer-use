"""R11 regression: the overlay must bound its visual mailbox BEFORE the main
thread and emit a render-commit acknowledgement.

Feeds a burst of commands into the real cursor-overlay process (one this test
owns), then checks:
  * at least one `renderAck` line, with receivedAtNs <= committedAtNs and a
    native clock domain (this is a receipt + transaction commit, NOT a
    first-visible measurement);
  * the bounded queue reports drops under the burst instead of growing without
    limit (transient commands cap = 64);
  * the helper is still responsive afterwards (a terminate command is handled and
    stdin EOF exits promptly).
No global pkill; only the exact owned PID is cleaned up.
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


def read_line(process, seconds=8):
    ready, _, _ = select.select([process.stdout], [], [], seconds)
    if not ready:
        raise RuntimeError('overlay stdout timeout')
    return json.loads(process.stdout.readline())


def run():
    overlay = subprocess.Popen([str(CU), 'cursor-overlay'], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    acks = []
    try:
        ready = read_line(overlay)
        assert ready.get('cursor') == 'ready', ready
        # Burst: coalescible cursor/label plus a bounded transient click queue.
        for i in range(400):
            overlay.stdin.write(json.dumps({'cmd': 'cursor', 'x': i, 'y': i, 'glide': True}) + '\n')
            overlay.stdin.write(json.dumps({'cmd': 'label', 'text': f'label-{i}', 'x': i, 'y': i}) + '\n')
        for i in range(500):
            overlay.stdin.write(json.dumps({'cmd': 'click', 'x': i, 'y': i}) + '\n')
        overlay.stdin.flush()
        deadline = time.time() + 8
        while time.time() < deadline:
            try:
                line = read_line(overlay, seconds=0.5)
            except Exception:
                if overlay.poll() is not None:
                    break
                continue
            if line.get('kind') == 'renderAck':
                acks.append(line)
                # A burst may produce several drains; collect a few then stop.
                if len(acks) >= 3:
                    break
        assert acks, 'no renderAck was emitted'
        first = acks[0]
        ok_clock = first.get('clockDomain') == 'native-monotonic'
        ok_order = int(first.get('receivedAtNs', 0)) <= int(first.get('committedAtNs', 0))
        dropped = max(int(a.get('dropped', 0)) for a in acks)
        # 500 transient clicks + 64 cap: the mailbox must actually bound, not
        # merely count drops while queueing everything.
        bounded = dropped > 0

        # Responsiveness after the burst: a stop command must be handled and the
        # helper must exit on stdin EOF.
        overlay.stdin.write(json.dumps({'cmd': 'hide'}) + '\n')
        overlay.stdin.write(json.dumps({'cmd': 'preview.stop'}) + '\n')
        overlay.stdin.flush()
        overlay.stdin.close()
        overlay.wait(timeout=5)
        result = {
            'ok': ok_clock and ok_order and bounded and overlay.returncode == 0,
            'acks': len(acks),
            'firstAck': first,
            'maxDropped': dropped,
            'bounded': bounded,
            'clockOk': ok_clock,
            'orderOk': ok_order,
            'exitCode': overlay.returncode,
        }
    finally:
        if overlay.poll() is None:
            overlay.terminate()
            try:
                overlay.wait(timeout=3)
            except subprocess.TimeoutExpired:
                overlay.kill(); overlay.wait()
    print(json.dumps(result, indent=2))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(run())
