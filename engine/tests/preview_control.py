#!/usr/bin/env python3
"""Preview control protocol (Task 7): visible=false pauses the stream, visible=true
resumes, stop closes — each acknowledged with the live frame count, so hiding a
card is proven to cost no capture.

    python3 -B engine/tests/preview_control.py
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


def send(proc, obj):
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()


def read_json(proc):
    line = proc.stdout.readline()
    if not line:
        raise Failure("preview exited without a reply")
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        raise Failure(f"non-JSON line: {line!r}")


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

        preview = subprocess.Popen([str(CU), "preview", "--window", str(window["windowId"]), "--seconds", "30"],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        start = read_json(preview)
        if start.get("preview") != "starting":
            raise Failure(f"no start ack: {start}")

        time.sleep(1.2)
        send(preview, {"cmd": "status"})
        a = read_json(preview)
        if not a.get("frames", 0) > 0:
            raise Failure(f"no frames while visible: {a}")

        send(preview, {"cmd": "visible", "visible": False})
        b = read_json(preview)
        time.sleep(1.2)
        send(preview, {"cmd": "status"})
        c = read_json(preview)
        paused_growth = c["frames"] - b["frames"]
        if paused_growth > 4:
            raise Failure(f"stream kept capturing while hidden (+{paused_growth} frames)")

        send(preview, {"cmd": "visible", "visible": True})
        read_json(preview)
        time.sleep(1.2)
        send(preview, {"cmd": "status"})
        d = read_json(preview)
        if d["frames"] <= c["frames"]:
            raise Failure(f"stream did not resume after shown ({c['frames']} -> {d['frames']})")

        send(preview, {"cmd": "stop"})
        read_json(preview)  # stop ack
        final = read_json(preview)  # shown
        if final.get("ok") is not True or final.get("frames", 0) <= 0:
            raise Failure(f"bad final: {final}")
        preview.wait(timeout=5)

        print(json.dumps({
            "ok": True,
            "framesVisible": a["frames"],
            "pausedGrowth": paused_growth,
            "framesAfterResume": d["frames"],
            "finalFrames": final["frames"],
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
