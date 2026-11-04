#!/usr/bin/env python3
"""Native preview capture (Task 7): real SCStream first-frame budget + degrade.

Positive: capture the demo window for a few seconds — first frame arrives well
inside the 1500 ms budget and frames keep coming.
Negative: a window id that cannot be captured degrades immediately
(`window_not_capturable`) instead of spinning a stream that shows nothing.

    python3 -B engine/tests/preview_stream.py
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
CU = ROOT / "bin" / "cu"


class Failure(Exception):
    pass


def run_probe(window: int, seconds: int) -> tuple[dict, float]:
    started = time.perf_counter()
    proc = subprocess.run([str(CU), "preview-probe", "--window", str(window), "--seconds", str(seconds)],
                          capture_output=True, text=True, timeout=seconds + 20)
    elapsed = time.perf_counter() - started
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise Failure(f"preview-probe did not print JSON: {proc.stdout!r} / {proc.stderr[-200:]!r}")
    return payload, elapsed


def main() -> int:
    demo = subprocess.Popen([str(CU), "demo", "--seconds", "60"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1.8)
        listing = json.loads(subprocess.run([str(CU), "windows"], capture_output=True, text=True).stdout)
        window = next((w for w in listing.get("windows", []) if w.get("title") == "cu demo window"), None)
        if not window:
            raise Failure("demo window did not appear")

        positive, pos_elapsed = run_probe(window["windowId"], 3)
        if positive.get("ok") is not True:
            raise Failure(f"preview capture failed: {positive}")
        if positive.get("frames", 0) <= 0:
            raise Failure(f"no frames captured: {positive}")
        first = positive.get("firstFrameMs")
        if not isinstance(first, int) or first > 1500:
            raise Failure(f"first frame not within 1500 ms budget: {positive}")

        negative, neg_elapsed = run_probe(2147483000, 2)
        if negative.get("ok") is not False or negative.get("error") != "window_not_capturable":
            raise Failure(f"un-capturable window did not degrade cleanly: {negative}")
        if neg_elapsed > 8:
            raise Failure(f"degrade took too long ({neg_elapsed:.1f}s); it should not spin")

        print(json.dumps({
            "ok": True,
            "firstFrameMs": first,
            "frames": positive.get("frames"),
            "maxGapMs": positive.get("maxGapMs"),
            "degradeError": negative.get("error"),
            "degradeSeconds": round(neg_elapsed, 2),
        }, ensure_ascii=False, indent=2))
        return 0
    except Failure as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1
    finally:
        demo.terminate()
        try:
            demo.wait(timeout=4)
        except subprocess.TimeoutExpired:
            demo.kill()


if __name__ == "__main__":
    sys.exit(main())
