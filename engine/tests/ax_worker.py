#!/usr/bin/env python3
"""Retained AX worker (Task 8): press the demo button via the RETAINED object and
prove an epoch rebuild rejects the old token. Run: python3 -B engine/tests/ax_worker.py
"""
from __future__ import annotations
import json, pathlib, subprocess, sys, time
ROOT = pathlib.Path(__file__).resolve().parent.parent
CU = ROOT / "bin" / "cu"

def main() -> int:
    demo = subprocess.Popen([str(CU), "demo", "--seconds", "40"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1.8)
        listing = json.loads(subprocess.run([str(CU), "windows"], capture_output=True, text=True).stdout)
        w = next((x for x in listing.get("windows", []) if x.get("title") == "cu demo window"), None)
        if not w:
            raise RuntimeError("no demo window")
        out = subprocess.run([str(CU), "ax-worker-probe", "--pid", str(w["pid"]), "--window", str(w["windowId"])],
                             capture_output=True, text=True, timeout=20)
        payload = json.loads(out.stdout)
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0 if payload.get("ok") else 1
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)})); return 1
    finally:
        demo.terminate()
        try: demo.wait(timeout=4)
        except subprocess.TimeoutExpired: demo.kill()

if __name__ == "__main__":
    sys.exit(main())
