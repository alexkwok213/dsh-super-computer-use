#!/usr/bin/env python3
"""Static-frame preview fallback (Task 7): one SCScreenshotManager frame shown
statically, not a per-frame loop. Run: python3 -B engine/tests/preview_static.py
"""
from __future__ import annotations
import json, pathlib, subprocess, sys, time
ROOT = pathlib.Path(__file__).resolve().parent.parent
CU = ROOT / "bin" / "cu"

def main() -> int:
    demo = subprocess.Popen([str(CU), "demo", "--seconds", "60"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    prev = None
    try:
        time.sleep(1.8)
        listing = json.loads(subprocess.run([str(CU), "windows"], capture_output=True, text=True).stdout)
        w = next((x for x in listing.get("windows", []) if x.get("title") == "cu demo window"), None)
        if not w: raise RuntimeError("no demo window")
        prev = subprocess.Popen([str(CU), "preview", "--window", str(w["windowId"]), "--seconds", "3", "--static"],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        # The result line is emitted once, right after the static capture.
        line = prev.stdout.readline()
        payload = json.loads(line)
        time.sleep(0.4)
        listing2 = json.loads(subprocess.run([str(CU), "windows"], capture_output=True, text=True).stdout)
        card = next((x for x in listing2.get("windows", []) if "cu preview" in (x.get("title") or "")), None)
        ok = (payload.get("ok") is True and payload.get("mode") == "static"
              and isinstance(payload.get("pixelWidth"), int) and payload.get("pixelWidth") > 0
              and card is not None)
        print(json.dumps({"ok": ok, "result": payload, "cardOnScreen": bool(card)}, ensure_ascii=False, indent=2))
        return 0 if ok else 1
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)})); return 1
    finally:
        if prev and prev.poll() is None: prev.kill()
        demo.terminate()
        try: demo.wait(timeout=4)
        except subprocess.TimeoutExpired: demo.kill()

if __name__ == "__main__":
    sys.exit(main())
