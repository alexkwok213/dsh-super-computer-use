#!/usr/bin/env python3
"""Unit tests for the one-call import flow (mcp/server.py's ImportFlow).

A fake file panel reproduces the 剪映 semantics we observed on 2026-10-30:
the go-to sheet prefills the field, clicking 关闭 clears it, Return confirms a
path, 导入 imports the confirmed file, and the media library shows an item only
after the import. No UI is touched.

    python3 tests/import_flow_units.py
"""
from __future__ import annotations

import os
import pathlib
import sys
import tempfile
from urllib.parse import quote

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


def encoded(path: str) -> str:
    return quote(os.path.basename(path), safe="")


class FakeClock:
    def __init__(self) -> None:
        self.t = 0.0

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.t += max(0.0, seconds)


class FakePanel:
    """A tiny model of the open panel, the go-to sheet and the media library."""

    def __init__(self, field_value: str = "", close_failures: int = 0,
                 confirm_works: bool = True, import_adds: bool = True,
                 progress_ticks: int = 0):
        self.panel_open = False
        self.goto_open = False
        self.field_value = field_value
        self.remembered = field_value
        self.close_failures = close_failures
        self.confirm_works = confirm_works
        self.import_adds = import_adds
        self.progress_ticks = progress_ticks
        self.progress_left = 0
        self.pending: str | None = None
        self.confirmed = None
        self.items: list[str] = []
        self.keys: list[tuple[str, str]] = []
        self.typed: list[str] = []
        self.import_clicks = 0
        self.wrong_import_clicks = 0
        self.field_clicks = 0

    # -- engine verbs -------------------------------------------------------

    def snapshot(self, pid: int, window_id=None) -> dict:
        return {"ok": True, "nodes": self._nodes()}

    def ax(self, pid: int, query: str, window_id=None) -> dict:
        # Progress advances on library queries, not on the progress query that
        # merely observes it: the dialog must stay visible while we look at it.
        if self.progress_left > 0 and "导入素材" not in query:
            self.progress_left -= 1
            if self.progress_left == 0 and self.pending is not None:
                # Like the real import job: the item lands when progress ends.
                self.items.append(self.pending)
                self.pending = None
        rows = self._nodes()
        needle = query.lower()
        matches = [row for row in rows
                   if needle in f"{row.get('title', '')} {row.get('value', '')}".lower()]
        matches.sort(key=lambda row: row.get("w", 0) * row.get("h", 0), reverse=True)
        return {"ok": True, "pid": pid, "matches": matches[:25]}

    def key(self, name: str, mods: str = "", pid=None, window_id=None) -> dict:
        self.keys.append((name, mods))
        if name == "i" and mods == "cmd":
            if not self.panel_open:
                self.panel_open = True
                self.goto_open = False
                self.confirmed = None
                self.field_value = self.remembered
        elif name == "g" and mods == "cmd,shift":
            if self.panel_open:
                self.goto_open = True
                self.field_value = self.remembered
        elif name == "return":
            if self.goto_open and self.confirm_works and os.path.isfile(self.field_value):
                self.confirmed = self.field_value
                self.remembered = self.field_value
                self.goto_open = False
        elif name == "escape":
            if self.goto_open:
                self.goto_open = False
            else:
                self.panel_open = False
        return {"ok": True}

    def click(self, x: float, y: float, window_id=None) -> dict:
        node = self._hit(x, y)
        if node is None:
            return {"ok": True, "landed": False}
        if node.get("role") == "AXButton" and node.get("title") == "关闭":
            if self.close_failures > 0:
                self.close_failures -= 1
            else:
                self.field_value = ""
        elif node.get("role") == "AXButton" and node.get("title") == "导入":
            if node.get("panelButton"):
                self.import_clicks += 1
                if self.confirmed and self.import_adds:
                    item = encoded(self.confirmed)
                    self.panel_open = False
                    self.confirmed = None
                    self.remembered = ""
                    if self.progress_ticks > 0:
                        self.pending = item
                        self.progress_left = self.progress_ticks
                    else:
                        self.items.append(item)
            else:
                self.wrong_import_clicks += 1
        elif node.get("role") == "AXTextField":
            self.field_clicks += 1
        return {"ok": True, "landed": True}

    def type(self, text: str, pid: int) -> dict:
        self.typed.append(text)
        if self.goto_open:
            # AXSetValue appends to whatever the prefilled field held; the flow
            # must clear it first, as the real panel does after 关闭.
            self.field_value += text
            self.remembered = self.field_value
            return {"ok": True, "landed": True}
        return {"ok": True, "landed": False}

    # -- layout -------------------------------------------------------------

    def _nodes(self) -> list[dict]:
        rows: list[dict] = []
        if self.panel_open:
            rows.append({"role": "AXStaticText", "title": "请选择媒体资源",
                         "x": 900, "y": 300, "w": 200, "h": 20, "cx": 1000, "cy": 310})
            rows.append({"role": "AXButton", "title": "导入", "enabled": True,
                         "x": 300, "y": 140, "w": 80, "h": 28, "cx": 340, "cy": 154})
            rows.append({"role": "AXButton", "title": "导入", "enabled": bool(self.confirmed),
                         "panelButton": True,
                         "x": 1180, "y": 710, "w": 86, "h": 30, "cx": 1223, "cy": 725})
            if self.goto_open:
                rows.append({"role": "AXStaticText", "title": "前往文件夹",
                             "x": 660, "y": 330, "w": 120, "h": 20, "cx": 720, "cy": 340})
                rows.append({"role": "AXButton", "title": "关闭", "enabled": True,
                             "x": 1030, "y": 364, "w": 38, "h": 28, "cx": 1049, "cy": 378})
                rows.append({"role": "AXTextField", "title": "", "value": self.field_value,
                             "enabled": True,
                             "x": 643, "y": 364, "w": 400, "h": 28, "cx": 843, "cy": 378})
        for index, item in enumerate(self.items):
            rows.append({"role": "AXButton",
                         "title": f"material.library.item.{index:04x}.{item}.apply",
                         "enabled": True,
                         "x": 200 + index * 10, "y": 500, "w": 120, "h": 90,
                         "cx": 260 + index * 10, "cy": 545})
        if self.progress_left > 0:
            rows.append({"role": "AXWindow", "title": "导入素材 0/1",
                         "x": 643, "y": 462, "w": 400, "h": 143,
                         "cx": 843, "cy": 533})
        return rows

    def _hit(self, x: float, y: float) -> dict | None:
        for node in self._nodes():
            if abs(node["cx"] - x) <= 2 and abs(node["cy"] - y) <= 2:
                return node
        return None


