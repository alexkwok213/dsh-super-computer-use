#!/usr/bin/env python3
"""Exercise this round's changes through the MCP layer (the path agents use):

  * screenshot region crop + JPEG
  * ref clicks resolving through the index path instead of a full tree walk
  * window-list caching

Read-only: clicks run as dry runs.

    python3 tests/smoke_new.py
"""
from __future__ import annotations

import base64
import json
import pathlib
import re
import statistics
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "mcp"))
sys.dont_write_bytecode = True
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


def call(tool: str, **arguments) -> tuple[float, dict]:
    started = time.perf_counter()
    result = server.call_tool(tool, arguments)
    return (time.perf_counter() - started) * 1000, result


def text_of(result: dict) -> str:
    return " ".join(part.get("text", "") for part in result.get("content", [])
                    if part.get("type") == "text")


def image_of(result: dict) -> tuple[bytes, dict]:
    """Accepts both shapes: MCP content blocks, or the service's raw engine JSON
    (base64 at the top level)."""
    content = result.get("content") or []
    raw = next((base64.b64decode(part["data"]) for part in content
                if part.get("type") == "image" and part.get("data")), b"")
    meta_text = next((part["text"] for part in content
                      if part.get("type") == "text"), "")
    if not raw and result.get("base64"):
        raw = base64.b64decode(result["base64"])
    try:
        meta = json.loads(meta_text) if meta_text else {
            key: result.get(key) for key in ("mimeType", "origin", "size", "scale")}
    except Exception:
        meta = {"mimeType": result.get("mimeType")}
    return raw, meta


def service_call(tool: str, **arguments) -> tuple[float, dict]:
    """Hit the engine service directly.

    Screenshots through the MCP layer run in the caller's process, and on this
    machine only the service identity holds Screen Recording; going through
    /v1/call exercises the same engine code with the grant it needs."""
    config = json.loads((pathlib.Path.home() / ".cu" / "config.json").read_text())
    base = f"http://127.0.0.1:{config['port']}"
    body = json.dumps({"tool": tool, "arguments": arguments}).encode()
    request = urllib.request.Request(
        base + "/v1/call", data=body, method="POST",
        headers={"Authorization": f"Bearer {config['token']}",
                 "Content-Type": "application/json"})
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = json.loads(response.read())
    return (time.perf_counter() - started) * 1000, payload


def main() -> int:
    print("== list_windows cache ==")
    first, listing = call("list_windows")
    second, _ = call("list_windows")
    windows = json.loads(text_of(listing)).get("windows") or []
    check("two listings back to back", len(windows) > 0, text_of(listing)[:120])
    print(f"  {first:.0f}ms then {second:.0f}ms "
          f"({'cached' if second < first * 0.8 else 'no clear win'})")
    target = next((w for w in windows if w.get("title") and w.get("app")
                   and w["bounds"]["width"] > 200 and "Computer Use" not in w["app"]), None)
    if not target:
        print("  no usable window — open an app and rerun")
        print("  windows:", json.dumps(windows[:6], ensure_ascii=False)[:600])
        _, health = call("selfcheck")
        print("  selfcheck:", text_of(health)[:400])
        return 2
    bounds, window_id, pid = target["bounds"], target["windowId"], target["pid"]
    print(f"  target: {target['app']} · {target.get('title', '')[:40]} "
          f"(pid {pid}, window {window_id})")

    print("== screenshot: full vs region vs jpeg ==")
    full_ms, full = service_call("screenshot", windowId=window_id)
    full_raw, full_meta = image_of(full)
    check("full shot returns an image", len(full_raw) > 1000, json.dumps(full)[:140])
    region = {"x": bounds["x"] + bounds["width"] * 0.1,
              "y": bounds["y"] + bounds["height"] * 0.1,
              "width": bounds["width"] * 0.35, "height": bounds["height"] * 0.3}
    crop_ms, cropped = service_call("screenshot", windowId=window_id, region=region)
    crop_raw, crop_meta = image_of(cropped)
    check("region returns an image", len(crop_raw) > 500, json.dumps(cropped)[:160])
    check("region is smaller on the wire", crop_raw and len(crop_raw) < len(full_raw),
          f"{len(crop_raw)} vs {len(full_raw)}")
    check("region origin moved",
          abs((crop_meta.get("origin") or {}).get("x", 0)
              - (full_meta.get("origin") or {}).get("x", 0)) > 1,
          f"{crop_meta.get('origin')} vs {full_meta.get('origin')}")
    check("region size shrank",
          (crop_meta.get("size") or {}).get("width", 1e9)
          < (full_meta.get("size") or {}).get("width", 0), str(crop_meta.get("size")))
    print(f"  full {len(full_raw)}B/{full_ms:.0f}ms → region "
          f"{len(crop_raw)}B/{crop_ms:.0f}ms ({len(crop_raw) / max(len(full_raw), 1) * 100:.0f}%)")

    jpeg_ms, jpeg = service_call("screenshot", windowId=window_id, format="jpeg", quality=0.8)
    jpeg_raw, jpeg_meta = image_of(jpeg)
    check("jpeg asks for image/jpeg", jpeg_raw[:2] == b"\xff\xd8"
          or jpeg_meta.get("mimeType") == "image/jpeg", str(jpeg_meta))
    check("jpeg is smaller than png", jpeg_raw and len(jpeg_raw) < len(full_raw),
          f"{len(jpeg_raw)} vs {len(full_raw)}")
    print(f"  png {len(full_raw)}B → jpeg {len(jpeg_raw)}B/{jpeg_ms:.0f}ms")

    print("== ref click resolves by path ==")
    snap_ms, snap_result = call("snapshot", pid=pid, windowId=window_id, full=True)
    refs = []
    for candidate in re.findall(r"\b(k\d+(?:\.\d+)+)\b", text_of(snap_result)):
        if candidate not in refs:
            refs.append(candidate)
    check("snapshot has refs", bool(refs), text_of(snap_result)[:160])
    resolved, failures = [], []
    for ref in refs[:6]:
        elapsed, dry = call("click", ref=ref, pid=pid, windowId=window_id, dryRun=True)
        body = json.loads(text_of(dry) or "{}")
        if body.get("ok") and body.get("dryRun") is True:
            resolved.append((ref, elapsed, body.get("resolved")))
        else:
            failures.append((ref, body.get("error") or body.get("message"), elapsed))
    check("dry-run clicks succeed", len(resolved) >= max(1, min(4, len(refs[:6]))),
          f"{len(resolved)} ok, failures={failures[:2]}")
    by_path = [item for item in resolved if item[2] == "path"]
    check("most refs resolve without a full walk", len(by_path) >= len(resolved) * 0.6,
          str([(ref, how) for ref, _, how in resolved]))
    if resolved:
        best = statistics.median([elapsed for _, elapsed, _ in by_path or resolved])
        check("ref click beats a full snapshot walk", best < snap_ms,
              f"click {best:.0f}ms vs snapshot {snap_ms:.0f}ms")
        print(f"  {len(by_path)}/{len(resolved)} by index path, "
              f"median {best:.0f}ms; full snapshot {snap_ms:.0f}ms")
        for ref, elapsed, how in resolved:
            print(f"    {ref:<14}{how:<12}{elapsed:.0f}ms")
        for ref, error, elapsed in failures[:3]:
            print(f"    {ref:<14}{error:<12}{elapsed:.0f}ms")

    print()
    print(f"{passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
