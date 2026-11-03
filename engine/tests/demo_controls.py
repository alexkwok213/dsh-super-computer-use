#!/usr/bin/env python3
"""Exercise the widget-level tools on the engine's own demo window:
set_value, select_text, click (counter button), double-click and scroll.

    python3 tests/demo_controls.py
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
    try:
        time.sleep(1.6)
        windows, _ = client.tool("list_windows", {})
        demo = next((w for w in windows.get("windows", [])
                     if "cu demo window" in (w.get("title") or "")), None)
        if not demo:
            print("demo window did not appear")
            return 2
        if demo.get("offStage"):
            b = demo["bounds"]
            twin = next((w for w in windows.get("windows", []) if w["app"] == "WindowManager"
                         and abs(w["bounds"]["x"] - b["x"]) < 8 and abs(w["bounds"]["y"] - b["y"]) < 8
                         and abs(w["bounds"]["width"] - b["width"]) < 16
                         and abs(w["bounds"]["height"] - b["height"]) < 16), None)
            if not twin:
                print("skip: off-stage with no thumbnail")
                return 0
            o = twin["bounds"]
            client.tool("click", {"x": int(o["x"] + o["width"] / 2),
                                  "y": int(o["y"] + o["height"] / 2), "force": True})
            time.sleep(1.0)

        wid, pid = demo["windowId"], demo["pid"]
        tree = client.tool("snapshot", {"pid": pid, "full": True, "windowId": wid})[0]["text"]
        lines = tree.splitlines()

        def ref_for(needle: str, role: str | None = None) -> str | None:
            for line in lines:
                if needle in line and (role is None or f" {role} " in line):
                    return line.split()[1] if line.startswith("input:") else line.split()[0]
            return None

        field = next((l for l in lines if "AXTextField" in l and not l.startswith("input:")), None)
        button = next((l for l in lines if "AXButton" in l and "Demo Button" in l), None)
        if not field or not button:
            print("controls not found in the demo tree")
            print("\n".join(lines[:8]))
            return 2

        ok = True
        field_ref = field.split()[0]
        setv, _ = client.tool("set_value", {"ref": field_ref, "text": "hello world", "pid": pid})
        print("set_value:", setv.get("ok"), setv.get("value"))
        ok &= bool(setv.get("ok")) and setv.get("value") == "hello world"

        # Background paste goes through AX text insertion: no clipboard, no focus.
        client.tool("click", {"ref": field_ref, "pid": pid})
        pasted, _ = client.tool("paste_text", {"text": " pasted", "pid": pid})
        time.sleep(0.15)
        full_after = client.tool("snapshot", {"pid": pid, "full": True, "windowId": wid})[0]["text"]
        print("paste_text:", pasted.get("ok"), pasted.get("via"),
              "landed:", "pasted" in full_after)
        ok &= bool(pasted.get("ok")) and "pasted" in full_after

        sel, _ = client.tool("select_text", {"ref": field_ref, "text": "world", "pid": pid})
        print("select_text:", sel.get("ok"), sel.get("range"))
        ok &= bool(sel.get("ok")) and (sel.get("range") or {}).get("length") == 5

        button_ref = button.split()[0]
        click, _ = client.tool("click", {"ref": button_ref, "pid": pid})
        time.sleep(0.2)
        after = client.tool("snapshot", {"pid": pid, "full": True, "windowId": wid})[0]["text"]
        ok &= "Demo Button 1" in after
        print("click counter:", "Demo Button 1" in after)

        dbl, _ = client.tool("double_click", {"ref": button_ref, "pid": pid})
        time.sleep(0.25)
        after2 = client.tool("snapshot", {"pid": pid, "full": True, "windowId": wid})[0]["text"]
        ok &= "Demo Button 2" in after2 or "Demo Button 3" in after2
        print("double click counter:", "Demo Button 2" in after2 or "Demo Button 3" in after2)

        # click_text: the AX-first path must press the control in one engine call,
        # keep the user's focus where it was, and never fall back to OCR here.
        before_title = next((line.split('"')[1] for line in after2.splitlines()
                             if "AXButton" in line and "Demo Button" in line
                             and line.count('"') >= 2), "")
        wins_now, _ = client.tool("windows", {})
        front_before = (wins_now.get("frontmost") or {}).get("pid")
        started = time.time()
        ct, _ = client.tool("click_text", {"query": "Demo Button", "windowId": wid})
        elapsed = time.time() - started
        after3 = client.tool("snapshot", {"pid": pid, "full": True, "windowId": wid})[0]["text"]
        wins_after, _ = client.tool("windows", {})
        front_after = (wins_after.get("frontmost") or {}).get("pid")
        moved = bool(before_title) and before_title not in after3
        print("click_text:", ct.get("source"), ct.get("via"),
              f"{elapsed:.2f}s", "moved:", moved, "focus kept:", front_before == front_after)
        ok &= (ct.get("source") == "ax" and ct.get("via") == "AXPress-background"
               and moved and front_before == front_after)

        # Text lookup should come from the AX tree, not a screenshot + OCR.
        lookup_started = time.time()
        found, _ = client.tool("ocr_find", {"query": "Demo Button", "windowId": wid})
        lookup_time = time.time() - lookup_started
        print("ocr_find:", found.get("source"), f"{lookup_time:.2f}s",
              "count:", found.get("count"))
        ok &= found.get("source") == "ax" and (found.get("count") or 0) >= 1

        # Password fields are refused outright.
        secret = next((l for l in lines if "AXSecureTextField" in l), None)
        if secret:
            refused, _ = client.tool("click", {"ref": secret.split()[0], "pid": pid})
            print("secure field refused:", refused.get("error"))
            ok &= refused.get("error") == "secure_field"

        # Modal guard: a sheet on the target must block further clicks.
        sheet_button = next((l for l in lines if "AXButton" in l and "Demo Sheet" in l), None)
        if sheet_button:
            client.tool("click", {"ref": sheet_button.split()[0], "pid": pid})
            time.sleep(0.5)
            with_sheet = client.tool("snapshot", {"pid": pid, "full": True, "windowId": wid})[0]["text"]
            print("sheet open:", "AXSheet" in with_sheet)
            blocked, _ = client.tool("click", {"ref": button_ref, "pid": pid})
            print("click blocked by sheet:", blocked.get("error"))
            ok &= blocked.get("error") == "sheet_or_modal_on_target_window"
            ok_dismiss = next((l for l in with_sheet.splitlines()
                               if "AXButton" in l and '"OK"' in l), None)
            if ok_dismiss:
                client.tool("perform_action", {"ref": ok_dismiss.split()[0], "name": "AXPress", "pid": pid})
                time.sleep(0.4)

        # Scrolling is visual: the AX tree of an NSTextView does not change, so the
        # check is that the engine accepts the scroll and reports where it sent it.
        scroll_result, _ = client.tool("scroll", {"dy": -600, "pid": pid})
        print("scroll:", scroll_result.get("ok"), scroll_result.get("via"))
        ok &= bool(scroll_result.get("ok"))

        return 0 if ok else 1
    finally:
        client.close()
        process.terminate()
        subprocess.run(["pkill", "-f", "bin/cu demo"], capture_output=True)


if __name__ == "__main__":
    raise SystemExit(main())