def make_flow(panel: FakePanel) -> server.ImportFlow:
    clock = FakeClock()
    return server.ImportFlow(panel, sleep=clock.sleep, clock=clock.now,
                             item_timeout=12.0, panel_timeout=3.0,
                             goto_timeout=4.0, settle=0.15, poll=0.3)


def make_files(count: int) -> tuple[tempfile.TemporaryDirectory, list[str]]:
    directory = tempfile.TemporaryDirectory(prefix="cu-import-flow-")
    files = []
    names = ["01_微信发送.mp4", "02_电脑指令.mp4", "03_搜索联系人.mp4"]
    for index in range(count):
        path = os.path.join(directory.name, names[index])
        pathlib.Path(path).write_bytes(b"\0")
        files.append(path)
    return directory, files


def main() -> int:
    print("== happy path ==")
    tmp, files = make_files(2)
    panel = FakePanel()
    flow = make_flow(panel)
    result = flow.run(101, 5501, files)
    check("both files reported imported", result["imported"] == files, str(result))
    check("media library holds both items", panel.items == [encoded(p) for p in files],
          str(panel.items))
    check("导入 clicked once per file", panel.import_clicks == 2, str(panel.import_clicks))
    check("main-window 导入 never clicked", panel.wrong_import_clicks == 0,
          str(panel.wrong_import_clicks))
    check("each path typed exactly once", panel.typed == files, str(panel.typed))
    check("panel is closed at the end", not panel.panel_open)
    tmp.cleanup()

    print("== stale prefilled field ==")
    tmp, files = make_files(1)
    stale = "/tmp/old/take.mp4"
    panel = FakePanel(field_value=stale)
    flow = make_flow(panel)
    result = flow.run(101, 5501, files)
    check("import succeeds with a prefilled field", result["imported"] == files, str(result))
    check("nothing was appended to the stale path", panel.typed == files, str(panel.typed))
    tmp.cleanup()

    print("== close click fails once ==")
    tmp, files = make_files(1)
    panel = FakePanel(field_value=stale, close_failures=1)
    flow = make_flow(panel)
    result = flow.run(101, 5501, files)
    check("retry clears the field and imports", result["imported"] == files, str(result))
    check("still one import click", panel.import_clicks == 1, str(panel.import_clicks))
    tmp.cleanup()

    print("== close click never lands ==")
    tmp, files = make_files(1)
    panel = FakePanel(field_value=stale, close_failures=99)
    flow = make_flow(panel)
    try:
        flow.run(101, 5501, files)
        error = None
    except server.ImportFlowError as caught:
        error = caught
    check("fails instead of reporting ok", error is not None)
    check("failure names the field stage",
          error is not None and error.stage in ("goto_type", "goto_clear"),
          error.stage if error else "")
    check("nothing imported", panel.import_clicks == 0, str(panel.import_clicks))
    check("panel closed after failure", not panel.panel_open)
    tmp.cleanup()

    print("== duplicate detection ==")
    tmp, files = make_files(1)
    panel = FakePanel()
    panel.items.append(encoded(files[0]))
    flow = make_flow(panel)
    result = flow.run(101, 5501, files)
    check("existing item is skipped", result["skipped"] == files, str(result))
    check("no panel action for a skipped file", panel.keys == [], str(panel.keys))
    tmp.cleanup()

    print("== Return never confirms ==")
    tmp, files = make_files(1)
    panel = FakePanel(confirm_works=False)
    flow = make_flow(panel)
    try:
        flow.run(101, 5501, files)
        error = None
    except server.ImportFlowError as caught:
        error = caught
    check("disabled 导入 aborts before clicking it",
          error is not None and error.stage == "goto_confirm", error.stage if error else "")
    check("no import click", panel.import_clicks == 0, str(panel.import_clicks))
    check("panel closed after failure", not panel.panel_open)
    tmp.cleanup()

    print("== import click does nothing ==")
    tmp, files = make_files(1)
    panel = FakePanel(import_adds=False, progress_ticks=2)
    flow = make_flow(panel)
    try:
        flow.run(101, 5501, files)
        error = None
    except server.ImportFlowError as caught:
        error = caught
    check("verification fails", error is not None and error.stage == "import_verify",
          error.stage if error else "")
    check("exactly one submit, never repeated", panel.import_clicks == 1,
          str(panel.import_clicks))
    check("progress dialog absence is reported", error is not None
          and error.details.get("progressVisible") is False,
          str(error.details if error else ""))
    tmp.cleanup()

    print("== progress dialog is observed ==")
    tmp, files = make_files(1)
    panel = FakePanel(progress_ticks=2)
    flow = make_flow(panel)
    result = flow.run(101, 5501, files)
    check("import still succeeds", result["imported"] == files, str(result))
    check("step records the progress window",
          result["steps"][0].get("progressSeen") is True, str(result["steps"]))
    tmp.cleanup()

    print("== dry run ==")
    tmp, files = make_files(1)
    panel = FakePanel()
    flow = make_flow(panel)
    result = flow.run(101, 5501, files, dry_run=True)
    check("nothing imported in a dry run", panel.items == [], str(panel.items))
    check("selection verified", result.get("selected") == files[0], str(result))
    check("no import click", panel.import_clicks == 0, str(panel.import_clicks))
    check("panel closed after the dry run", result.get("panelClosed") is True and
          not panel.panel_open, str(result))
    tmp.cleanup()

    print("== input validation ==")
    tmp, files = make_files(1)
    panel = FakePanel()
    flow = make_flow(panel)
    try:
        flow.run(101, 5501, [tmp.name])
        error = None
    except server.ImportFlowError as caught:
        error = caught
    check("directory rejected", error is not None and error.stage == "input",
          error.stage if error else "")
    check("no UI action for bad input", panel.keys == [], str(panel.keys))
    try:
        flow.run(101, 5501, [os.path.join(tmp.name, "missing.mp4")])
        missing = None
    except server.ImportFlowError as caught:
        missing = caught
    check("missing file rejected", missing is not None and missing.stage == "input")
    tmp.cleanup()

    print("== runner argv mapping ==")
    calls = []

    def recording(*argv):
        calls.append(argv)
        return {"ok": True, "matches": []}

    runner = server.ImportRunner(recording)
    runner.ax(7, "query", 42)
    runner.key("i", "cmd", pid=7, window_id=42)
    runner.click(10, 20, window_id=42)
    runner.type("/tmp/x.mp4", 7)
    check("ax passes pid, find and window", calls[0] ==
          ("ax", "--pid", "7", "--find", "query", "--window", "42"), str(calls[0]))
    check("key targets the window", calls[1] ==
          ("key", "--name", "i", "--mods", "cmd", "--window", "42"), str(calls[1]))
    check("click passes coordinates, window and phantom", calls[2] ==
          ("click", "--x", "10", "--y", "20", "--window", "42", "--phantom"), str(calls[2]))
    check("type is an AX write in the background", calls[3] ==
          ("type", "--text", "/tmp/x.mp4", "--pid", "7", "--background"), str(calls[3]))

    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
