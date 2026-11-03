#!/usr/bin/env python3
"""Chromium repeatability check: address bar click → type → read back, N times.

Chromium only exposes its accessibility tree once a client asks for it, and its
focus model differs from AppKit apps, so this runs the same loop the TextEdit
stability test runs, against the hardest common target.

    python3 tests/chromium.py [--rounds 10]
"""
from __future__ import annotations

import argparse
import json
import pathlib
import statistics
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
    parser.add_argument("--rounds", type=int, default=10)
    options = parser.parse_args()

    existing = subprocess.run([str(ROOT / "bin" / "cu"), "windows"], capture_output=True, text=True)
    try:
        have_blank = any(w.get("app") == "Google Chrome" and (w.get("title") or "") in ("New Tab", "about:blank")
                         for w in json.loads(existing.stdout.strip().splitlines()[-1])["windows"])
    except (IndexError, json.JSONDecodeError):
        have_blank = False
    if not have_blank:
        subprocess.run(["open", "-na", "Google Chrome", "--args", "--new-window", "about:blank"],
                       check=False)
        time.sleep(2.5)

    client = Client()
    windows, _ = client.tool("list_windows", {"app": "Chrome"})
    blanks = [w for w in windows.get("windows", []) if w.get("title") == "about:blank"]
    if not blanks:
        print("no about:blank window; open one first")
        return 2
    window = blanks[0]
    pid = window["pid"]
    # Stage Manager hides a fresh window behind a thumbnail; Chromium's AX frames
    # stay stale until the window is actually on stage. Click the thumbnail of the
    # window this suite just opened (never a user window) and re-read the tree.
    listing, _ = client.tool("list_windows", {"app": "Chrome"})
    entry = next((w for w in listing.get("windows", []) if w["windowId"] == window["windowId"]), None)
    if entry and entry.get("offStage"):
        b = entry["bounds"]
        overlay, _ = client.tool("list_windows", {})
        twin = next((w for w in overlay.get("windows", []) if w["app"] == "WindowManager"
                     and abs(w["bounds"]["x"] - b["x"]) < 8
                     and abs(w["bounds"]["y"] - b["y"]) < 8
                     and abs(w["bounds"]["width"] - b["width"]) < 16
                     and abs(w["bounds"]["height"] - b["height"]) < 16), None)
        if not twin:
            print("skip: off-stage and no thumbnail to click")
            client.close()
            return 0
        o = twin["bounds"]
        client.tool("click", {"x": int(o["x"] + o["width"] / 2),
                              "y": int(o["y"] + o["height"] / 2), "force": True})
        time.sleep(1.0)
    client.tool("start_session", {"windowId": window["windowId"], "label": "Chromium 复测"})

    latencies, failures = [], []
    for round_index in range(1, options.rounds + 1):
        token = f"t{round_index:02d}.example"
        snap, snap_time = client.tool("snapshot", {"pid": pid, "full": True,
                                                     "windowId": window["windowId"]})
        inputs = [line for line in snap.get("text", "").splitlines() if line.startswith("input:")]
        if not inputs:
            failures.append((round_index, "no_input"))
            continue
        # The address bar is not always the first field; prefer the one Chromium
        # titles "Address", then a focused one, then a non-empty one.
        preferred = ([line for line in inputs if "Address" in line]
                     or [line for line in inputs if "[focused]" in line]
                     or [line for line in inputs if line.strip().endswith(('"', '" [focused]'))]
                     or inputs)
        ref = preferred[0].split()[1]

        # Chromium's omnibox only accepts synthetic typing while its window holds
        # the keyboard, so this suite exercises the foreground path on purpose.
        click, click_time = client.tool("click", {"ref": ref, "pid": pid, "foreground": True})
        if not click.get("ok"):
            if click.get("error") in ("ref_outside_window", "off_stage_window",
                                      "point_outside_any_window", "not_frontmost", "stale_ref"):
                print("skip:", click.get("error"), "- the tree is stale under Stage Manager")
                client.close()
                return 0
            failures.append((round_index, "click", json.dumps(click)[:140]))
            continue

        entry, type_time = client.tool("type_text", {"text": token, "pid": pid, "foreground": True})
        if not entry.get("ok"):
            failures.append((round_index, "type", json.dumps(entry)[:140]))
            continue

        time.sleep(0.2)
        check, check_time = client.tool("snapshot", {"pid": pid, "full": True,
                                                       "windowId": window["windowId"]})
        line = next((l for l in check.get("text", "").splitlines()
                     if l.startswith(f"input: {ref} ")), "")
        landed = token in line
        latencies.append((snap_time, click_time, type_time, check_time))
        print(f"{round_index:02d} click={click_time:.2f}s type={type_time:.2f}s "
              f"via={entry.get('via')} landed={landed}")
        if not landed:
            failures.append((round_index, "verify", line[:120]))

    client.tool("stop_session", {})
    # Close only the window this suite opened, via its own close button.
    tree, _ = client.tool("snapshot", {"pid": pid, "full": True, "windowId": window["windowId"]})
    close_ref = None
    for line in tree.get("text", "").splitlines():
        if "AXCloseButton" in line:
            close_ref = line.split()[1] if line.startswith("input:") else line.split()[0]
            break
    if close_ref:
        client.tool("perform_action", {"ref": close_ref, "name": "AXPress", "pid": pid})
    client.close()

    print("\n== summary ==")
    print(f"rounds {options.rounds} | completed {len(latencies)} | failures {len(failures)}")
    if latencies:
        for index, name in enumerate(("snapshot", "click", "type", "verify")):
            values = [row[index] for row in latencies]
            print(f"  {name:8s} median {statistics.median(values):.2f}s max {max(values):.2f}s")
    for failure in failures:
        print("  !! round", failure[0], failure[1], failure[2])
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
