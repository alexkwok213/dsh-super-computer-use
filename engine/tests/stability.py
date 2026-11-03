#!/usr/bin/env python3
"""Repeat the same edit loop against a scratch TextEdit document and report
reliability and latency. This is the check that turns "works once" into
"works every time", which is what the user-visible experience depends on.

    python3 tests/stability.py [--rounds 20] [--app TextEdit]
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
SERVER = ROOT / "mcp" / "server.py"


class Client:
    def __init__(self) -> None:
        self.process = subprocess.Popen([sys.executable, str(SERVER)], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, text=True)
        self.ident = 0
        self.call("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                 "clientInfo": {"name": "stability", "version": "0"}})
        self.note("initialized")

    def note(self, method: str) -> None:
        self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "method": f"notifications/{method}"}) + "\n")
        self.process.stdin.flush()

    def call(self, method: str, params: dict) -> dict:
        self.ident += 1
        message = {"jsonrpc": "2.0", "id": self.ident, "method": method, "params": params}
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()
        return json.loads(self.process.stdout.readline())

    def tool(self, name: str, arguments: dict) -> tuple[dict, float]:
        # The engine pauses when the human touches the machine between steps; a
        # caller simply retries once, which is what a model does too.
        for attempt in range(3):
            started = time.time()
            response = self.call("tools/call", {"name": name, "arguments": arguments})
            elapsed = time.time() - started
            result = response.get("result", {})
            body = result.get("content", [{}])
            text = body[0].get("text", "") if body else ""
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                payload = {"ok": not result.get("isError", False), "text": text}
            payload["_isError"] = result.get("isError", False)
            if payload.get("error") == "user_recently_active" and attempt < 2:
                time.sleep(0.6)
                continue
            return payload, elapsed
        return payload, elapsed

    def close(self) -> None:
        self.process.stdin.close()
        self.process.wait(timeout=5)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rounds", type=int, default=20)
    parser.add_argument("--app", default="TextEdit")
    options = parser.parse_args()

    client = Client()
    launch, _ = client.tool("launch_app", {"app": options.app})
    if not launch.get("ok"):
        print("cannot launch the scratch app:", launch)
        return 2
    time.sleep(1.2)

    windows, _ = client.tool("list_windows", {"app": options.app})
    candidates = [w for w in windows.get("windows", []) if "Untitled" in (w.get("title") or "")]
    if not candidates:
        print("no Untitled document window; open one first")
        return 2
    window = candidates[0]
    pid = window["pid"]
    listing, _ = client.tool("list_windows", {"app": options.app})
    if any(w["windowId"] == window["windowId"] and w.get("offStage") for w in listing.get("windows", [])):
        print("skip: the window is off-stage (Stage Manager); this suite never brings windows forward")
        client.close()
        return 0

    client.tool("start_session", {"windowId": window["windowId"],
                                  "label": "稳定性测试 — TextEdit"})

    def find_text_area() -> str | None:
        full, _ = client.tool("snapshot", {"pid": pid, "full": True})
        for line in full.get("text", "").splitlines():
            if "AXTextArea" in line and not line.startswith("input:"):
                return line.split()[0]
        return None

    ref = find_text_area()
    if not ref:
        print("no text area in the initial tree")
        return 2

    latencies, failures = [], []
    for round_index in range(1, options.rounds + 1):
        token = f"r{round_index:02d}"
        # The ref is kept across rounds on purpose: a diff that says "no change"
        # means the previous refs are still valid.
        snap, snap_time = client.tool("snapshot", {"pid": pid})
        if snap.get("_isError"):
            failures.append((round_index, "snapshot", snap.get("text", "")[:120]))
            continue

        click, click_time = client.tool("click", {"ref": ref, "pid": pid})
        if not click.get("ok"):
            if "stale" in json.dumps(click):
                ref = find_text_area() or ref
                click, click_time = client.tool("click", {"ref": ref, "pid": pid})
            if not click.get("ok"):
                failures.append((round_index, "click", json.dumps(click)[:140]))
                continue

        # Every fourth round wipes the document with cmd+a first, so the key tool
        # and the modifier path are exercised too.
        if round_index % 4 == 0:
            key, key_time = client.tool("press_key", {"name": "a", "mods": "cmd", "pid": pid})
            if not key.get("ok"):
                failures.append((round_index, "key", json.dumps(key)[:140]))
                continue
        else:
            key_time = 0.0

        if round_index % 5 == 0:
            entry, type_time = client.tool("paste_text", {"text": token, "pid": pid})
        else:
            entry, type_time = client.tool("type_text", {"text": token, "pid": pid})
        if not entry.get("ok"):
            failures.append((round_index, "type", json.dumps(entry)[:140]))
            continue

        time.sleep(0.15)
        check, check_time = client.tool("snapshot", {"pid": pid})
        text = check.get("text", "")
        landed = token in text
        latencies.append({"snapshot": snap_time, "click": click_time, "key": key_time,
                          "type": type_time, "verify": check_time})
        if not landed:
            failures.append((round_index, "verify", text.splitlines()[0][:120]))
        print(f"{round_index:02d} click={click_time:.2f}s type={type_time:.2f}s "
              f"verify={check_time:.2f}s landed={landed}")

    client.tool("stop_session", {})
    client.close()

    def stats(key: str) -> str:
        values = [row[key] for row in latencies if row[key] > 0]
        if not values:
            return "n/a"
        return f"median {statistics.median(values):.2f}s max {max(values):.2f}s"

    print("\n== summary ==")
    print(f"rounds {options.rounds} | completed {len(latencies)} | failures {len(failures)}")
    for key in ("snapshot", "click", "type", "verify"):
        print(f"  {key:8s} {stats(key)}")
    for failure in failures:
        print("  !! round", failure[0], failure[1], failure[2])
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
