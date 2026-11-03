#!/usr/bin/env python3
"""Prove that ax_find searches as deep as snapshot does.

Chromium/Electron bury controls ~20 levels down, and labels often live in
AXDescription rather than AXTitle. The engine's own demo window grows a 16-level
view chain with a button at the bottom, so this check needs nothing but the
engine itself:

    python3 tests/deepfind.py
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
from stability import Client  # noqa: E402

CU = ROOT / "bin" / "cu"


def main() -> int:
    process = subprocess.Popen([str(CU), "demo", "--seconds", "120"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    client = Client()
    failures = 0
    try:
        time.sleep(1.6)
        windows, _ = client.tool("list_windows", {})
        demo = next((w for w in windows.get("windows", [])
                     if "cu demo window" in (w.get("title") or "")), None)
        if not demo:
            print("demo window did not appear")
            return 2
        pid = demo["pid"]

        found, elapsed = client.tool("ax_find", {"pid": pid, "query": "深层按钮"})
        matches = found.get("matches") or []
        if matches:
            print(f"  ok   deep button found via ax_find ({elapsed * 1000:.0f} ms)")
        else:
            failures += 1
            print("  FAIL deep button not found by ax_find")

        if matches:
            hit = matches[0]
            depth = hit.get("ref", "k").count(".")
            if depth >= 15:
                print(f"  ok   match sits {depth} levels down the tree")
            else:
                failures += 1
                print(f"  FAIL match depth {depth} — expected 15+")
            if "AXPress" in (hit.get("actions") or []):
                print("  ok   match carries its actions (clickable without a snapshot)")
            else:
                failures += 1
                print("  FAIL match has no actions listed")

        snap, _ = client.tool("snapshot", {"pid": pid})
        rendered = snap.get("text") or json.dumps(snap.get("nodes", []), ensure_ascii=False)
        seen = [line for line in rendered.splitlines() if "深层按钮" in line]
        if seen:
            print("  ok   snapshot and ax_find agree on the same control")
        else:
            failures += 1
            print("  FAIL snapshot cannot see the deep button")

        missing, _ = client.tool("ax_find", {"pid": pid, "query": "不存在的控件名"})
        if not (missing.get("matches") or []):
            print("  ok   absent text returns no matches")
        else:
            failures += 1
            print("  FAIL absent text matched something")

        # The fix must not change the depth-6 behaviour of the raw dump.
        raw = subprocess.run([str(CU), "ax", "--pid", str(pid), "--depth", "6"],
                             capture_output=True, text=True, timeout=30)
        dump = json.loads(raw.stdout or "{}")
        if dump.get("ok") and dump.get("count", 0) > 0:
            print("  ok   raw ax dump still works")
        else:
            failures += 1
            print("  FAIL raw ax dump broke")
    finally:
        process.terminate()
        client.process.terminate()

    print(f"\n{'failed' if failures else 'passed'}: {failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
