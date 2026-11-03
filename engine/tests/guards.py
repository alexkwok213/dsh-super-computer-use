#!/usr/bin/env python3
"""Safety-layer regression tests. These assert the refusals, not the actions, so
they can run without touching the user's work.

    python3 tests/guards.py
"""
from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time

os.environ["CU_NO_USER_PAUSE"] = "1"

ROOT = pathlib.Path(__file__).resolve().parent.parent
CU = ROOT / "bin" / "cu"
ALLOWLIST = pathlib.Path(os.path.expanduser("~/.cu/allowed-apps.json"))
PAUSE = pathlib.Path(os.path.expanduser("~/.cu/pause"))

passed, failed = 0, 0


def run(*args: str, allow_user_pause: bool = False) -> tuple[int, dict]:
    env = os.environ.copy()
    if allow_user_pause:
        env.pop("CU_NO_USER_PAUSE", None)
    completed = subprocess.run([str(CU), *args], capture_output=True, text=True,
                               timeout=30, env=env)
    lines = (completed.stdout or "").strip().splitlines()
    try:
        payload = json.loads(lines[-1]) if lines else {}
    except json.JSONDecodeError:
        payload = {"raw": lines[-1] if lines else ""}
    return completed.returncode, payload


def check(name: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {detail}")


def windows() -> list[dict]:
    _, payload = run("windows")
    return payload.get("windows", [])


def restore_allowlist(original: bytes | None) -> None:
    if original is None:
        ALLOWLIST.unlink(missing_ok=True)
    else:
        ALLOWLIST.write_bytes(original)


def main() -> int:
    original_allowlist = ALLOWLIST.read_bytes() if ALLOWLIST.exists() else None
    paused_before = PAUSE.exists()

    print("== pause + resume ==")
    run("pause")
    code, payload = run("click", "--x", "400", "--y", "400", "--dry-run")
    check("paused click refused", payload.get("error") == "paused_by_user", json.dumps(payload)[:120])
    check("paused refusal exits non-zero", code != 0)
    run("resume")
    _, guards = run("guards")
    check("resume clears the pause", guards.get("paused") is False)

    print("== stale ref ==")
    targets = [w for w in windows() if w["bounds"]["width"] > 300]
    if targets:
        pid = targets[0]["pid"]
        code, payload = run("click", "--pid", str(pid), "--ref", "k99.99.99")
        check("unknown ref refused", payload.get("error") == "stale_ref", json.dumps(payload)[:120])
    else:
        print("  skip (no window wider than 300 px)")

    _, guards = run("guards")
    overlays = bool(guards.get("occluder"))
    print("== allowlist ==")
    if targets and not overlays:
        target = targets[0]
        try:
            _, payload = run("allow", "--app", "com.apple.finder")
            check("allow writes the list", payload.get("apps") == ["com.apple.finder"])
            code, payload = run("type", "--pid", str(target["pid"]), "--text", "x")
            check("unlisted app refused", payload.get("error") == "app_not_allowed",
                  json.dumps(payload)[:140])
        finally:
            restore_allowlist(original_allowlist)
    else:
        print("  skip (no target window, or a system overlay is masking the guards)")

    print("== destructive menu item ==")
    if targets:
        pid = str(targets[0]["pid"])
        _, menus = run("menu", "--pid", pid)
        destructive = None
        for menu in menus.get("menus", []):
            for item in menu.get("items", []):
                title = item.get("title", "").lower()
                if any(word in title for word in ("close", "quit", "delete", "关闭", "退出", "删除")):
                    destructive = f"{menu['title']}/{item['title']}"
                    break
            if destructive:
                break
        if destructive:
            code, payload = run("menu", "--pid", pid, "--path", destructive)
            check("destructive menu item refused", payload.get("error") == "destructive_menu_item",
                  json.dumps(payload)[:140])
            check("refusal exits non-zero", code != 0)
        else:
            print("  skip (no destructive item advertised)")
    else:
        print("  skip (no target window)")

    print("== user intervention ==")
    # Synthetic events never advance the HID idle counter, so the decision is
    # checked through the pure-function seam instead of a real keystroke.
    now = time.time()
    _, fresh = run("guards", "--simulate-last", str(now - 2), "--simulate-idle", "0.2")
    check("recent input after our action pauses", fresh.get("userIntervened") is True,
          json.dumps(fresh))
    _, quiet = run("guards", "--simulate-last", str(now - 2), "--simulate-idle", "4.5")
    check("quiet machine is not paused", quiet.get("userIntervened") is False,
          json.dumps(quiet))
    _, immediate = run("guards", "--simulate-last", str(now - 0.4), "--simulate-idle", "0.1")
    _, stale = run("guards", "--simulate-last", str(now - 60), "--simulate-idle", "0.2")
    check("a stale marker never blocks", stale.get("userIntervened") is False, json.dumps(stale))
    check("right after our own action is not paused", immediate.get("userIntervened") is False,
          json.dumps(immediate))

    print("== occluder ==")
    if overlays:
        _, payload = run("click", "--x", "400", "--y", "400", "--dry-run")
        check("system overlay refused", payload.get("error") == "occluder_fills_screen",
              json.dumps(payload)[:120])
    else:
        print("  skip (no Mission Control overlay right now)")

    if not paused_before:
        run("resume")

    print(f"\n{passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
