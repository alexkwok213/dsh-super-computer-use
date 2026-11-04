"""R9 regression: `/v1/exec` must forward native NDJSON phases when the caller
asks for `eventsVersion: 1`, and keep the old single-JSON behaviour otherwise.

Starts its OWN service on an isolated port/token and its OWN demo window; never
touches the user's daily service. Cleans up only the PIDs it created.
"""
from __future__ import annotations

import http.client
import json
import os
import pathlib
import random
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
CU = pathlib.Path(os.environ.get("CU_BIN", str(ROOT / "bin" / "cu")))


class Failure(Exception):
    pass


def wait_ready(port: int, token: str, timeout: float = 8.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1.0)
            conn.request("GET", "/v1/status", headers={"Authorization": f"Bearer {token}"})
            body = json.loads(conn.getresponse().read() or b"{}")
            conn.close()
            if body.get("service") == "cu":
                return
        except OSError:
            pass
        time.sleep(0.1)
    raise Failure("service did not become ready")


def main() -> int:
    port = random.randint(49000, 49999)
    token = "ndjson-" + str(random.randint(100000, 999999))
    demo = subprocess.Popen([str(CU), "demo", "--seconds", "60"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    service = subprocess.Popen([str(CU), "service", "--port", str(port), "--token", token],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_ready(port, token)
        time.sleep(1.5)
        listing = json.loads(subprocess.run([str(CU), "windows"], capture_output=True, text=True).stdout)
        window = next((w for w in listing.get("windows", []) if w.get("title") == "cu demo window"), None)
        if not window:
            raise Failure("demo window did not appear")
        pid, wid = window["pid"], window["windowId"]

        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
        body = {
            "argv": ["key", "--name", "tab", "--pid", str(pid), "--window", str(wid), "--background"],
            "eventsVersion": 1,
            "eventContext": {"sessionId": "s-service", "actionId": "a1-key", "targetGeneration": 3},
        }
        conn.request("POST", "/v1/exec", body=json.dumps(body), headers={
            "Authorization": f"Bearer {token}", "Content-Type": "application/json",
        })
        resp = conn.getresponse()
        ctype = resp.getheader("Content-Type") or ""
        raw = resp.read().decode("utf-8")
        conn.close()
        frames = [json.loads(line) for line in raw.splitlines() if line.strip()]
        events = [f["event"] for f in frames if f.get("kind") == "event"]
        result = next((f["result"] for f in frames if f.get("kind") == "result"), None)
        phases = [e["phase"] for e in events]
        kinds = {e["kind"] for e in events}
        if "ndjson" not in ctype.lower():
            raise Failure(f"eventsVersion=1 must return NDJSON, got {ctype!r}")
        if "targetReady" not in phases or "dispatched" not in phases:
            raise Failure(f"native phases missing: {phases} / {raw[-400:]!r}")
        if kinds != {"key"}:
            raise Failure(f"wrong kinds: {kinds}")
        if result is None or result.get("ok") is not True:
            raise Failure(f"final result missing/not ok: {result}")
        if not all(e.get("sessionId") == "s-service" and e.get("actionId") == "a1-key" for e in events):
            raise Failure("event context was not propagated")

        # Old callers keep the single-JSON contract.
        conn2 = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
        conn2.request("POST", "/v1/exec", body=json.dumps({
            "argv": ["key", "--name", "tab", "--pid", str(pid), "--window", str(wid), "--background"],
        }), headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        resp2 = conn2.getresponse()
        ctype2 = resp2.getheader("Content-Type") or ""
        raw2 = resp2.read().decode("utf-8")
        conn2.close()
        parsed2 = json.loads(raw2)
        if "application/json" not in ctype2.lower() or "kind" in parsed2:
            raise Failure(f"legacy call must stay one JSON object, got {ctype2!r} / {raw2[:200]!r}")
        if parsed2.get("ok") is not True:
            raise Failure(f"legacy call failed: {parsed2}")

        print(json.dumps({
            "ok": True, "contentType": ctype, "phases": phases, "kinds": sorted(kinds),
            "eventCount": len(events), "legacyContentType": ctype2,
        }, ensure_ascii=False, indent=2))
        return 0
    except Failure as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1
    finally:
        for proc in (service, demo):
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=4)
                except subprocess.TimeoutExpired:
                    proc.kill(); proc.wait()


if __name__ == "__main__":
    sys.exit(main())
