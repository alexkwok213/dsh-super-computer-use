#!/usr/bin/env python3
"""Resource soak surrogate for Task 7/9 lifecycle metrics.

Runs the cursor overlay + a live preview card for a duration, samples their RSS,
then does repeated preview start/stop cycles and checks no helper is left behind.
The plan's 30-minute figure is a LONG run; this default is a bounded proxy and is
reported honestly (duration printed). It never screenshots per frame.

    python3 -B engine/tests/resource_soak.py --seconds 60
"""
from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
CU = ROOT / "bin" / "cu"


def rss_kb(pid: int) -> int | None:
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        return int(out) if out else None
    except Exception:
        return None


def count_previews() -> int:
    out = subprocess.run(["ps", "-Ao", "pid=,command="], capture_output=True, text=True).stdout
    return sum(1 for line in out.splitlines() if "preview --window" in line)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=int, default=60)
    parser.add_argument("--cycles", type=int, default=8)
    opts = parser.parse_args()

    demo = subprocess.Popen([str(CU), "demo", "--seconds", str(opts.seconds + 60)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    overlay = None
    preview = None
    try:
        time.sleep(1.8)
        listing = json.loads(subprocess.run([str(CU), "windows"], capture_output=True, text=True).stdout)
        w = next((x for x in listing.get("windows", []) if x.get("title") == "cu demo window" and x.get("windowId", 0) > 0), None)
        if not w:
            raise RuntimeError("no demo window")
        wid = w["windowId"]

        overlay = subprocess.Popen([str(CU), "cursor-overlay"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, text=True)
        overlay.stdout.readline()  # ready
        overlay.stdin.write(json.dumps({"cmd": "preview.start", "windowId": wid}) + "\n")
        overlay.stdin.flush()
        time.sleep(5)  # warm-up

        base_overlay = rss_kb(overlay.pid) or 0
        samples = []
        started = time.time()
        while time.time() - started < opts.seconds:
            samples.append({"t": int(time.time() - started), "overlayRssKb": rss_kb(overlay.pid)})
            time.sleep(max(1, opts.seconds // 8))
        end_overlay = rss_kb(overlay.pid) or 0
        growth_kb = end_overlay - base_overlay

        # Repeated start/stop of the preview card must not leak helpers.
        for _ in range(opts.cycles):
            overlay.stdin.write(json.dumps({"cmd": "preview.stop"}) + "\n")
            overlay.stdin.flush()
            time.sleep(0.2)
            overlay.stdin.write(json.dumps({"cmd": "preview.start", "windowId": wid}) + "\n")
            overlay.stdin.flush()
            time.sleep(0.4)
        overlay.stdin.write(json.dumps({"cmd": "preview.stop"}) + "\n")
        overlay.stdin.flush()
        time.sleep(1.5)
        leftover = count_previews()

        # Stop the overlay; it must exit (no orphan helper).
        overlay.stdin.close()
        overlay.wait(timeout=5)
        overlay_gone = overlay.poll() is not None

        ok = growth_kb < 20 * 1024 and leftover == 0 and overlay_gone
        print(json.dumps({
            "ok": ok,
            "durationSeconds": opts.seconds,
            "baselineRssKb": base_overlay,
            "endRssKb": end_overlay,
            "growthKb": growth_kb,
            "cycles": opts.cycles,
            "leftoverPreviews": leftover,
            "overlayExited": overlay_gone,
            "samples": samples,
            "note": "bounded proxy; the plan's 30-minute soak is not run here",
        }, ensure_ascii=False, indent=2))
        return 0 if ok else 1
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)})); return 1
    finally:
        for p in (preview, overlay):
            if p and p.poll() is None:
                try: p.kill()
                except Exception: pass
        subprocess.run(["pkill", "-f", "cu preview"], capture_output=True)
        demo.terminate()
        try: demo.wait(timeout=4)
        except subprocess.TimeoutExpired: demo.kill()


if __name__ == "__main__":
    sys.exit(main())
