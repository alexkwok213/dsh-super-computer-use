#!/usr/bin/env python3
"""Installed-component consistency check (round 2).

Read-only: verifies the installed app, background service and preview helper
come from the same build, that each signature is valid where it runs, and that
the running service reports the same buildId. Never prints the service token.

    python3 -B engine/tests/install_consistency.py
"""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile

HOME = pathlib.Path.home()
APP = pathlib.Path("/Applications/Computer Use.app")
APP_BIN = APP / "Contents/MacOS/Computer Use"
SERVICE = HOME / "Library/Application Support/cu/bin/cu"
PREVIEW = HOME / "Library/Application Support/cu/bin/cu-preview"


def sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def unsigned_sha256(path: pathlib.Path) -> str:
    with tempfile.NamedTemporaryFile(delete=False) as tmp:
        tmp_path = pathlib.Path(tmp.name)
    try:
        subprocess.run(["cp", str(path), str(tmp_path)], check=True)
        subprocess.run(["codesign", "--remove-signature", str(tmp_path)], capture_output=True)
        return sha256(tmp_path)
    finally:
        tmp_path.unlink(missing_ok=True)


def verify_signature(path: pathlib.Path) -> bool:
    return subprocess.run(
        ["codesign", "--verify", "--strict", str(path)], capture_output=True
    ).returncode == 0


def info(path: pathlib.Path) -> dict:
    out = subprocess.run(["codesign", "-d", "--verbose=4", str(path)], capture_output=True, text=True).stderr
    fields = {}
    for line in out.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            if key in {"Identifier", "CDHash", "TeamIdentifier"}:
                fields[key] = value
    return fields


def status() -> dict:
    config = json.load(open(HOME / ".cu/config.json"))
    import urllib.request

    request = urllib.request.Request(
        f"http://127.0.0.1:{config.get('port', 47777)}/v1/status",
        headers={"Authorization": "Bearer " + config.get("token", "")},
    )
    return json.load(urllib.request.urlopen(request, timeout=5))


def main() -> int:
    failures = []
    for path in (APP, APP_BIN, SERVICE, PREVIEW):
        if not path.exists():
            failures.append(f"missing: {path}")
    if failures:
        print(json.dumps({"ok": False, "failures": failures}, indent=2))
        return 1

    hashes = {"app": sha256(APP_BIN), "service": sha256(SERVICE), "preview": sha256(PREVIEW)}
    unsigned = {
        "app": unsigned_sha256(APP_BIN),
        "service": unsigned_sha256(SERVICE),
        "preview": unsigned_sha256(PREVIEW),
    }
    signatures = {
        "app": verify_signature(APP),
        "service": verify_signature(SERVICE),
        "preview": verify_signature(PREVIEW),
    }
    same_build = len(set(unsigned.values())) == 1
    copies_match = SERVICE.read_bytes() == PREVIEW.read_bytes()
    live = status()
    build_matches = live.get("buildId") == hashes["service"]
    permissions = bool(live.get("accessibility")) and bool(live.get("screenRecording"))
    helpers = subprocess.run(
        ["pgrep", "-f", "cu-preview preview-stream"], capture_output=True, text=True
    ).stdout.strip()

    payload = {
        "ok": same_build and copies_match and all(signatures.values()) and build_matches and permissions,
        "hashes": hashes,
        "unsignedPayload": unsigned,
        "signatures": signatures,
        "identifier": {k: info(v).get("Identifier") for k, v in
                       {"app": APP, "service": SERVICE, "preview": PREVIEW}.items()},
        "cdhash": {k: info(v).get("CDHash") for k, v in
                   {"app": APP, "service": SERVICE, "preview": PREVIEW}.items()},
        "sameUnsignedBuild": same_build,
        "serviceEqualsPreview": copies_match,
        "runningBuildId": live.get("buildId"),
        "buildIdMatchesService": build_matches,
        "permissions": {
            "accessibility": live.get("accessibility"),
            "screenRecording": live.get("screenRecording"),
        },
        "leftoverPreviewHelpers": len(helpers.splitlines()) if helpers else 0,
    }
    print(json.dumps(payload, indent=2))
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
