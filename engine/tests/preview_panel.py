#!/usr/bin/env python3
"""Visible preview card (Task 7 / M2). Shows an AVSampleBufferDisplayLayer card
for the demo window, proves it is actually on screen (appears in `cu windows`),
that frames stream, and that a non-capturable window degrades cleanly.

    python3 -B engine/tests/preview_panel.py
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


def last_json(text: str) -> dict:
    for line in reversed([l for l in text.splitlines() if l.strip()]):
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    raise Failure(f"no JSON in output: {text[-300:]!r}")


def main() -> int:
    demo = subprocess.Popen([str(CU), "demo", "--seconds", "60"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    preview = None
    try:
        time.sleep(1.8)
        listing = json.loads(subprocess.run([str(CU), "windows"], capture_output=True, text=True).stdout)
        window = next((w for w in listing.get("windows", []) if w.get("title") == "cu demo window"), None)
        if not window:
            raise Failure("demo window did not appear")

        preview = subprocess.Popen([str(CU), "preview", "--window", str(window["windowId"]), "--seconds", "6"],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        time.sleep(1.8)
        # The card must be a real on-screen window, not just a headless stream.
        listing2 = json.loads(subprocess.run([str(CU), "windows"], capture_output=True, text=True).stdout)
        card = next((w for w in listing2.get("windows", [])
                     if "cu preview" in (w.get("title") or "")), None)
        if not card:
            raise Failure("preview card is not on screen (no 'cu preview' window)")

        out, err = preview.communicate(timeout=15)
        final = last_json(out)
        if final.get("ok") is not True or final.get("preview") != "shown":
            raise Failure(f"preview did not show: {final} / {err[-200:]}")
        if final.get("frames", 0) <= 0:
            raise Failure(f"no frames presented: {final}")
        first = final.get("firstFrameMs")
        if not isinstance(first, int) or first > 1500:
            raise Failure(f"first frame not within budget: {final}")

        # Degrade: a window id that cannot be captured exits at once, no empty card.
        started = time.perf_counter()
        degraded = subprocess.run([str(CU), "preview", "--window", "2147483000", "--seconds", "2"],
                                  capture_output=True, text=True, timeout=12)
        elapsed = time.perf_counter() - started
        dj = last_json(degraded.stdout)
        if dj.get("ok") is not False or dj.get("error") != "window_not_capturable":
            raise Failure(f"degrade wrong: {dj}")
        if elapsed > 8:
            raise Failure(f"degrade took {elapsed:.1f}s")

        print(json.dumps({
            "ok": True,
            "cardOnScreen": card.get("title"),
            "firstFrameMs": first,
            "frames": final.get("frames"),
            "degradeError": dj.get("error"),
        }, ensure_ascii=False, indent=2))
        return 0
    except Failure as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1
    finally:
        if preview and preview.poll() is None:
            preview.kill()
        demo.terminate()
        try:
            demo.wait(timeout=4)
        except subprocess.TimeoutExpired:
            demo.kill()


if __name__ == "__main__":
    sys.exit(main())
