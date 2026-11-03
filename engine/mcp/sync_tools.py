#!/usr/bin/env python3
"""Regenerate mcp/tools.json from the TOOLS table in server.py.

The engine's console (`cu tools`, the menu bar app) reads tools.json while the
MCP server answers from TOOLS; keeping two hand-written copies is how the
screenshot schema ended up promising 1280 in one place and 1600 in the other.
Run this after editing TOOLS:

    python3 mcp/sync_tools.py
"""
from __future__ import annotations

import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.dont_write_bytecode = True

import server  # noqa: E402

TARGET = HERE / "tools.json"


def main() -> int:
    payload = server.TOOLS
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    old = TARGET.read_text() if TARGET.exists() else ""
    if old == text:
        print(f"{TARGET} already up to date ({len(payload)} tools)")
        return 0
    TARGET.write_text(text)
    print(f"wrote {TARGET} ({len(payload)} tools)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
