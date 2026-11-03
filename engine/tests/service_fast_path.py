#!/usr/bin/env python3
"""Exercise a separate service after its executable is removed.

Read-only fast paths must continue working; other commands must not be silently
executed in-process. No desktop actions are sent. The service still writes its
normal ~/.cu state and may trigger a permission check if it runs long enough.
"""
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

binary = pathlib.Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory(prefix="cu-fast-path-") as temp:
    executable = pathlib.Path(temp) / "cu"
    shutil.copy2(binary, executable)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    token = "isolated-fast-path-test"
    baseline = {}
    for command in ("frontmost", "cursor", "windows"):
        baseline[command] = json.loads(subprocess.check_output([str(executable), command]))
    process = subprocess.Popen([str(executable), "service", "--port", str(port), "--token", token],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"

    def request(path, body, authorized=True, extra=None):
        headers = {"Content-Type": "application/json"}
        if authorized:
            headers["Authorization"] = f"Bearer {token}"
        if extra:
            headers.update(extra)
        req = urllib.request.Request(base + path, json.dumps(body).encode(), headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    try:
        deadline = time.monotonic() + 3
        while True:
            try:
                with urllib.request.urlopen(base + "/v1/status", timeout=.2):
                    break
            except (OSError, urllib.error.URLError):
                if time.monotonic() > deadline or process.poll() is not None:
                    raise RuntimeError("isolated service failed to start")
                time.sleep(.02)
        executable.unlink()
        status, _ = request("/v1/exec", {"argv": ["cursor"]}, authorized=False)
        assert status == 401, status
        # Caller attribution without process scanning: a token-authenticated
        # caller may declare itself, and that name — not an lsof/ps guess —
        # must land in the clients record. Checked first, so earlier no-header
        # requests cannot have written this caller's record.
        caller_pid = os.getpid()
        sentinel = f"isolated-caller-{caller_pid}"
        record = pathlib.Path("~/.cu/clients").expanduser() / f"http-{caller_pid}.json"
        assert not record.exists(), f"stale client record {record}; remove it and rerun"
        status, result = request("/v1/exec", {"argv": ["frontmost"]}, authorized=False,
                                 extra={"X-CU-Caller-Pid": str(caller_pid), "X-CU-Caller-Name": sentinel})
        assert status == 401, status
        assert not record.exists(), "unauthorized caller must not be recorded"
        status, result = request("/v1/exec", {"argv": ["frontmost"]},
                                 extra={"X-CU-Caller-Pid": str(caller_pid), "X-CU-Caller-Name": sentinel})
        assert status == 200 and result.get("ok"), result
        assert record.exists(), "declared caller was not recorded"
        data = json.loads(record.read_text())
        assert data.get("client") == sentinel, data
        assert data.get("mcpPid") == caller_pid, data
        assert data.get("lastTool") == "frontmost", data
        record.unlink()
        for command in ("frontmost", "cursor"):
            status, result = request("/v1/exec", {"argv": [command]})
            assert status == 200 and result.get("ok") and result.get("exitCode") == 0, result
            keys = ("pid", "app") if command == "frontmost" else ("x", "y")
            assert all(key in result for key in keys), result
            # Do not require exact equality: the user may move the pointer or
            # change focus while this integration test runs.
            assert all(type(result[key]) is type(baseline[command][key]) for key in keys), result
        # windows must keep its full structure in-process; a spawn_failed here
        # means the dispatch silently regressed to the fork path. Rows are not
        # compared against the CLI baseline by index: windows open and close
        # while this runs, so only the shape is pinned.
        status, result = request("/v1/exec", {"argv": ["windows"]})
        assert status == 200 and result.get("ok") and result.get("exitCode") == 0, result
        assert result.get("count") == len(result.get("windows", [])), result
        assert set(result.get("frontmost", {})) >= {"pid", "app"}, result
        for row in result["windows"]:
            assert set(row) >= {"windowId", "pid", "app", "title", "bounds"}, row
            assert set(row["bounds"]) == {"x", "y", "width", "height"}, row
        status, result = request("/v1/call", {"tool": "cursor_position", "arguments": {}})
        assert status == 200 and result.get("ok") and result.get("exitCode") == 0, result
        status, result = request("/v1/exec", {"argv": ["cursor", "--extra"]})
        assert status == 200 and result.get("error") == "spawn_failed", result
        status, result = request("/v1/exec", {"argv": ["release"]})
        assert status == 200 and result.get("error") == "spawn_failed", result
        # The no-header requests above may still attribute this very test
        # process by scanning; that record is this harness's residue.
        record.unlink(missing_ok=True)
        print("isolated service fast paths and authorization: PASS")
    finally:
        process.terminate()
        process.wait(timeout=5)
