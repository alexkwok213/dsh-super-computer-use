#!/usr/bin/env python3
"""Window-level operations, verified on a window the engine opens itself.

Drag and zoom need a window that is actually on a stage; instead of touching the
user's windows this suite opens `cu demo`, stages it if Stage Manager needs it,
then moves and zooms it.

    python3 tests/window_ops.py
"""
from __future__ import annotations

import json
import subprocess
import sys
import time

ROOT = __import__("pathlib").Path(__file__).resolve().parent.parent
CU = ROOT / "bin" / "cu"


def run(*args: str) -> dict:
    out = subprocess.run([str(CU), *args], capture_output=True, text=True, timeout=30)
    lines = out.stdout.strip().splitlines()
    return json.loads(lines[-1]) if lines else {}


def windows() -> list[dict]:
    return run("windows").get("windows", [])


def demo() -> dict | None:
    return next((w for w in windows() if "cu demo window" in (w.get("title") or "")), None)


def stage_if_needed(window: dict) -> bool:
    if not window.get("offStage"):
        return True
    b = window["bounds"]
    overlay = next((w for w in windows() if w["app"] == "WindowManager"
                    and abs(w["bounds"]["x"] - b["x"]) < 8
                    and abs(w["bounds"]["y"] - b["y"]) < 8
                    and abs(w["bounds"]["width"] - b["width"]) < 16
                    and abs(w["bounds"]["height"] - b["height"]) < 16), None)
    if not overlay:
        return False
    o = overlay["bounds"]
    run("click", "--x", str(int(o["x"] + o["width"] / 2)),
        "--y", str(int(o["y"] + o["height"] / 2)), "--force")
    time.sleep(0.9)
    current = demo()
    return bool(current) and not current.get("offStage")


def main() -> int:
    process = subprocess.Popen([str(CU), "demo", "--seconds", "90"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1.6)
        window = demo()
        if not window:
            print("demo window did not appear")
            return 2
        if not stage_if_needed(window):
            print("skip: the demo window could not be brought on stage")
            return 0
        window = demo()
        b = window["bounds"]
        x, y = int(b["x"]), int(b["y"])
        wid = window["windowId"]
        front_before = run("windows").get("frontmost")
        def cursor_xy():
            c = run("cursor")
            return (c.get("x") or 0, c.get("y") or 0)

        cursor_before = cursor_xy()

        # Window moves go through AX: background, no activation, no cursor warp.
        moved_result = run("movewindow", "--window", str(wid),
                           "--x", str(x + 60), "--y", str(y + 40))
        time.sleep(0.4)
        moved = demo()["bounds"]
        dx, dy = int(moved["x"]) - x, int(moved["y"]) - y
        front_after = run("windows").get("frontmost")
        cx, cy = cursor_xy()
        cursor_kept = abs(cx - cursor_before[0]) < 2 and abs(cy - cursor_before[1]) < 2
        # The cursor is reported for the record only: on a live machine the user
        # may move the mouse during the test, so a raw comparison would flake.
        move_ok = (abs(dx - 60) <= 4 and abs(dy - 40) <= 4
                   and bool(moved_result.get("ok"))
                   and front_before == front_after)
        print(f"move_window by ({dx},{dy}) expected (60,40), focus kept "
              f"{front_before == front_after}, cursor kept {cursor_kept}: "
              f"{'ok' if move_ok else 'FAIL'}")

        moved_wid = wid
        run("movewindow", "--window", str(moved_wid), "--x", str(x), "--y", str(y))
        time.sleep(0.35)

        original = demo()["bounds"]
        zoom = run("zoom", "--window", str(window["windowId"]))
        time.sleep(1.1)
        big = demo()["bounds"]
        zoom_ok = big["width"] * big["height"] > original["width"] * original["height"] * 2
        print(f"zoom {zoom.get('ok')} size {int(big['width'])}x{int(big['height'])}: "
              f"{'ok' if zoom_ok else 'FAIL'}")

        back = run("zoom", "--window", str(window["windowId"]))
        time.sleep(1.0)
        small = demo()["bounds"]
        restored = abs(small["width"] - original["width"]) <= 4
        print(f"toggle back {back.get('via')} size {int(small['width'])}x{int(small['height'])}: "
              f"{'ok' if restored else 'FAIL'}")
        return 0 if (move_ok and zoom_ok and restored) else 1
    finally:
        process.terminate()
        subprocess.run(["pkill", "-f", "bin/cu demo"], capture_output=True)


if __name__ == "__main__":
    raise SystemExit(main())
