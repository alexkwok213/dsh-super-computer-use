#!/usr/bin/env python3
"""Background-mode check: act on an app while another app keeps the focus.

Asserts two things per round: the text lands, and the frontmost app never changes.

    python3 tests/background.py [--rounds 5] [--app TextEdit]
"""
from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
import os
import time

os.environ.setdefault("CU_NO_USER_PAUSE", "1")

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
from stability import Client  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--app", default="TextEdit")
    options = parser.parse_args()

    client = Client()
    windows, _ = client.tool("list_windows", {"app": options.app})
    candidates = [w for w in windows.get("windows", []) if "Untitled" in (w.get("title") or "")]
    if not candidates:
        print("no Untitled document window")
        return 2
    pid = candidates[0]["pid"]
    listing, _ = client.tool("list_windows", {"app": options.app})
    if any(w["windowId"] == candidates[0]["windowId"] and w.get("offStage")
           for w in listing.get("windows", [])):
        print("skip: the window is off-stage (Stage Manager); this suite never brings windows forward")
        client.close()
        return 0

    front_before, _ = client.tool("list_windows", {})
    front_pid = front_before["frontmost"]["pid"]
    if front_pid == pid:
        print("note: the target app already has focus; switch to another app for a真 background test")

    full, _ = client.tool("snapshot", {"pid": pid, "full": True})
    ref = next((line.split()[0] for line in full.get("text", "").splitlines()
                if "AXTextArea" in line and not line.startswith("input:")), None)
    if not ref:
        print("no text area")
        return 2

    failures = 0
    for index in range(1, options.rounds + 1):
        token = f"bg{index:02d}"
        click, _ = client.tool("click", {"ref": ref, "pid": pid})
        entry, _ = client.tool("type_text", {"text": token, "pid": pid})
        time.sleep(0.15)
        after, _ = client.tool("list_windows", {})
        same_focus = after["frontmost"]["pid"] == front_pid
        check, _ = client.tool("snapshot", {"pid": pid, "full": True})
        landed = token in check.get("text", "")
        print(f"{index:02d} via={click.get('via')}/{entry.get('via')} "
              f"landed={landed} focusKept={same_focus}")
        if not landed or not same_focus:
            failures += 1

    client.close()
    print(f"\n{options.rounds - failures}/{options.rounds} rounds landed without stealing focus")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
