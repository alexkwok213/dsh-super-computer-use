#!/usr/bin/env python3
"""F2: a long action must not make status/pause look frozen.

Starts its OWN service on an isolated port/token (never the user's daily one),
runs a 2400 ms read-only expect on the action queue, then 300 ms later asks for
status and pause. Those control requests must be accepted in <=100 ms, the pause
answer must close the input gate without pretending cleanup finished, and a new
input action must be refused (never dispatched) while the gate is closed.

    python3 -B engine/tests/service_responsiveness.py
"""
from __future__ import annotations

import http.client
import json
import os
import pathlib
import random
import socket
import subprocess
import sys
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
CU = pathlib.Path(os.environ.get("CU_BIN", str(ROOT / "bin" / "cu")))


class Failure(Exception):
    pass


def http_json(port: int, method: str, path: str, token: str, body: dict | None = None,
              timeout: float = 5.0) -> tuple[dict, float]:
    started = time.perf_counter()
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    headers = {"Authorization": f"Bearer {token}"}
    payload = None
    if body is not None:
        payload = json.dumps(body)
        headers["Content-Type"] = "application/json"
    conn.request(method, path, body=payload, headers=headers)
    resp = conn.getresponse()
    raw = resp.read()
    conn.close()
    elapsed_ms = (time.perf_counter() - started) * 1000
    try:
        return json.loads(raw or b"{}"), elapsed_ms
    except json.JSONDecodeError:
        return {"_raw": raw.decode("utf-8", "replace")}, elapsed_ms


def wait_ready(port: int, token: str, timeout: float = 8.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            body, _ = http_json(port, "GET", "/v1/status", token, timeout=1.0)
            if body.get("service") == "cu":
                return
        except OSError:
            pass
        time.sleep(0.1)
    raise Failure("service did not become ready")


def main() -> int:
    port = random.randint(48000, 48999)
    token = "resp-" + str(random.randint(100000, 999999))
    proc = subprocess.Popen([str(CU), "service", "--port", str(port), "--token", token],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_ready(port, token)
        checks: list[str] = []

        # A read-only expect that would hold a serial action queue for ~2.4 s.
        target_pid = os.getpid()
        result: dict = {}

        def long_expect() -> None:
            try:
                result["body"], result["ms"] = http_json(
                    port, "POST", "/v1/exec", token,
                    {"argv": ["expect", "--pid", str(target_pid), "--find", "zzz-no-such-control",
                              "--timeout", "2400"]},
                    timeout=8.0,
                )
            except Exception as exc:  # noqa: BLE001 - the pause cancels this on purpose
                result["error"] = repr(exc)

        worker = threading.Thread(target=long_expect, daemon=True)
        worker.start()
        time.sleep(0.3)  # let the expect own the action queue

        status, status_ms = http_json(port, "GET", "/v1/status", token)
        if status_ms > 100:
            raise Failure(f"status took {status_ms:.0f} ms during a long expect (want <=100)")
        checks.append(f"status accepted in {status_ms:.0f} ms during expect")

        pause, pause_ms = http_json(port, "POST", "/v1/pause", token)
        if pause_ms > 100:
            raise Failure(f"pause took {pause_ms:.0f} ms during a long expect (want <=100)")
        if pause.get("inputGateClosed") is not True:
            raise Failure(f"pause did not close the input gate: {pause}")
        if pause.get("cleanupState") not in ("pending", "unknown", "complete"):
            raise Failure(f"pause returned an invalid cleanupState: {pause}")
        if pause.get("cleanupState") == "complete":
            raise Failure(f"pause claimed cleanup complete while an action was in flight: {pause}")
        checks.append(f"pause accepted in {pause_ms:.0f} ms, gate closed, cleanupState={pause.get('cleanupState')}")

        # The gate must refuse a new input action rather than dispatch it.
        click, _ = http_json(port, "POST", "/v1/exec", token,
                             {"argv": ["click", "--x", "5", "--y", "5", "--background"]}, timeout=8.0)
        if click.get("ok") is True:
            raise Failure(f"a click was accepted while the gate was closed: {click}")
        if click.get("error") not in ("paused_by_user", "pause"):
            raise Failure(f"the refused click did not say it was paused: {click}")
        checks.append(f"new input refused while gated ({click.get('error')})")

        # A slow request body must not starve status: hold a half-sent POST while
        # asking for status; bounded read concurrency (8) keeps a slot free.
        slow = socket.create_connection(("127.0.0.1", port), timeout=2)
        slow.sendall(b"POST /v1/exec HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer " +
                     token.encode() + b"\r\nContent-Length: 100000\r\n\r\n")
        slow.sendall(b"x" * 16)  # trickle, never finish
        status2, status2_ms = http_json(port, "GET", "/v1/status", token)
        slow.close()
        if status2_ms > 100:
            raise Failure(f"status took {status2_ms:.0f} ms while another request was mid-body (want <=100)")
        checks.append(f"status accepted in {status2_ms:.0f} ms beside a slow request body")

        http_json(port, "POST", "/v1/resume", token)

        worker.join(timeout=6.0)
        print(json.dumps({"ok": True, "checks": checks}, ensure_ascii=False, indent=2))
        return 0
    except Failure as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=4)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
