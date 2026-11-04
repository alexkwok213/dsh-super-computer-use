#!/usr/bin/env python3
"""Cursor helper owns preview: preview.start spawns `cu preview`, preview.stop ends it.
Run: python3 -B engine/tests/helper_preview_control.py
"""
from __future__ import annotations
import json, pathlib, subprocess, sys, time
ROOT = pathlib.Path(__file__).resolve().parent.parent
CU = ROOT / "bin" / "cu"

def ps_has(needle: str) -> bool:
    out = subprocess.run(["ps", "-Ao", "pid=,command="], capture_output=True, text=True).stdout
    return any(needle in line for line in out.splitlines())

def main() -> int:
    demo = subprocess.Popen([str(CU), "demo", "--seconds", "60"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    overlay = None
    try:
        time.sleep(1.8)
        listing = json.loads(subprocess.run([str(CU), "windows"], capture_output=True, text=True).stdout)
        w = next((x for x in listing.get("windows", []) if x.get("title") == "cu demo window" and x.get("windowId", 0) > 0), None)
        if not w: raise RuntimeError("no demo window")
        wid = w["windowId"]

        overlay = subprocess.Popen([str(CU), "cursor-overlay"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        ready = overlay.stdout.readline().strip()
        if '"cursor":"ready"' not in ready.replace(" ", ""):
            raise RuntimeError(f"overlay not ready: {ready!r}")

        def send(obj):
            overlay.stdin.write(json.dumps(obj) + "\n"); overlay.stdin.flush()

        send({"cmd": "preview.start", "windowId": wid})
        time.sleep(1.6)
        started = ps_has(f"preview --window {wid}")
        if not started:
            raise RuntimeError("preview.start did not spawn a cu preview child")

        send({"cmd": "preview.visible", "visible": False})
        time.sleep(0.3)
        send({"cmd": "preview.stop"})
        time.sleep(1.2)
        stopped = not ps_has(f"preview --window {wid}")
        if not stopped:
            raise RuntimeError("preview.stop did not end the cu preview child")

        print(json.dumps({"ok": True, "spawned": started, "stopped": stopped}, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)})); return 1
    finally:
        if overlay and overlay.poll() is None:
            try: overlay.stdin.close()
            except Exception: pass
            overlay.kill()
        pkill = subprocess.run(["pkill", "-f", "cu preview"], capture_output=True)
        demo.terminate()
        try: demo.wait(timeout=4)
        except subprocess.TimeoutExpired: demo.kill()

if __name__ == "__main__":
    sys.exit(main())
