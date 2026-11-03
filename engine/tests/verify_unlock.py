#!/usr/bin/env python3
"""One-command live verification for the 2026-10-29 engine fixes.

Runs three read-only checks and prints a report:
  1. ax_find sees deep controls (engine demo window, 16-level view chain)
  2. the menu bar app can capture on our behalf (shot --via-app)
  3. WorkBuddy's composer is visible to ax_find (deep Electron web content)

Needs an unlocked session: while the screen is locked every AX tree collapses
to the menu bar and ScreenCaptureKit reports no displays.

    python3 tests/verify_unlock.py
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


def check_deepfind() -> str:
    demo = subprocess.Popen([str(CU), "demo", "--seconds", "90"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    client = Client()
    try:
        time.sleep(1.6)
        windows, _ = client.tool("list_windows", {})
        window = next((w for w in windows.get("windows", [])
                       if "cu demo window" in (w.get("title") or "")), None)
        if not window:
            return "FAIL — demo window did not appear"
        found, elapsed = client.tool("ax_find", {"pid": window["pid"], "query": "深层按钮"})
        matches = found.get("matches") or []
        if not matches:
            return "FAIL — ax_find cannot see the 16-level button"
        depth = matches[0].get("ref", "k").count(".")
        actions = matches[0].get("actions") or []
        return (f"ok — found at depth {depth}, actions {actions}, "
                f"{elapsed * 1000:.0f} ms")
    finally:
        demo.terminate()
        client.process.terminate()


def check_app_capture() -> str:
    out = "/tmp/cu-verify-shot.png"
    pathlib.Path(out).unlink(missing_ok=True)
    result = subprocess.run([str(CU), "shot", "--screen", "--via-app",
                             "--max-dim", "400", "--out", out],
                            capture_output=True, text=True, timeout=30)
    try:
        payload = json.loads(result.stdout or "{}")
    except json.JSONDecodeError:
        return f"FAIL — unparsable output: {result.stdout[:200]}"
    if payload.get("ok") and pathlib.Path(out).exists():
        return (f"ok — menu bar app captured {payload.get('bytes')} bytes "
                f"({payload.get('size', {}).get('width')}x{payload.get('size', {}).get('height')})")
    return f"FAIL — {payload.get('error')}: {payload.get('message')}"


def check_workbuddy() -> str:
    listing = subprocess.run([str(CU), "windows"], capture_output=True, text=True, timeout=15)
    try:
        windows = json.loads(listing.stdout or "{}").get("windows", [])
    except json.JSONDecodeError:
        return "SKIP — cannot list windows"
    window = next((w for w in windows if w.get("app") == "WorkBuddy"), None)
    if not window:
        return "SKIP — WorkBuddy is not running"
    found = subprocess.run([str(CU), "ax", "--pid", str(window["pid"]), "--find", "工作空间"],
                           capture_output=True, text=True, timeout=30)
    try:
        payload = json.loads(found.stdout or "{}")
    except json.JSONDecodeError:
        return "FAIL — ax_find output unparsable"
    matches = payload.get("matches") or []
    if matches:
        roles = sorted({m.get("role", "?") for m in matches})
        return f"ok — composer controls visible ({len(matches)} matches: {roles})"
    return "FAIL — WorkBuddy web content not searchable (locked screen? app changed?)"


def main() -> int:
    print("== ax_find deep search ==")
    deep = check_deepfind()
    print(" ", deep)
    print("== menu bar app capture ==")
    capture = check_app_capture()
    print(" ", capture)
    print("== WorkBuddy composer ==")
    workbuddy = check_workbuddy()
    print(" ", workbuddy)
    hard_failures = sum(1 for r in (deep, capture) if r.startswith("FAIL"))
    print(f"\n{hard_failures} hard failure(s); WorkBuddy result informational")
    return 1 if hard_failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
