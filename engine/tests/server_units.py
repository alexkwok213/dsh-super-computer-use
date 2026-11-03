#!/usr/bin/env python3
"""Unit tests for the MCP server's pure logic: diff rendering, ref resolution,
and the full-tree fallback. No UI is touched.

    python3 tests/server_units.py
"""
from __future__ import annotations

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "mcp"))
import server  # noqa: E402

passed = failed = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {detail}")


def node(ref: str, role: str, title: str = "", value: str = "", **extra) -> dict:
    row = {"ref": ref, "role": role, "enabled": True}
    if title:
        row["title"] = title
    if value:
        row["value"] = value
    row.update(extra)
    return row


def snapshot(pid: int, nodes: list[dict]) -> dict:
    return {"ok": True, "pid": pid, "app": "Test", "version": 1,
            "count": len(nodes), "nodes": nodes}


def main() -> int:
    base = snapshot(1, [node("k0", "AXWindow", "Doc"), node("k0.0", "AXTextArea", value="a")])

    print("== diff: no change ==")
    text, full = server.render_diff(base, snapshot(1, base["nodes"]))
    check("unchanged tree reports no change", "no change" in text and not full, text[:80])

    print("== diff: value change ==")
    changed = [node("k0", "AXWindow", "Doc"), node("k0.0", "AXTextArea", value="ab")]
    text, full = server.render_diff(base, snapshot(1, changed))
    check("value change is reported", "changed k0.0" in text and "'a' → 'ab'" in text, text[:120])

    print("== diff: added and removed ==")
    grown = [node("k0", "AXWindow", "Doc"), node("k0.1", "AXButton", "OK")]
    text, full = server.render_diff(base, snapshot(1, grown))
    check("removal listed", "removed k0.0" in text, text[:160])
    check("addition listed", "added   k0.1" in text or "added k0.1" in text, text[:160])

    print("== diff: churn falls back to the full tree ==")
    many = [node(f"k{i}", "AXButton", f"B{i}") for i in range(200)]
    text, full = server.render_diff(base, snapshot(1, many))
    check("large churn asks for a full tree", full is True, text[:80])

    print("== snapshot rendering ==")
    snap = snapshot(7, [node("k0", "AXWindow", "Doc"),
                        node("k0.0", "AXTextField", "Search", value="hello", focused=True),
                        node("k0.1", "AXButton", "Go", w=40, h=20, x=10, y=10, actions=["AXPress"])])
    rendered = server.render_snapshot(snap)
    check("inputs are listed first", rendered.splitlines()[1].startswith("input: k0.0"), rendered[:120])
    check("focused flag is shown", "[focused]" in rendered, rendered[:160])
    check("frame and actions survive", "@(10,10) 40x20 [AXPress]" in rendered, rendered[:200])

    print("== ref resolution ==")
    server.SNAPSHOTS[(7, None)] = snap
    ctx = server.ref_context("k0.1", pid=7)
    check("known ref resolves to pid/role/title/scope",
          ctx == (7, "AXButton", "Go", None), str(ctx))
    ctx = server.ref_context("k9.9")
    check("unknown ref is rejected", isinstance(ctx, dict) and ctx["error"] == "stale_ref", str(ctx))
    ctx = server.ref_context("k0")
    check("missing ref falls back to the latest snapshot",
          ctx == (7, "AXWindow", "Doc", None), str(ctx))

    print("== tool schema consistency ==")
    schemas = json.loads((ROOT / "mcp" / "tools.json").read_text(encoding="utf-8"))
    check("proxy and bundled tool schemas agree", schemas == server.TOOLS)
    check("proxy schema hash is reproducible", server.SCHEMA_HASH == server.schema_hash(schemas))

    print("== screenshot sizing ==")
    from unittest.mock import patch
    with patch.object(server, "run_cu", return_value={"ok": False}) as run, \
         patch.object(server, "_config_number", return_value=1600):
        server.call_tool("screenshot", {"screen": True, "maxDimension": 0})
        check("explicit zero keeps full resolution", "0" == run.call_args.args[3])
        server.call_tool("screenshot", {"screen": True})
        check("omitted limit uses config default", "1600" == run.call_args.args[3])

    print("== window scope and batch observation ==")
    server.SNAPSHOTS.clear()
    first = snapshot(7, [node("k0.1", "AXButton", "old")])
    first["windowId"] = 10
    server.store_snapshot(7, 10, first)
    second = snapshot(7, [node("k0.2", "AXButton", "new")])
    second["windowId"] = 20
    server.store_snapshot(7, 20, second)
    check("missing scoped snapshot does not fall back", server.snapshot_for(7, 30) is None)
    stale = server.ref_context("k0.1", 7)
    check("ref absent in latest snapshot is rejected", isinstance(stale, dict) and stale.get("error") == "stale_ref", str(stale))
    check("latest scoped ref keeps its window", server.ref_context("k0.2", 7) == (7, "AXButton", "new", 20))

    from unittest.mock import patch
    action = {"content": [{"type": "text", "text": json.dumps({"ok": True, "pid": 7})}]}
    malformed = server.observe_after({"observe": True}, {"content": [{"type": "text", "text": "not json"}]})
    check("malformed action result is unknown", malformed.get("isError") and "observation_unavailable" in malformed["content"][0]["text"])
    with patch.object(server, "run_cu", return_value={"ok": False, "error": "capture_failed"}), \
         patch.object(server.time, "sleep") as sleep:
        observed = server.observe_after({"observe": True, "observeMs": 0}, action)
        payload = json.loads(observed["content"][0]["text"])
        check("zero observe delay is preserved", sleep.call_args.args == (0.0,))
        check("failed observation is reported", observed.get("isError") and payload["observationError"]["error"] == "capture_failed")
    with patch.object(server, "run_cu", return_value=second) as run, patch.object(server.time, "sleep"):
        server.observe_after({"ref": "k0.2", "observe": True, "observeMs": 0}, action)
        check("ref observation keeps window scope", "--window" in run.call_args.args and "20" in run.call_args.args)
    with patch.object(server, "run_cu", return_value={"ok": True, "pid": 7}), \
         patch.object(server, "observe_after", return_value={"content": [{"type": "text", "text": "observation failed"}], "isError": True}) as observe, \
         patch.object(server, "auto_halo"), patch.object(server, "set_activity"):
        result = server.call_tool("batch", {"steps": [{"tool": "press_key", "arguments": {"name": "a", "pid": 7, "observe": True}},
                                                     {"tool": "press_key", "arguments": {"name": "b", "pid": 7}}]})
        check("batch applies observe and stops on failure", observe.call_count == 1 and result.get("isError") and "2. " not in result["content"][0]["text"])

    with patch.object(server, "run_cu", return_value={"ok": True}) as run, \
         patch.object(server, "auto_halo"), patch.object(server, "set_activity"):
        server.call_tool("set_value", {"pid": 7, "ref": "k0.2", "text": "value"})
        check("set_value preserves snapshot window", "--window" in run.call_args.args and "20" in run.call_args.args)
        server.call_tool("perform_action", {"pid": 7, "ref": "k0.2", "name": "AXPress"})
        check("perform_action preserves snapshot window", "--window" in run.call_args.args and "20" in run.call_args.args)
        server.call_tool("select_text", {"pid": 7, "ref": "k0.2", "text": "value"})
        check("select_text preserves snapshot window", "--window" in run.call_args.args and "20" in run.call_args.args)

    from contextlib import contextmanager
    @contextmanager
    def failed_service(*args, **kwargs):
        class Response:
            def read(self):
                return b'{"ok": false, "error": "capture_failed"}'
        yield Response()
    with patch.object(server, "discover_service"), \
         patch.object(server.urllib.request, "urlopen", failed_service), \
         patch.object(server.subprocess, "run") as local:
        server.SERVICE.update(base="http://127.0.0.1:1", token="test")
        result = server.run_cu("shot", "--out", "/tmp/output")
        check("failed service capture is not replayed locally", result.get("error") == "capture_failed" and not local.called)
        server.SERVICE.update(base=None, token=None)

    with patch.object(server, "discover_service"), \
         patch.object(server.urllib.request, "urlopen", side_effect=TimeoutError), \
         patch.object(server.subprocess, "run") as local:
        server.SERVICE.update(base="http://127.0.0.1:1", token="test")
        result = server.run_cu("click")
        check("service timeout never repeats action locally", result.get("error") == "service_result_unknown" and not local.called)
        server.SERVICE.update(base=None, token=None)

    print(f"\n{passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
