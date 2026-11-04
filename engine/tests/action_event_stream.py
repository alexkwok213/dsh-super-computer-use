#!/usr/bin/env python3
"""Native action-event stream (`--events-v1`) against the engine's own demo.

Proves the native CLI emits NDJSON phase events BEFORE its final result, that a
dispatched input event arrives before the command finishes, that a satisfied
expect ends `verified`, and that the default CLI output is still one JSON object.

    python3 -B engine/tests/action_event_stream.py
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


def run_lines(argv: list[str]) -> tuple[list[dict], str]:
    proc = subprocess.run([str(CU), *argv], capture_output=True, text=True, timeout=30)
    lines = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
    return lines, proc.stdout


def events_of(lines: list[dict]) -> list[dict]:
    return [entry["event"] for entry in lines if entry.get("kind") == "event"]


def result_of(lines: list[dict]) -> dict | None:
    for entry in lines:
        if entry.get("kind") == "result":
            return entry["result"]
    return None


def main() -> int:
    demo = subprocess.Popen([str(CU), "demo", "--seconds", "60"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1.8)
        listing = json.loads(subprocess.run([str(CU), "windows"], capture_output=True, text=True).stdout)
        window = next((w for w in listing.get("windows", []) if w.get("title") == "cu demo window"), None)
        if not window:
            raise Failure("demo window did not appear")
        pid, wid = window["pid"], window["windowId"]

        snap = json.loads(subprocess.run(
            [str(CU), "snapshot", "--pid", str(pid), "--window", str(wid)], capture_output=True, text=True).stdout)
        button = next((n for n in snap.get("nodes", []) if str(n.get("title", "")).startswith("Demo Button")), None)
        if not button:
            raise Failure("no Demo Button in the demo window")

        # --- click: targetReady → dispatched → result -----------------------
        lines, raw = run_lines([
            "click", "--ref", button["ref"], "--pid", str(pid), "--window", str(wid), "--background",
            "--events-v1", "--session-id", "s-test", "--action-id", "a1-click",
        ])
        ev = events_of(lines)
        phases = [e["phase"] for e in ev]
        if "targetReady" not in phases or "dispatched" not in phases:
            raise Failure(f"click phases missing targetReady/dispatched: {phases} / raw={raw!r}")
        if phases.index("dispatched") < phases.index("targetReady"):
            raise Failure(f"dispatched must follow targetReady: {phases}")
        # dispatched must be before the final result line
        result_index = next((i for i, l in enumerate(lines) if l.get("kind") == "result"), None)
        dispatched_index = next((i for i, l in enumerate(lines) if l.get("kind") == "event" and l["event"]["phase"] == "dispatched"), None)
        if result_index is None or dispatched_index is None or dispatched_index >= result_index:
            raise Failure("dispatched did not arrive before the final result")
        if not all(e["source"] == "native" and e["version"] == 1 for e in ev):
            raise Failure(f"events not native/v1: {ev}")
        if (result_of(lines) or {}).get("ok") is not True:
            raise Failure(f"click result not ok: {result_of(lines)}")

        # --- expect: targetReady → verified → result ------------------------
        lines2, raw2 = run_lines([
            "expect", "--pid", str(pid), "--window", str(wid), "--find", "Demo Button", "--timeout", "800",
            "--events-v1", "--session-id", "s-test", "--action-id", "a2-expect",
        ])
        phases2 = [e["phase"] for e in events_of(lines2)]
        if "verified" not in phases2:
            raise Failure(f"expect did not emit verified: {phases2} / raw={raw2!r}")
        if not (result_of(lines2) or {}).get("ok"):
            raise Failure(f"expect result not ok: {result_of(lines2)}")

        # --- type / key / scroll also emit native phases (R9) ---------------
        for kind, argv in [
            ("key", ["key", "--name", "tab", "--pid", str(pid), "--window", str(wid), "--background"]),
            ("scroll", ["scroll", "--dy", "10", "--pid", str(pid), "--window", str(wid), "--background"]),
            ("type", ["type", "--text", "probe", "--pid", str(pid), "--window", str(wid), "--background"]),
        ]:
            lines_k, raw_k = run_lines(argv + ["--events-v1", "--session-id", "s-test", "--action-id", f"a-{kind}"])
            ev_k = events_of(lines_k)
            phases_k = [e["phase"] for e in ev_k]
            if "targetReady" not in phases_k or "dispatched" not in phases_k:
                raise Failure(f"{kind} phases missing targetReady/dispatched: {phases_k} / raw={raw_k[-300:]!r}")
            if {e["kind"] for e in ev_k} != {kind}:
                raise Failure(f"{kind} emitted wrong kinds: {[e['kind'] for e in ev_k]}")
            idx_d = next((i for i, l in enumerate(lines_k) if l.get("kind") == "event" and l["event"]["phase"] == "dispatched"), None)
            idx_r = next((i for i, l in enumerate(lines_k) if l.get("kind") == "result"), None)
            if idx_d is None or idx_r is None or idx_d >= idx_r:
                raise Failure(f"{kind} dispatched was not emitted before the final result")

        # --- default CLI stays a single bare JSON ---------------------------
        lines3, raw3 = run_lines(["expect", "--pid", str(pid), "--window", str(wid), "--find", "Demo Button", "--timeout", "500"])
        if any(entry.get("kind") in ("event", "result") for entry in lines3):
            raise Failure(f"default CLI must not emit an event envelope: {raw3!r}")
        if len(lines3) != 1 or "ok" not in lines3[0]:
            raise Failure(f"default CLI must be one JSON object: {raw3!r}")

        print(json.dumps({
            "ok": True,
            "clickPhases": phases,
            "expectPhases": phases2,
            "defaultSingleJson": True,
        }, ensure_ascii=False, indent=2))
        return 0
    except Failure as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1
    finally:
        demo.terminate()
        try:
            demo.wait(timeout=4)
        except subprocess.TimeoutExpired:
            demo.kill()


if __name__ == "__main__":
    sys.exit(main())
