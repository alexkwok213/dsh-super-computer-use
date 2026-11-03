#!/usr/bin/env python3
"""MCP stdio server for the standalone computer-use engine.

It is a thin, dependency-free wrapper: every tool shells out to the `cu` binary
next to this file and returns its JSON. Any MCP client can use it; nothing here
depends on another application.

    python3 mcp/server.py            # speak MCP on stdin/stdout
    CU_BIN=/path/to/cu python3 mcp/server.py

Tools: list_windows, screenshot, ax_find, click, type_text, press_key, scroll,
drag, highlight_window.
"""
from __future__ import annotations

import atexit
import hashlib
import json
import marshal
import types
import os
import pathlib
import subprocess
import sys
import time
import struct
import threading
import urllib.request
from urllib.parse import quote

ROOT = pathlib.Path(__file__).resolve().parent.parent
SERVICE_CONFIG = pathlib.Path(os.path.expanduser("~/.cu/config.json"))
SERVICE: dict = {"base": None, "token": None, "checked": 0.0}


def discover_service(force: bool = False) -> None:
    """Prefer the local service: it holds the macOS permissions, so clients do not."""
    import time as _time
    if SERVICE["base"] and not force:
        return
    # A miss is retried quickly. The service is restarted by every install and by
    # the menu-bar toggle, and right after a restart it can report its
    # permissions a beat too early; caching that miss for 30 s pushed a whole
    # first run onto the unprivileged local path (empty window titles, no AX).
    # Probing a closed localhost port is instant, so a retry costs nothing.
    if not force and _time.time() - SERVICE["checked"] < (30 if SERVICE["base"] else 1):
        return
    SERVICE["checked"] = _time.time()
    try:
        config = json.loads(SERVICE_CONFIG.read_text())
        port, token = int(config["port"]), config["token"]
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/v1/status", timeout=0.6) as response:
            payload = json.loads(response.read())
        # Only route through the service once it actually holds a permission;
        # otherwise every call would fail while the old path still works. Either
        # grant is enough to commit: a service that has one is still the right
        # engine, and a cold restart may simply not have answered both yet.
        if payload.get("ok") and (payload.get("accessibility") or payload.get("screenRecording")):
            SERVICE["base"] = f"http://127.0.0.1:{port}"
            SERVICE["token"] = token
            return
        SERVICE["base"] = None
        SERVICE["token"] = None
    except Exception:
        SERVICE["base"] = None
        SERVICE["token"] = None
CU = pathlib.Path(os.environ.get("CU_BIN", ROOT / "bin" / "cu"))
PROTOCOL = "2025-06-18"

# Refs (e1, e2, …) only mean something against the tree they came from, so the
# latest snapshot per (pid, windowId) is kept here and every ref action is
# validated against the role/title recorded at snapshot time. Keying by pid alone
# let a ref taken in one window resolve inside another window of the same app.
ACTIVITY = pathlib.Path(os.path.expanduser("~/.cu/activity.json"))
ACTIVITY_LABELS = {
    "click": "正在点击", "double_click": "正在单击", "type_text": "正在输入",
    "press_key": "正在按键", "scroll": "正在滚动", "drag": "正在拖动",
    "menu": "正在操作菜单", "set_value": "正在填写", "select_text": "正在选择文字",
    "paste_text": "正在粘贴", "screenshot": "正在截图", "snapshot": "正在查看界面",
    "ax_find": "正在查找控件", "ocr_find": "正在识别文字", "activate_window": "正在切换窗口",
    "launch_app": "正在启动应用", "zoom_window": "正在缩放窗口",
    "bring_on_stage": "正在切换桌面", "highlight_window": "正在标注窗口",
    "import_media": "正在导入素材",
}
SNAPSHOTS: dict[tuple[int, int | None], dict] = {}
SNAPSHOT_SEQ = 0
BATCHING = [False]
WINDOWS_CACHE: dict = {"at": 0.0, "data": None}


def windows_listing(max_age: float = 1.0) -> dict:
    """Window enumeration is a CGWindowList sweep (~50–100 ms) and several tools
    needed it within the same call. Cache it briefly so a click does not pay for
    it twice."""
    now = time.time()
    if WINDOWS_CACHE["data"] is not None and now - WINDOWS_CACHE["at"] < max_age:
        return WINDOWS_CACHE["data"]
    listing = run_cu("windows")
    if listing.get("ok"):
        WINDOWS_CACHE["data"] = listing
        WINDOWS_CACHE["at"] = now
    return listing


def snapshot_for(pid: int, window_id: int | None = None) -> dict | None:
    """The newest snapshot for that app, preferring the requested window scope.

    Refs mean "this element in the tree I last showed you", so the *newest*
    snapshot wins — a newer window-scoped walk must not lose to an older
    app-wide one, which is how refs that were plainly on screen kept coming
    back as stale."""
    candidates = [(key, snap) for key, snap in SNAPSHOTS.items()
                  if key[0] == pid and (window_id is None or key[1] == window_id)]
    if not candidates:
        return None
    return max(candidates, key=lambda item: item[1].get("_seq", 0))[1]


def store_snapshot(pid: int, window_id: int | None, snapshot: dict) -> None:
    global SNAPSHOT_SEQ
    SNAPSHOT_SEQ += 1
    snapshot["_seq"] = SNAPSHOT_SEQ
    SNAPSHOTS[(int(pid), window_id)] = snapshot

CLIENTS_DIR = pathlib.Path(os.path.expanduser("~/.cu/clients"))
CLIENT: dict = {"mcpPid": os.getpid(), "client": "", "clientPid": 0, "appPath": "",
                "startedAt": time.time(), "lastSeen": 0.0, "calls": 0, "lastTool": "",
                "lastMs": 0, "totalMs": 0, "tools": {}, "via": ""}


def detect_host() -> tuple[str, int, str]:
    """Which .app spawned this stdio server — found by walking the ppid chain.

    The console lists clients by host app, and the only reliable link between a
    running MCP server and the AI client that owns it is its parent process.
    """
    own = os.getpid()
    pid = own
    for _ in range(10):
        try:
            out = subprocess.run(["ps", "-o", "ppid=,comm=", "-p", str(pid)],
                                 capture_output=True, text=True, timeout=2).stdout.strip()
        except Exception:
            break
        if not out:
            break
        head, _, command = out.partition(" ")
        parent = int(head) if head.isdigit() else 0
        command = command.strip()
        if pid != own:
            match = __import__("re").search(r"(/[^ ]*?/([^/]+)\.app)/Contents/MacOS", command)
            if match:
                return match.group(2), pid, match.group(1)
            if command.endswith(".app/Contents/MacOS") or ".app" in command:
                return os.path.basename(command).split(".")[0], pid, command
        if parent in (0, pid):
            break
        pid = parent
    try:
        out = subprocess.run(["ps", "-o", "comm=", "-p", str(os.getppid())],
                             capture_output=True, text=True, timeout=2).stdout.strip()
        return os.path.basename(out) or "unknown", os.getppid(), out
    except Exception:
        return "unknown", os.getppid(), ""


HOST = detect_host()


def write_client_record() -> None:
    try:
        CLIENTS_DIR.mkdir(parents=True, exist_ok=True)
        path = CLIENTS_DIR / f"{CLIENT['mcpPid']}.json"
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(CLIENT, ensure_ascii=False), encoding="utf-8")
        temporary.replace(path)
    except OSError:
        pass


def announce_client() -> None:
    CLIENT["client"], CLIENT["clientPid"], CLIENT["appPath"] = HOST
    CLIENT["via"] = "service" if SERVICE["base"] else "local"
    CLIENT["lastSeen"] = time.time()
    write_client_record()


def mark_closed() -> None:
    CLIENT["closed"] = True
    CLIENT["lastSeen"] = time.time()
    write_client_record()


def record_call(name: str, ms: float, result: dict) -> None:
    CLIENT["client"], CLIENT["clientPid"], CLIENT["appPath"] = HOST
    CLIENT["via"] = "service" if SERVICE["base"] else "local"
    CLIENT["lastSeen"] = time.time()
    CLIENT["calls"] = int(CLIENT["calls"]) + 1
    CLIENT["lastTool"] = name
    CLIENT["lastMs"] = round(ms * 1000)
    CLIENT["lastOk"] = not result.get("isError", False) and result.get("ok", True) is not False
    if CLIENT["lastOk"]:
        CLIENT["lastSuccessfulCallAt"] = time.time()
    CLIENT["totalMs"] = int(CLIENT.get("totalMs", 0)) + CLIENT["lastMs"]
    entry = CLIENT["tools"].get(name) or {"calls": 0, "ms": 0}
    entry["calls"] = int(entry.get("calls", 0)) + 1
    entry["ms"] = int(entry.get("ms", 0)) + CLIENT["lastMs"]
    CLIENT["tools"][name] = entry
    write_client_record()
SESSIONS: dict[int, list] = {}
AUTO_SESSIONS: dict[int, object] = {}
HALO_FILE = pathlib.Path(os.path.expanduser("~/.cu/halos.json"))
def _config_flag(key: str, default: bool) -> bool:
    try:
        value = json.loads(SERVICE_CONFIG.read_text()).get(key)
        if isinstance(value, bool):
            return value
    except Exception:
        pass
    return default


def _config_number(key: str, default: int) -> int:
    """Screenshot sizing has to come from one place: the schema used to promise
    1280 while the config and README said 1600."""
    try:
        value = json.loads(SERVICE_CONFIG.read_text()).get(key)
        if isinstance(value, int) and value > 0:
            return value
    except Exception:
        pass
    return default


AUTO_HALO = os.environ.get("CU_AUTO_HALO") is not None \
    and os.environ.get("CU_AUTO_HALO") not in ("0", "false", "no") \
    or (os.environ.get("CU_AUTO_HALO") is None and _config_flag("autoHalo", True))

# The indicator the user actually sees while an agent works. "capsule" is the
# floating pill in a screen corner (Claude's shape); "halo" is the old border
# drawn around the target window. CU_CAPSULE=0 or {"capsule": false} in
# ~/.cu/config.json brings the border back.
CAPSULE = (os.environ.get("CU_CAPSULE") or "").lower() not in ("0", "false", "no") \
    if os.environ.get("CU_CAPSULE") is not None else _config_flag("capsule", True)

TOOLS = [
    {
        "name": "list_apps",
        "description": "List running apps with pid, name and bundle id, and which one is frontmost. Use it when you know the app name but not its pid.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "launch_app",
        "description": "Launch (or focus) an app by bundle id or full .app path and return its pid.",
        "inputSchema": {
            "type": "object",
            "properties": {"app": {"type": "string", "description": "e.g. com.apple.TextEdit or /Applications/Notes.app"}},
            "required": ["app"],
        },
    },
    {
        "name": "snapshot",
        "description": "Read an app's accessibility tree. First call returns the full tree with refs (k0.3.2); later calls return only what changed (+added -removed ~changed) so repeated reads stay cheap — unchanged refs stay valid. Pass full: true to force a complete tree (it renumbers everything).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "pid": {"type": "integer", "description": "process id from list_apps or list_windows"},
                "windowId": {"type": "integer", "description": "scope the tree to one window (needed when an app has several similar windows, e.g. Chrome)"},
                "all": {"type": "boolean", "description": "include zero-size nodes (unopened menu items and the like)"},
                "full": {"type": "boolean", "description": "ignore the diff baseline and return the complete tree"},
            },
            "required": ["pid"],
        },
    },
    {
        "name": "select_text",
        "description": "Select text inside an editable element (or place the cursor before/after it) by setting the accessibility selection range. Use prefix/suffix when the same string appears more than once.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "ref": {"type": "string"},
                "text": {"type": "string"},
                "prefix": {"type": "string", "description": "text that must sit right before the match"},
                "suffix": {"type": "string", "description": "text that must sit right after the match"},
                "selection": {"type": "string", "enum": ["text", "cursor_before", "cursor_after"]},
                "pid": {"type": "integer"},
                "observe": {"type": "boolean", "description": "also return what the app's tree looks like right after this action (diff against the last snapshot)"},
                "observeMs": {"type": "integer", "description": "settle time before observing (default 350)"}},
            "required": ["ref", "text"],
        },
    },
    {
        "name": "list_windows",
        "description": "List the windows currently on screen: app name, title, window id, pid and bounds. Start here to find the window you want to look at or act on.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "app": {"type": "string", "description": "only windows whose app name contains this text (case-insensitive)"},
            },
        },
    },
    {
        "name": "screenshot",
        "description": "Capture one window (windowId) or the whole main display (screen: true). Returns origin/size/scale: global point = origin + pixel / scale. Pass region to zoom into part of it at the same token cost as a full shot; pass format \"jpeg\" for photos-heavy views (5–10× smaller).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "windowId": {"type": "integer", "description": "window id from list_windows"},
                "screen": {"type": "boolean", "description": "capture a whole display instead"},
                "display": {"type": "integer", "description": "which display, 0-based, sorted by display id"},
                "region": {"type": "object", "description": "crop to this rectangle (global points, top-left origin) — this is how you zoom",
                           "properties": {"x": {"type": "number"}, "y": {"type": "number"},
                                          "width": {"type": "number"}, "height": {"type": "number"}},
                           "required": ["x", "y", "width", "height"]},
                "format": {"type": "string", "enum": ["png", "jpeg"], "description": "image encoding; default png (lossless, best for text)"},
                "quality": {"type": "number", "description": "JPEG quality 0.1–1.0, default 0.82"},
                "maxDimension": {"type": "integer", "description": "downscale so the long edge is at most this many pixels (default from ~/.cu/config.json screenshotMaxDimension, normally 1600; 0 keeps full resolution)"},
            },
        },
    },
    {
        "name": "activate_window",
        "description": "Bring a window's app to the front and report whether it actually became frontmost. Call this before clicking, or when another app keeps stealing focus.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "windowId": {"type": "integer"},
            },
            "required": ["windowId"],
        },
    },
    {
        "name": "ax_find",
        "description": "Search a window's accessibility tree for controls whose title or value contains a string, and report their on-screen rectangles. Use it to find the coordinates to click instead of guessing.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "windowId": {"type": "integer", "description": "window id from list_windows (its process is looked up for you)"},
                "pid": {"type": "integer", "description": "or the process id directly"},
                "query": {"type": "string", "description": "text to look for in titles and values"},
                "depth": {"type": "integer", "description": "how deep to walk (default 8)"},
                "all": {"type": "boolean", "description": "also return zero-size nodes such as unopened menu items"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "start_session",
        "description": "Mark the start of a computer-use session: clear any pause, draw the controller halo around the target window (app name + stop control, follows the window) and optionally an occluding cover. Call it before the first action and stop_session at the end.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "windowId": {"type": "integer"},
                "label": {"type": "string", "description": "text on the halo chip, e.g. 'Safari — filling the form'"},
                "cover": {"type": "boolean", "description": "also draw the occluder that blocks the user from clicking the window"},
            },
            "required": ["windowId"],
        },
    },
    {
        "name": "stop_session",
        "description": "End the session: remove the halo and cover. Use resume if the user had paused instead.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "cover_window",
        "description": "Draw (or extend) the occluding cover over a window without starting a full session.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "windowId": {"type": "integer"},
                "label": {"type": "string"},
                "seconds": {"type": "number"},
            },
            "required": ["windowId"],
        },
    },
    {
        "name": "bring_on_stage",
        "description": "Stage Manager keeps windows on stages and shows the rest as left-edge thumbnails. This brings a window onto the current stage (clicking its thumbnail when needed) and reports whether it is now visible.",
        "inputSchema": {
            "type": "object",
            "properties": {"windowId": {"type": "integer"}},
            "required": ["windowId"],
        },
    },
    {
        "name": "bring_to_current_space",
        "description": "Bring a window's app forward on the current Space and report whether its window is now on screen.",
        "inputSchema": {
            "type": "object",
            "properties": {"windowId": {"type": "integer"}},
            "required": ["windowId"],
        },
    },
    {
        "name": "resume",
        "description": "Clear the pause the user set by pressing the stop control on the halo or cover.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "menu",
        "description": "List an app's menu bar, or click a menu item by path (menu/item, e.g. 文件/新建窗口). Listing needs no UI interaction.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "pid": {"type": "integer"},
                "path": {"type": "string", "description": "e.g. File/New Window"},
                "confirm": {"type": "boolean", "description": "allow items whose title looks destructive (close, quit, delete …)"},
            },
            "required": ["pid"],
        },
    },
    {
        "name": "cursor_position",
        "description": "Current pointer position in global points.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "release_mouse",
        "description": "Release a held mouse button at the current pointer position (recover from an interrupted drag).",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "zoom_window",
        "description": "Press a window's zoom / full-screen button.",
        "inputSchema": {
            "type": "object",
            "properties": {"windowId": {"type": "integer"}},
            "required": ["windowId"],
        },
    },
    {
        "name": "move_window",
        "description": "Move and/or resize a window through Accessibility. Fully background: no activation, no cursor movement, the user's focus stays where it was.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "windowId": {"type": "integer"},
                "x": {"type": "number", "description": "new left edge (screen points)"},
                "y": {"type": "number", "description": "new top edge"},
                "width": {"type": "number"},
                "height": {"type": "number"},
            },
            "required": ["windowId"],
        },
    },
    {
        "name": "ocr_find",
        "description": "Local OCR (Apple Vision) on a window or the screen: returns on-screen text boxes in global points. Use it to locate a labelled control without sending an image to a model — typically under a second. Pass query to get only matching lines.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "substring to look for (optional)"},
                "windowId": {"type": "integer"},
                "screen": {"type": "boolean"},
                "limit": {"type": "integer", "description": "max lines returned when no query is given (default 60)"},
            },
        },
    },
    {
        "name": "click_text",
        "description": "One-call labelled click: OCR the window locally, find the text, click its centre without taking focus. Replaces a screenshot round trip; ~1 s end to end. When several lines match, pass index (0-based) from the returned candidates.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "text to find, e.g. 开始创作"},
                "windowId": {"type": "integer"},
                "screen": {"type": "boolean", "description": "search the whole screen instead of one window"},
                "index": {"type": "integer", "description": "which match to click when several are returned"},
                "exact": {"type": "boolean", "description": "require the OCR text to equal the query"},
                "foreground": {"type": "boolean", "description": "bring the app forward first (default: background)"},
                "verify": {"type": "boolean", "description": "after clicking, OCR once more and report whether the text is still visible"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "read_text",
        "description": "OCR a window or the screen and return all recognized lines with their positions, as text. Use it when the model needs to understand a screen without receiving an image.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "windowId": {"type": "integer"},
                "screen": {"type": "boolean"},
                "limit": {"type": "integer", "description": "max lines (default 80)"},
            },
        },
    },
    {
        "name": "selfcheck",
        "description": "One-shot health report: permissions, pause, system overlay, allowlist, window counts, and what to fix next.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "guards",
        "description": "Report the conditions the safety layer checks: secure keyboard entry and how long since the user last touched mouse or keyboard.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "batch",
        "description": "Run several tool calls in order in one round trip. Stops at the first error by default. Use it for deterministic sequences (click → type → key) and then take a snapshot.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "steps": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "tool": {"type": "string"},
                            "arguments": {"type": "object"},
                        },
                        "required": ["tool"],
                    },
                },
                "stopOnError": {"type": "boolean", "description": "default true"},
                "timeoutMs": {"type": "integer", "minimum": 1, "maximum": 600000,
                              "description": "Optional total dispatch budget. Stops further steps on expiry; cannot cancel an in-flight tool. Per-step timings are returned in structuredContent."},
            },
            "required": ["steps"],
        },
    },
    {
        "name": "click",
        "description": "Click. Pass ref (from the latest snapshot) to press that element — it uses the control's own AXPress when available and falls back to its centre; or pass x/y for a coordinate click. Pass windowId to bring that app forward first; the call refuses if the app did not really become frontmost.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "ref": {"type": "string", "description": "element ref from the latest snapshot, e.g. e12"},
                "pid": {"type": "integer", "description": "owner of the ref; defaults to the app of the latest snapshot"},
                "x": {"type": "number"},
                "y": {"type": "number"},
                "windowId": {"type": "integer", "description": "activate this window's app before clicking"},
                "force": {"type": "boolean", "description": "click even if the app did not become frontmost"},
                "dryRun": {"type": "boolean", "description": "run every check but do not post the click"},
                "foreground": {"type": "boolean", "description": "kept for compatibility; a coordinate click already brings the app under the point (or the given pid) forward"},
                "background": {"type": "boolean", "description": "coordinate clicks only: post the event to the named app without bringing it forward (default false)"},
                "button": {"type": "string", "enum": ["left", "right", "middle"]},
                "count": {"type": "integer", "minimum": 1, "maximum": 3},
                "observe": {"type": "boolean", "description": "also return what the app's tree looks like right after this action (diff against the last snapshot)"},
                "observeMs": {"type": "integer", "description": "settle time before observing (default 350)"}},
        },
    },
    {
        "name": "double_click",
        "description": "Double-click a ref (from the latest snapshot) or a coordinate.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "ref": {"type": "string"},
                "pid": {"type": "integer"},
                "x": {"type": "number"},
                "y": {"type": "number"},
                "windowId": {"type": "integer"},
                "observe": {"type": "boolean", "description": "also return what the app's tree looks like right after this action (diff against the last snapshot)"},
                "observeMs": {"type": "integer", "description": "settle time before observing (default 350)"}},
        },
    },
    {
        "name": "set_value",
        "description": "Set a text field's value directly through accessibility (no focus, no keystrokes), and read it back to confirm. ref must come from the latest snapshot.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "ref": {"type": "string"},
                "text": {"type": "string"},
                "pid": {"type": "integer"},
                "observe": {"type": "boolean", "description": "also return what the app's tree looks like right after this action (diff against the last snapshot)"},
                "observeMs": {"type": "integer", "description": "settle time before observing (default 350)"}},
            "required": ["ref", "text"],
        },
    },
    {
        "name": "perform_action",
        "description": "Invoke an accessibility action an element exposes (e.g. AXPress, AXShowMenu, AXIncrement). Only use actions listed for that element in the snapshot.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "ref": {"type": "string"},
                "name": {"type": "string", "description": "exact action name, e.g. AXPress"},
                "pid": {"type": "integer"},
                "observe": {"type": "boolean", "description": "also return what the app's tree looks like right after this action (diff against the last snapshot)"},
                "observeMs": {"type": "integer", "description": "settle time before observing (default 350)"}},
            "required": ["ref", "name"],
        },
    },
    {
        "name": "expect",
        "description": "Assert what the app actually did, by polling its accessibility tree (no screenshot). Use after an action whose effect you must confirm: e.g. type_text then expect the send button enabled, or expect a value/label appeared. Never trust an ok alone.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "pid": {"type": "integer"},
                "windowId": {"type": "integer"},
                "ref": {"type": "string", "description": "snapshot ref of the control to check"},
                "query": {"type": "string", "description": "or find the control by its label/value text"},
                "count": {"type": "integer", "minimum": 0, "maximum": 799,
                          "description": "Require exactly this many matching AX nodes (e.g. timeline clips). Requires windowId and query; may combine with role, not ref/enabled/value/contains. Counts the exposed accessibility tree, not hidden application data."},
                "role": {"type": "string", "description": "Optional exact AX role filter for count mode"},
                "enabled": {"type": "boolean", "description": "require this enabled state"},
                "value": {"type": "string", "description": "require this exact value"},
                "contains": {"type": "string", "description": "require the value or label to contain this text"},
                "timeoutMs": {"type": "integer", "description": "poll for this long (default 2000)"},
            },
            "required": ["pid"],
        },
    },
    {
        "name": "paste_text",
        "description": "Paste text through the clipboard (restores the user's clipboard afterwards). Better than type_text for long or multiline text; format html also puts an HTML flavour on the clipboard.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "format": {"type": "string", "enum": ["text", "html"]},
                "pid": {"type": "integer"},
                "ref": {"type": "string", "description": "snapshot ref of the control to insert into (needed for background apps, which expose no focused element)"},
                "tryOffstage": {"type": "boolean", "description": "attempt even when the app's windows are off-stage (Stage Manager); success is only reported if the app's own state changes"},
                "observe": {"type": "boolean", "description": "also return what the app's tree looks like right after this action (diff against the last snapshot)"},
                "observeMs": {"type": "integer", "description": "settle time before observing (default 350)"}},
            "required": ["text"],
        },
    },
    {
        "name": "type_text",
        "description": "Type a string into whatever is focused. Unicode goes through as-is, so Chinese works.",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string"}, "pid": {"type": "integer"},
                       "foreground": {"type": "boolean", "description": "activate the app first (default: background)"},
                       "tryOffstage": {"type": "boolean", "description": "attempt even when the app's windows are off-stage; success is only reported if the field's value changes"},
                "observe": {"type": "boolean", "description": "also return what the app's tree looks like right after this action (diff against the last snapshot)"},
                "observeMs": {"type": "integer", "description": "settle time before observing (default 350)"}},
            "required": ["text"],
        },
    },
    {
        "name": "press_key",
        "description": "Press one named key, optionally with modifiers. Names: return, tab, space, delete, escape, left/right/up/down, home, end, pageup, pagedown, f1..f12, letters and digits.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "mods": {"type": "string", "description": "comma separated: cmd,shift,opt,ctrl"},
                "pid": {"type": "integer", "description": "send the key to this app"},
                "windowId": {"type": "integer"},
                "foreground": {"type": "boolean", "description": "bring the app forward first (default: background)"},
                "tryOffstage": {"type": "boolean", "description": "attempt even when the app's windows are off-stage; success is only reported if the app's focused state changes"},
                "observe": {"type": "boolean", "description": "also return what the app's tree looks like right after this action (diff against the last snapshot)"},
                "observeMs": {"type": "integer", "description": "settle time before observing (default 350)"}},
            "required": ["name"],
        },
    },
    {
        "name": "scroll",
        "description": "Scroll at the current pointer (or at x,y). Negative dy scrolls content down.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "dy": {"type": "number"},
                "dx": {"type": "number"},
                "x": {"type": "number"},
                "y": {"type": "number"},
                "pid": {"type": "integer"},
                "foreground": {"type": "boolean"},
                "observe": {"type": "boolean", "description": "also return what the app's tree looks like right after this action (diff against the last snapshot)"},
                "observeMs": {"type": "integer", "description": "settle time before observing (default 350)"}},
            "required": ["dy"],
        },
    },
    {
        "name": "drag",
        "description": "Press, drag along a straight path and release, e.g. moving a window or selecting text.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "from": {"type": "object", "properties": {"x": {"type": "number"}, "y": {"type": "number"}}, "required": ["x", "y"]},
                "to": {"type": "object", "properties": {"x": {"type": "number"}, "y": {"type": "number"}}, "required": ["x", "y"]},
            },
            "required": ["from", "to"],
        },
    },
    {
        "name": "highlight_window",
        "description": "Draw the control halo around a window: an accent border, a chip naming the app, and a stop control. The user sees which window is being operated. Returns immediately.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "windowId": {"type": "integer"},
                "seconds": {"type": "number", "description": "auto-hide after this many seconds (0 = until stopped, default 0)"},
                "label": {"type": "string", "description": "text on the chip, e.g. 'Safari — scrolling'"},
            },
            "required": ["windowId"],
        },
    },
    {
        "name": "import_media",
        "description": "Import files into the open panel of a native app (剪映's media library by default) in one call: Cmd+I, Cmd+Shift+G, clear, type the full path, Return, click 导入, then wait until each file appears in the library. Replaces the per-file click/type/key round trips, never double-clicks a folder (that imports it recursively), verifies every step, skips files already in the library, and stops at the first failure after closing the panel. dryRun stops once 导入 is enabled and closes the panel without importing. The target app is activated for the duration: native panels need keyboard focus.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "paths": {"type": "array", "items": {"type": "string"}, "description": "Absolute paths of files to import. Directories are rejected."},
                "pid": {"type": "integer", "description": "Target app pid; inferred from windowId when omitted."},
                "windowId": {"type": "integer", "description": "Target app window; the frontmost window of pid is used when omitted."},
                "dryRun": {"type": "boolean", "description": "Stop after the file is selected and 导入 is enabled; close the panel without importing."},
                "itemTimeoutMs": {"type": "integer", "description": "Per-file wait for the media item to appear (default 12000)"},
                "timeoutMs": {"type": "integer", "description": "Total budget for the whole call (default 600000)"},
                "panelQuery": {"type": "string", "description": "Text that identifies the open panel (default 请选择媒体资源)"},
                "verifyQuery": {"type": "string", "description": "Text that identifies a media-library item (default material.library.item)"},
            },
            "required": ["paths"],
        },
    },
]


def run_cu(*args: str) -> dict:
    discover_service()
    # Prefer the service when available. Once a request is sent, never repeat it
    # locally: a failed response may not establish whether the action occurred.
    if SERVICE["base"] and args:
        try:
            request = urllib.request.Request(
                SERVICE["base"] + "/v1/exec",
                data=json.dumps({"argv": list(args)}).encode(),
                headers={"Authorization": f"Bearer {SERVICE['token']}",
                         "Content-Type": "application/json",
                         # Declaring our identity lets the service skip its
                         # per-connection lsof/ps attribution scan (~90 ms).
                         "X-CU-Caller-Pid": str(HOST[1] or os.getpid()),
                         "X-CU-Caller-Name": HOST[0] or "python"},
                method="POST")
            with urllib.request.urlopen(request, timeout=90) as response:
                result = json.loads(response.read())
            return result
        except Exception:
            SERVICE["base"] = None
            SERVICE["token"] = None
            return {"ok": False, "error": "service_result_unknown",
                    "message": "the service request failed; the action may have been executed, so it was not retried locally"}
    if not CU.is_file():
        return {"ok": False, "error": "missing_binary",
                "message": f"{CU} does not exist; build it with build.sh"}
    try:
        completed = subprocess.run([str(CU), *args], capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "timeout", "message": "cu did not answer in 60s"}
    line = (completed.stdout or "").strip().splitlines()
    if not line:
        return {"ok": False, "error": "no_output",
                "message": (completed.stderr or "").strip()[:400] or "cu printed nothing"}
    try:
        return json.loads(line[-1])
    except json.JSONDecodeError:
        return {"ok": False, "error": "bad_output", "message": line[-1][:400]}


def window_pid(window_id: int) -> int | None:
    listing = windows_listing()
    for window in listing.get("windows", []):
        if int(window.get("windowId", -1)) == int(window_id):
            return int(window.get("pid", 0)) or None
    return None


def auto_halo(pid: int) -> None:
    """Show the controller halo the first time an app is acted on, the way the
    shipped engine shows its indicator for the whole session."""
    if not AUTO_HALO:
        return
    process = AUTO_SESSIONS.get(pid)
    if process is not None and process.poll() is None:
        return
    # Keep one owned indicator, including when the target application changes.
    stop_owned_indicators()
    listing = windows_listing()
    window = next((w for w in listing.get("windows", []) if int(w.get("pid", 0)) == pid
                   and w.get("frontmost")), None)
    if window is None:
        window = next((w for w in listing.get("windows", []) if int(w.get("pid", 0)) == pid), None)
    if window is None:
        return
    app = window.get("app") or ""
    label = f"{app} — 自动操作中"
    if CAPSULE:
        # One floating pill, no window tracking: it cannot cover the app being
        # driven and it does not sweep the window list four times a second.
        process = spawn_detached(["capsule", "--label", label, "--seconds", "900"])
    else:
        # A halo that is never stopped would outlive the session; give it a TTL.
        process = spawn_detached(["halo", "--window", str(int(window["windowId"])),
                                  "--seconds", "900", "--label", label])
        record_halo(int(window["windowId"]), process.pid)
    AUTO_SESSIONS[pid] = process


def indicator_target(*, window_id=None, pid=None, point=None) -> int | None:
    """Resolve an indicator target without changing focus or posting input."""
    try:
        if window_id is not None:
            return pid_for_window(int(window_id))
        if pid is not None:
            return int(pid) or None
        if point is None:
            return None
        x, y = point
        listing = windows_listing(max_age=0)
        if not listing.get("ok"):
            return None
        for window in listing.get("windows", []):
            if window.get("axOnly"):
                continue
            bounds = window.get("bounds") or {}
            if (bounds["x"] <= x < bounds["x"] + bounds["width"] and
                    bounds["y"] <= y < bounds["y"] + bounds["height"]):
                return int(window.get("pid", 0)) or None
    except Exception:
        pass
    return None


def indicate_success(result: dict, pid: int | None, *, dry_run=False) -> None:
    """The optional indicator must never change or retry an action."""
    if not CAPSULE or not pid or dry_run or not result.get("ok"):
        return
    try:
        auto_halo(pid)
    except Exception:
        pass


INDICATOR_TIMER = None


def stop_owned_indicators() -> None:
    """Only terminate child processes created by this MCP connection."""
    for pid, process in list(AUTO_SESSIONS.items()):
        if process.poll() is None:
            process.terminate()
        AUTO_SESSIONS.pop(pid, None)


def finish_indicators() -> None:
    global INDICATOR_TIMER
    if INDICATOR_TIMER is not None:
        INDICATOR_TIMER.cancel()
        INDICATOR_TIMER.join()
    stop_owned_indicators()


def record_halo(window_id: int, pid: int) -> None:
    """Halos outlive this process's memory, so their pids are kept on disk."""
    try:
        data = json.loads(HALO_FILE.read_text()) if HALO_FILE.exists() else {}
    except (OSError, json.JSONDecodeError):
        data = {}
    data[str(window_id)] = pid
    HALO_FILE.parent.mkdir(parents=True, exist_ok=True)
    HALO_FILE.write_text(json.dumps(data, indent=2, sort_keys=True))


def stop_all_halos() -> list[int]:
    stopped = []
    if HALO_FILE.exists():
        try:
            data = json.loads(HALO_FILE.read_text())
        except (OSError, json.JSONDecodeError):
            data = {}
        for window_id, pid in data.items():
            try:
                os.kill(int(pid), 15)
                stopped.append(int(pid))
            except (ProcessLookupError, ValueError):
                pass
        HALO_FILE.unlink(missing_ok=True)
    for process in AUTO_SESSIONS.values():
        process.terminate()
    AUTO_SESSIONS.clear()
    return stopped


def pid_for_window(window_id: int) -> int | None:
    listing = windows_listing()
    for window in listing.get("windows", []):
        if int(window.get("windowId", -1)) == int(window_id):
            return int(window.get("pid", 0)) or None
    return None


def spawn_detached(args: list[str]):
    return subprocess.Popen([str(CU), *args], stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, start_new_session=True)


def render_node(node: dict) -> str:
    parts = [node.get("ref", "?"), node.get("role", "?")]
    title = node.get("title") or ""
    value = node.get("value") or ""
    if title:
        parts.append(json.dumps(title, ensure_ascii=False))
    if value and value != title:
        parts.append("value=" + json.dumps(value, ensure_ascii=False))
    if node.get("w") is not None:
        parts.append(f"@({node['x']:.0f},{node['y']:.0f}) {node['w']:.0f}x{node['h']:.0f}")
    if node.get("enabled") is False:
        parts.append("disabled")
    if node.get("subrole"):
        parts.append(node["subrole"])
    actions = node.get("actions") or []
    if actions:
        parts.append("[" + " ".join(actions) + "]")
    return " ".join(parts)


INPUT_ROLES = {"AXTextField", "AXTextArea", "AXComboBox", "AXSecureTextField"}


def render_snapshot(snapshot: dict, limit: int = 400) -> str:
    nodes = snapshot.get("nodes", [])
    lines = [f"app={snapshot.get('app', '')} pid={snapshot.get('pid')} "
             f"nodes={len(nodes)} (refs are valid only for this snapshot)"]
    # Inputs are what the caller most often needs and they can sit deep in a large
    # tree; list them up front so a 700-node app still hands over its fields.
    inputs = [n for n in nodes if n.get("role") in INPUT_ROLES][:10]
    for node in inputs:
        value = node.get("value") or ""
        suffix = " [focused]" if node.get("focused") else ""
        lines.append(f"input: {node['ref']} {node.get('role')} "
                     + json.dumps(node.get("title") or "", ensure_ascii=False)
                     + (f" = {json.dumps(value, ensure_ascii=False)}" if value else "")
                     + suffix)
    for node in nodes[:limit]:
        lines.append(render_node(node))
    if len(nodes) > limit:
        lines.append(f"… {len(nodes) - limit} more; use click(ref) or narrow with the app itself")
    return "\n".join(lines)


def diff_fields(old: dict, new: dict) -> str:
    changes = []
    for field in ("role", "title", "value", "enabled"):
        if old.get(field) != new.get(field):
            changes.append(f"{field}: {old.get(field)!r} → {new.get(field)!r}")
    for field in ("x", "y", "w", "h"):
        if old.get(field) != new.get(field):
            changes.append(f"{field}: {old.get(field)} → {new.get(field)}")
    if old.get("actions") != new.get("actions"):
        changes.append(f"actions: {old.get('actions')} → {new.get('actions')}")
    return "; ".join(changes)


def render_diff(previous: dict, current: dict) -> tuple[str, bool]:
    """Returns (text, use_full_instead). Mirrors the shape of a good AX diff:
    removals first, then additions, then changes; unchanged refs keep their id."""
    old = {node["ref"]: node for node in previous.get("nodes", [])}
    new = {node["ref"]: node for node in current.get("nodes", [])}
    removed = [ref for ref in old if ref not in new]
    added = [ref for ref in new if ref not in old]
    changed = [ref for ref in new if ref in old and diff_fields(old[ref], new[ref])]
    churn = len(removed) + len(added) + len(changed)
    if not new or churn > max(80, int(0.4 * len(new))):
        return "", True

    head = (f"app={current.get('app', '')} pid={current.get('pid')} "
            f"diff: +{len(added)} -{len(removed)} ~{len(changed)} "
            f"(baseline nodes={len(old)}, now={len(new)})")
    lines = [head]
    if churn == 0:
        lines.append("no change — references from the previous snapshot are still valid")
        return "\n".join(lines), False
    for ref in removed:
        lines.append("removed " + render_node(old[ref]))
    for ref in added:
        lines.append("added   " + render_node(new[ref]))
    for ref in changed:
        lines.append("changed " + new[ref].get("ref", "?") + " " + new[ref].get("role", "?")
                     + " | " + diff_fields(old[ref], new[ref]))
    return "\n".join(lines), False


def ref_context(ref: str, pid: int | None = None) -> tuple[int, str, str, int | None] | dict:
    """Find the snapshot entry behind a ref: (pid, role, title, window) or an error.

    Only the latest snapshot for the app is consulted. Even a matching path,
    role and title cannot prove identity after a same-named control moves."""
    snapshot = snapshot_for(int(pid)) if pid is not None else (
        max(SNAPSHOTS.values(), key=lambda s: s.get("_seq", 0)) if SNAPSHOTS else None)
    if not snapshot:
        return {"ok": False, "error": "no_snapshot", "message": "call snapshot first"}
    owner = int(snapshot["pid"])
    for node in snapshot.get("nodes", []):
        if node.get("ref") == ref:
            return (owner, node.get("role", ""), node.get("title", ""),
                    snapshot.get("windowId"))
    return {"ok": False, "error": "stale_ref",
            "message": f"{ref} is not in the latest snapshot; take a new one"}


def set_activity(text: str) -> None:
    try:
        ACTIVITY.parent.mkdir(parents=True, exist_ok=True)
        ACTIVITY.write_text(json.dumps({"text": text, "ts": time.time()}, ensure_ascii=False))
    except OSError:
        pass


def png_size(raw: bytes) -> tuple[int, int] | None:
    if len(raw) < 24 or raw[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    width, height = struct.unpack(">II", raw[16:24])
    return width, height


def service_ocr(png: bytes, find: str | None, exact: bool = False) -> dict | None:
    """OCR inside the warm service process; None when it is unavailable."""
    discover_service()
    if not SERVICE["base"]:
        return None
    payload = {"image": __import__("base64").b64encode(png).decode()}
    if find:
        payload["find"] = find
    if exact:
        payload["exact"] = True
    try:
        request = urllib.request.Request(
            SERVICE["base"] + "/v1/ocr",
            data=json.dumps(payload).encode(),
            headers={"Authorization": f"Bearer {SERVICE['token']}",
                     "Content-Type": "application/json"},
            method="POST")
        with urllib.request.urlopen(request, timeout=35) as response:
            return json.loads(response.read())
    except Exception:
        return None


def find_text_boxes(window_id: int | None, screen: bool, query: str,
                    exact: bool = False, max_dim: int = 1600) -> dict:
    """Find text on screen: accessibility tree first (fast, exact), then a
    capture + OCR pass in the warm service (fallback: local engine)."""
    if window_id and query:
        ax = run_cu("findtext", "--window", str(int(window_id)),
                    "--text", query, "--limit", "40")
        if ax.get("ok") and ax.get("matches"):
            needle = query.strip().lower()
            matches = []
            for match in ax["matches"]:
                if match.get("x") is None:
                    continue
                text = match.get("text") or query
                if exact and text.strip().lower() != needle:
                    continue
                matches.append({"text": text,
                                "cx": match["x"] + match["w"] / 2,
                                "cy": match["y"] + match["h"] / 2,
                                "confidence": 1.0,
                                "ref": match.get("ref"),
                                "role": match.get("role"),
                                "pressable": bool(match.get("pressable"))})
            if matches:
                return {"ok": True, "ms": ax.get("ms"), "source": "ax",
                        "count": len(matches), "matches": matches,
                        "lines": [{"text": m["text"], "cx": m["cx"], "cy": m["cy"]}
                                  for m in matches],
                        "query": query}
    if window_id and not query:
        ax = run_cu("readtext", "--window", str(int(window_id)), "--limit", "200")
        ax_lines = [line for line in (ax.get("lines") or []) if line.get("cx") is not None]
        if ax.get("ok") and len(ax_lines) >= 3:
            return {"ok": True, "ms": ax.get("ms"), "source": "ax",
                    "count": len(ax_lines), "lines": ax_lines}
    shot_args = ["shot"]
    if window_id:
        shot_args += ["--window", str(int(window_id))]
    else:
        shot_args.append("--screen")
    shot_args += ["--max-dim", str(int(max_dim))]
    shot = run_cu(*shot_args)
    if not shot.get("ok") or not shot.get("base64"):
        return {"ok": False, "error": shot.get("error", "capture_failed"),
                "message": shot.get("message", "")}
    raw = __import__("base64").b64decode(shot["base64"])
    size = png_size(raw)
    if not size:
        return {"ok": False, "error": "bad_image"}
    img_w, img_h = size
    origin = shot.get("origin", {"x": 0, "y": 0})
    width_pts = (shot.get("size") or {}).get("width") or 1
    scale = img_w / float(width_pts) if width_pts else 1.0
    # OCR once without a filter, then match locally: the caller gets both the
    # matches and the surrounding text for context.
    served = service_ocr(raw, None, False)
    source = "service"
    if served and served.get("ok"):
        rows = served.get("lines", [])
        ms = served.get("ms")
    else:
        local_args = ["ocr"]
        if window_id:
            local_args += ["--window", str(int(window_id))]
        else:
            local_args.append("--screen")
        local_args += ["--max-dim", str(int(max_dim))]
        local = run_cu(*local_args)
        if not local.get("ok"):
            return local
        rows = local.get("lines", [])
        ms = local.get("ms")
        source = "local"
    converted = []
    for row in rows:
        converted.append({**row,
                          "cx": origin["x"] + row["cx"] / scale,
                          "cy": origin["y"] + row["cy"] / scale})
    result = {"ok": True, "ms": ms, "source": source, "count": len(converted),
              "image": {"width": img_w, "height": img_h}, "scale": scale,
              "lines": converted}
    if query:
        needle = query.strip().lower()
        result["matches"] = [
            row for row in converted
            if (row.get("text") or "").strip().lower() == needle
            if exact
        ] if exact else [
            row for row in converted if needle in (row.get("text") or "").lower()
        ]
        result["query"] = query
    return result


OBSERVABLE = {"click", "double_click", "type_text", "paste_text", "press_key",
              "scroll", "set_value", "perform_action", "select_text", "menu",
              "move_window", "zoom_window"}

# First look at the tree after an action: long enough that a click is not
# judged mid-animation, short enough that an immediate change is returned
# well before the old fixed wait would have ended.
OBSERVE_FIRST_LOOK_MS = 80


def tree_changed(previous: dict, current: dict) -> bool:
    """Whether the UI moved, using the exact fields render_diff reports.

    Sharing the comparison means the poll never returns "changed" on a tree
    the rendered observation would later call identical. An empty walk is not
    evidence of a change — it is usually a failure or a redraw."""
    old = {n["ref"]: n for n in previous.get("nodes", [])
           if isinstance(n, dict) and n.get("ref")}
    new = {n["ref"]: n for n in current.get("nodes", [])
           if isinstance(n, dict) and n.get("ref")}
    if not new:
        return False
    if set(old) != set(new):
        return True
    return any(diff_fields(old[ref], new[ref]) for ref in new)


def observe_after(arguments: dict, response: dict) -> dict:
    """Claude's computer tool answers every action with a fresh frame. Do the
    same with the accessibility tree: it is cheaper than a screenshot, carries
    refs the caller can act on next, and it is the only way a caller learns the
    action did nothing.

    When a baseline snapshot exists, observation is change-driven: look early
    and return the moment the tree moves; an unchanged tree still gets the
    full observeMs budget and one final snapshot, so a slow change is never
    missed and the worst-case cost matches the old fixed wait."""
    if not arguments.get("observe"):
        return response
    content = (response.get("content") or [{}])[0].get("text", "")
    try:
        payload = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        payload = None
    if not isinstance(payload, dict):
        return {"content": [{"type": "text", "text": json.dumps(
            {"ok": False, "error": "observation_unavailable",
             "message": "the action result could not be read; its outcome is unknown"})}], "isError": True}
    if not payload.get("ok", True):
        return response
    pid = payload.get("pid") or arguments.get("pid")
    if not pid and arguments.get("ref"):
        context = ref_context(str(arguments["ref"]))
        if not isinstance(context, dict):
            pid = context[0]
    if not pid:
        payload["observationError"] = {"error": "missing_pid", "message": "action was sent but could not be observed"}
        return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}], "isError": True}
    window = payload.get("windowId") or arguments.get("windowId")
    if window is None and arguments.get("ref"):
        context = ref_context(str(arguments["ref"]), int(pid))
        if not isinstance(context, dict):
            window = context[3]
    budget_ms = max(0, int(arguments.get("observeMs", 350)))
    args = ["snapshot", "--pid", str(int(pid)), "--settle", "0"]
    if window:
        args += ["--window", str(int(window))]
    previous = snapshot_for(int(pid), int(window) if window else None)
    started = time.monotonic()
    if previous is not None and budget_ms > 0:
        time.sleep(min(OBSERVE_FIRST_LOOK_MS, budget_ms) / 1000.0)
        current = run_cu(*args)
        if current.get("ok") and not tree_changed(previous, current):
            remaining = budget_ms / 1000.0 - (time.monotonic() - started)
            if remaining > 0:
                # The change may still be on its way: wait out the old fixed
                # budget, then take the final snapshot at exactly its end.
                time.sleep(remaining)
                current = run_cu(*args)
    else:
        time.sleep(budget_ms / 1000.0)
        current = run_cu(*args)
    waited_ms = round((time.monotonic() - started) * 1000)
    if not current.get("ok"):
        payload["observationError"] = {"error": current.get("error", "observation_failed"),
                                       "message": current.get("message", "action was sent but could not be observed")}
        return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}], "isError": True}
    current["windowId"] = int(window) if window else None
    store_snapshot(int(pid), current["windowId"], current)
    changed = previous is not None and tree_changed(previous, current)
    if previous and previous.get("version") == current.get("version"):
        text, use_full = render_diff(previous, current)
        payload["observation"] = render_snapshot(current)[:1500] if use_full else text
    else:
        payload["observation"] = render_snapshot(current)[:1500]
    payload["observationMs"] = waited_ms
    payload["observationChanged"] = bool(changed)
    return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}],
            "isError": response.get("isError", False)}


# MARK: - one-call media import
#
# The 2026-10-30 剪映 run needed six model round trips per clip (Cmd+I,
# Cmd+Shift+G, clear, type, Return, click 导入), and every round trip could
# drift: the close click could land before the go-to sheet existed, the new
# path was appended to the old one, and 导入 stayed disabled while every call
# answered ok. This flow runs those steps locally, checks each postcondition,
# and reports success only after the media library itself shows the file.
# Navigation is always a typed full path: double-clicking a folder in this
# panel imports the whole folder recursively (observed: 31484 items).

IMPORT_PANEL_QUERY = "请选择媒体资源"
# 剪映's go-to sheet labels the field “前往：”; older macOS panels say
# “前往文件夹”. The query is a substring, so “前往” matches both.
IMPORT_GOTO_LABEL = "前往"
IMPORT_IMPORT_LABEL = "导入"
IMPORT_CLOSE_LABEL = "关闭"
IMPORT_PROGRESS_QUERY = "导入素材"
IMPORT_ITEM_PREFIX = "material.library.item."
IMPORT_FIELD_ROLES = {"AXTextField", "AXComboBox", "AXSearchField"}


class ImportFlowError(Exception):
    """A step did not reach its verified postcondition; nothing is guessed."""

    def __init__(self, stage: str, message: str, **details):
        super().__init__(message)
        self.stage = stage
        self.message = message
        self.details = details

    def as_dict(self) -> dict:
        payload = {"ok": False, "error": "import_failed",
                   "stage": self.stage, "message": self.message}
        payload.update(self.details)
        return payload


class ImportRunner:
    """Maps the flow's four verbs onto engine CLI calls (injectable in tests)."""

    def __init__(self, run=run_cu):
        self._run = run

    def snapshot(self, pid: int, window_id: int | None = None) -> dict:
        argv = ["snapshot", "--pid", str(int(pid)), "--settle", "0"]
        if window_id:
            argv += ["--window", str(int(window_id))]
        return self._run(*argv)

    def ax(self, pid: int, query: str, window_id: int | None = None) -> dict:
        argv = ["ax", "--pid", str(int(pid)), "--find", str(query)]
        if window_id:
            argv += ["--window", str(int(window_id))]
        return self._run(*argv)

    def key(self, name: str, mods: str = "", pid: int | None = None,
            window_id: int | None = None) -> dict:
        argv = ["key", "--name", name]
        if mods:
            argv += ["--mods", mods]
        if window_id:
            argv += ["--window", str(int(window_id))]
        elif pid:
            argv += ["--pid", str(int(pid))]
        return self._run(*argv)

    def click(self, x: float, y: float, window_id: int | None = None) -> dict:
        argv = ["click", "--x", f"{float(x):g}", "--y", f"{float(y):g}"]
        if window_id:
            argv += ["--window", str(int(window_id))]
        argv.append("--phantom")
        return self._run(*argv)

    def type(self, text: str, pid: int) -> dict:
        return self._run("type", "--text", text, "--pid", str(int(pid)), "--background")


class ImportFlow:
    """Drive a native open panel file by file and prove each import.

    Per file: Cmd+I → Cmd+Shift+G → click 关闭 (clears the field; Cmd+A does not
    clear AX-set values) → AX-set the full path → click the field → Return →
    wait until 导入 is enabled → click it → wait until the media item appears.
    The panel's own buttons are picked by position (lowest 导入; 关闭 nearest
    the go-to label) because the main window has controls with the same titles.
    """

    def __init__(self, runner: ImportRunner, *, sleep=time.sleep, clock=time.monotonic,
                 panel_query: str = IMPORT_PANEL_QUERY,
                 verify_query: str = IMPORT_ITEM_PREFIX,
                 goto_label: str = IMPORT_GOTO_LABEL,
                 import_label: str = IMPORT_IMPORT_LABEL,
                 close_label: str = IMPORT_CLOSE_LABEL,
                 progress_query: str = IMPORT_PROGRESS_QUERY,
                 item_timeout: float = 12.0, panel_timeout: float = 3.0,
                 goto_timeout: float = 4.0, settle: float = 0.15,
                 poll: float = 0.3):
        self.runner = runner
        self.sleep = sleep
        self.clock = clock
        self.panel_query = panel_query
        self.verify_query = verify_query
        self.goto_label = goto_label
        self.import_label = import_label
        self.close_label = close_label
        self.progress_query = progress_query
        self.item_timeout = item_timeout
        self.panel_timeout = panel_timeout
        self.goto_timeout = goto_timeout
        self.settle = settle
        self.poll = poll
        self.pid = 0
        self.window_id: int | None = None
        # Sheets live under the target window in most apps; if the panel is not
        # reachable there, fall back to the whole app once and remember it.
        self.use_app_scope = False
        self.field: dict | None = None
        self.goto_anchor: dict | None = None
        self.previous_path: str | None = None

    def run(self, pid: int, window_id: int | None, paths: list[str],
            dry_run: bool = False, timeout_s: float = 600.0) -> dict:
        self.pid = int(pid)
        self.window_id = int(window_id) if window_id else None
        self.use_app_scope = False
        self.field = None
        self.goto_anchor = None
        self.previous_path = None
        files: list[str] = []
        for raw in paths:
            path = os.path.abspath(os.path.expanduser(str(raw)))
            if not os.path.exists(path):
                raise ImportFlowError("input", f"not found: {path}")
            if not os.path.isfile(path):
                raise ImportFlowError(
                    "input", f"not a file: {path}; this panel imports a folder "
                             "recursively, so the flow only accepts files")
            files.append(path)
        if not files:
            raise ImportFlowError("input", "paths is empty")

        summary: dict = {"ok": True, "dryRun": bool(dry_run), "imported": [],
                         "skipped": [], "itemsBefore": self._item_count(), "steps": []}
        try:
            if dry_run:
                path = files[0]
                encoded = quote(os.path.basename(path), safe="")
                if self._item_present(encoded):
                    summary["skipped"].append(path)
                    summary["itemsAfter"] = summary["itemsBefore"]
                    summary["note"] = "already in the library; nothing was selected"
                    return summary
                started = self.clock()
                self._ensure_panel()
                self._goto_and_confirm(path, os.path.basename(path))
                summary["selected"] = path
                summary["importEnabled"] = True
                summary["panelClosed"] = self._close_panel()
                summary["itemsAfter"] = self._item_count()
                summary["steps"].append({"path": path, "dryRun": True,
                                         "ms": round((self.clock() - started) * 1000)})
                return summary

            started = self.clock()
            for path in files:
                if self.clock() - started > timeout_s:
                    raise ImportFlowError("timeout", f"total budget {timeout_s:g}s exhausted")
                encoded = quote(os.path.basename(path), safe="")
                if self._item_present(encoded):
                    summary["skipped"].append(path)
                    continue
                file_started = self.clock()
                progress = self._import_one(path, encoded)
                summary["imported"].append(path)
                summary["steps"].append({"path": path, "progressSeen": progress,
                                         "ms": round((self.clock() - file_started) * 1000)})
            summary["itemsAfter"] = self._item_count()
            summary["itemCountCapped"] = summary["itemsAfter"] >= 25
            return summary
        except ImportFlowError as error:
            error.details.setdefault("imported", summary["imported"][:])
            error.details.setdefault("skipped", summary["skipped"][:])
            error.details.setdefault("steps", summary["steps"])
            error.details.setdefault("itemsAfter", self._item_count_safe())
            self._close_panel()
            raise
        except Exception:
            self._close_panel()
            raise

    # -- per-file steps -----------------------------------------------------

    def _import_one(self, path: str, encoded: str) -> bool:
        self._ensure_panel()
        self._goto_and_confirm(path, os.path.basename(path))
        button = self._button(self.import_label)
        if button is None or not button.get("enabled"):
            raise ImportFlowError(
                "import_click", f"{self.import_label} is missing or disabled",
                file=os.path.basename(path),
                enabled=bool(button and button.get("enabled")))
        self._check(self.runner.click(button["cx"], button["cy"], self.window_id),
                    "import_click", f"click {self.import_label}")
        return self._wait_item(path, encoded)

    def _ensure_panel(self) -> None:
        if self._panel_open():
            return
        for _ in range(2):
            self._check(self.runner.key("i", "cmd", self.pid, self.window_id),
                        "panel_open", "press Cmd+I")
            if self._wait(self._panel_open, self.panel_timeout):
                return
            # The panel may be a separate AXWindow outside the target window's
            # subtree; pay for one whole-app query before pressing Cmd+I again.
            if not self.use_app_scope and self._ax_app(self.panel_query):
                self.use_app_scope = True
                return
        raise ImportFlowError("panel_open", "the import panel did not appear")

    def _goto_and_confirm(self, path: str, raw: str) -> None:
        """One retry: a stale field or a missed Return is recoverable by
        reopening the panel, but a second failure is reported, not looped."""
        last: ImportFlowError | None = None
        for attempt in (1, 2):
            try:
                self._open_goto()
                self._clear_field()
                self._type_path(path, raw)
                self._confirm()
                return
            except ImportFlowError as error:
                if error.stage not in ("goto_open", "goto_clear", "goto_type", "goto_confirm"):
                    raise
                last = error
                if attempt == 2:
                    break
                self._close_panel()
                self._ensure_panel()
        assert last is not None
        raise last

    def _open_goto(self) -> None:
        for _ in range(2):
            self._check(self.runner.key("g", "cmd,shift", self.pid, self.window_id),
                        "goto_open", "press Cmd+Shift+G")
            if self._wait(self._goto_visible, self.panel_timeout):
                return
        raise ImportFlowError("goto_open", "the go-to-folder sheet did not appear")

    def _goto_visible(self) -> bool:
        matches = self._ax_window(self.goto_label)
        if not matches:
            self.goto_anchor = None
            # macOS hides the go-to label when it restores the previous path.
            # Recognize the focused confirmable field inside a nested sheet,
            # not an arbitrary search field elsewhere in the open panel.
            scope = None if self.use_app_scope else self.window_id
            result = self._check(self.runner.snapshot(self.pid, scope),
                                 "goto_open", "inspect go-to sheet")
            nodes = result.get("nodes") or []
            sheets = {n.get("ref") for n in nodes if n.get("role") == "AXSheet"}
            candidates = []
            for node in nodes:
                ref = node.get("ref", "")
                parent = ref.rpartition(".")[0]
                if (node.get("role") != "AXTextField" or node.get("focused") is not True
                        or "AXConfirm" not in node.get("actions", [])
                        or parent not in sheets
                        or not any(parent.startswith(s + ".") for s in sheets if s)):
                    continue
                if any(n.get("role") == "AXButton" and n.get("title") == self.close_label
                       and n.get("ref", "").rpartition(".")[0] == parent for n in nodes):
                    candidates.append(node)
            if len(candidates) != 1:
                return False
            self.goto_anchor = candidates[0]
            return True
        self.goto_anchor = next(
            (m for m in matches if m.get("role") == "AXStaticText"), matches[0])
        return True

    def _clear_field(self) -> None:
        button = self._button(self.close_label, near=self.goto_anchor)
        if button is None:
            self._wait(lambda: self._button(self.close_label, near=self.goto_anchor) is not None, 1.0)
            button = self._button(self.close_label, near=self.goto_anchor)
        if button is None:
            raise ImportFlowError("goto_clear", f"the go-to sheet has no {self.close_label} button")
        self._check(self.runner.click(button["cx"], button["cy"], self.window_id),
                    "goto_clear", f"click {self.close_label}")
        self.sleep(self.settle)
        if self.previous_path:
            raw = os.path.basename(self.previous_path)
            leftovers = [m for m in self._field_matches(raw)
                         if (m.get("value") or "").strip()]
            if leftovers:
                raise ImportFlowError("goto_clear", "the field still holds an old path",
                                      value=leftovers[0].get("value"))

    def _type_path(self, path: str, raw: str) -> None:
        self.previous_path = path
        self._check(self.runner.type(path, self.pid), "goto_type", "AX-set the path")
        self.sleep(self.settle)
        fields = self._field_matches(raw)
        exact = next((m for m in fields if (m.get("value") or "") == path), None)
        if exact is None:
            value = fields[0].get("value") if fields else None
            raise ImportFlowError("goto_type", "the field does not hold the exact path",
                                  value=value, expected=path)
        self.field = exact

    def _confirm(self) -> None:
        field = self.field
        if not field or "cx" not in field or "cy" not in field:
            raise ImportFlowError("goto_confirm", "the path field has no frame")
        self._check(self.runner.click(field["cx"], field["cy"], self.window_id),
                    "goto_confirm", "click the path field")
        self._check(self.runner.key("return", "", self.pid, self.window_id),
                    "goto_confirm", "press Return")

        def ready() -> bool:
            # The import button is enabled only after the panel accepted the
            # path; re-querying the field as well doubled every poll's cost.
            button = self._button(self.import_label)
            return bool(button and button.get("enabled"))

        if not self._wait(ready, self.goto_timeout):
            button = self._button(self.import_label)
            raise ImportFlowError(
                "goto_confirm", f"{self.import_label} did not become available after Return",
                importEnabled=bool(button and button.get("enabled")))

    def _wait_item(self, path: str, encoded: str) -> bool:
        deadline = self.clock() + self.item_timeout
        progress_seen = False
        progress_checks = 0
        while True:
            if self._item_present(encoded):
                return progress_seen
            if self.clock() >= deadline:
                break
            if not progress_seen and progress_checks < 3:
                progress_seen = self._progress_visible()
                progress_checks += 1
            self.sleep(self.poll)
        raise ImportFlowError(
            "import_verify",
            f"the file did not appear in the library within {self.item_timeout:g}s",
            file=os.path.basename(path), progressVisible=progress_seen,
            panelOpen=self._panel_open_safe())

    # -- verified queries ---------------------------------------------------

    def _check(self, result, stage: str, what: str) -> dict:
        if not isinstance(result, dict) or not result.get("ok"):
            detail = ""
            if isinstance(result, dict):
                detail = str(result.get("message") or result.get("error") or "")
            raise ImportFlowError(stage, f"{what} failed: {detail}".strip())
        return result

    def _matches(self, result, query: str) -> list:
        if not isinstance(result, dict) or not result.get("ok"):
            detail = ""
            if isinstance(result, dict):
                detail = str(result.get("message") or result.get("error") or "")
            raise ImportFlowError("ax", f"ax_find “{query}” failed: {detail}".strip())
        return result.get("matches") or []

    def _ax_window(self, query: str) -> list:
        scope = None if self.use_app_scope else self.window_id
        return self._matches(self.runner.ax(self.pid, query, scope), query)

    def _ax_app(self, query: str) -> list:
        return self._matches(self.runner.ax(self.pid, query, None), query)

    def _panel_open(self) -> bool:
        return bool(self._ax_window(self.panel_query))

    def _panel_open_safe(self):
        try:
            return self._panel_open()
        except Exception:
            return None

    def _close_panel(self) -> bool:
        for _ in range(3):
            state = self._panel_open_safe()
            if state is not True:
                return state is False
            self.runner.key("escape", "", self.pid, self.window_id)
            self.sleep(0.4)
        return self._panel_open_safe() is False

    def _field_matches(self, raw: str) -> list:
        return [m for m in self._ax_window(raw) if m.get("role") in IMPORT_FIELD_ROLES]

    def _button(self, label: str, near: dict | None = None) -> dict | None:
        exact, loose = [], []
        for match in self._ax_window(label):
            if match.get("role") not in ("AXButton", "AXMenuItem"):
                continue
            if "cx" not in match or "cy" not in match:
                continue
            title = (match.get("title") or "").strip()
            if label not in f"{title} {match.get('value') or ''}":
                continue
            (exact if title == label else loose).append(match)
        candidates = exact or loose
        if not candidates:
            return None
        if near and "cx" in near and "cy" in near:
            return min(candidates,
                       key=lambda m: abs(m["cx"] - near["cx"]) + abs(m["cy"] - near["cy"]))
        # Modal buttons sit at the bottom of the sheet; the main window's own
        # 导入 button sits higher, so the lowest match belongs to the panel.
        return max(candidates, key=lambda m: m["cy"])

    def _item_present(self, encoded: str) -> bool:
        needle = encoded.lower()
        for match in self._ax_window(encoded):
            if match.get("role") != "AXButton":
                continue
            text = f"{match.get('title') or ''} {match.get('value') or ''}"
            if self.verify_query in text and needle in text.lower():
                return True
        return False

    def _item_count(self) -> int:
        titles = set()
        for match in self._ax_window(self.verify_query):
            title = match.get("title") or ""
            if match.get("role") == "AXButton" and self.verify_query in title:
                titles.add(title)
        return len(titles)

    def _item_count_safe(self):
        try:
            return self._item_count()
        except Exception:
            return None

    def _progress_visible(self) -> bool:
        try:
            return bool(self._ax_app(self.progress_query))
        except Exception:
            return False

    def _wait(self, predicate, timeout: float) -> bool:
        deadline = self.clock() + timeout
        while True:
            if predicate():
                return True
            if self.clock() >= deadline:
                return False
            self.sleep(self.poll)


def count_expectation_error(arguments: dict) -> dict | None:
    count, query = arguments.get("count"), arguments.get("query")
    timeout = arguments.get("timeoutMs", 2000)
    role = arguments.get("role")
    if (type(count) is not int or not 0 <= count < 800
            or not isinstance(query, str) or not query
            or any(type(arguments.get(k)) is not int or arguments[k] <= 0 for k in ("pid", "windowId"))
            or type(timeout) is not int or not 0 <= timeout <= 60000
            or (role is not None and (not isinstance(role, str) or not role))
            or any(k in arguments for k in ("ref", "enabled", "value", "contains"))):
        return {"ok": False, "error": "invalid_count_expectation",
                "message": "count requires pid, windowId, nonempty query, optional role and timeoutMs (0–60000); do not combine with ref/value/enabled/contains"}
    return None


def expect_count(arguments: dict) -> dict:
    """Wait for an exact number of matching nodes in a scoped live snapshot."""
    error = count_expectation_error(arguments)
    if error:
        return error
    count, query = arguments["count"], arguments["query"]
    timeout, role = arguments.get("timeoutMs", 2000), arguments.get("role")
    started = time.monotonic()
    deadline = started + timeout / 1000
    while True:
        result = run_cu("snapshot", "--pid", str(arguments["pid"]),
                        "--window", str(arguments["windowId"]), "--settle", "0")
        if not result.get("ok"):
            return result
        nodes = result.get("nodes")
        # The engine caps snapshots at 800 nodes; absence/count cannot be
        # established from a capped or malformed tree.
        if (not isinstance(nodes, list) or len(nodes) >= 800
                or any(not isinstance(n, dict) for n in nodes)):
            return {"ok": False, "error": "incomplete_snapshot"}
        matches = [n for n in nodes
                   if (role is None or n.get("role") == role)
                   and query.casefold() in (str(n.get("title", "")) + " " + str(n.get("value", ""))).casefold()]
        sampled_at = time.monotonic()
        elapsed = round((sampled_at - started) * 1000)
        if timeout > 0 and sampled_at > deadline:
            return {"ok": False, "error": "expect_timeout", "expectedCount": count,
                    "count": len(matches), "query": query, "ms": elapsed}
        if len(matches) == count:
            return {"ok": True, "action": "expect", "count": count,
                    "query": query, "ms": elapsed,
                    "refs": [n.get("ref") for n in matches]}
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return {"ok": False, "error": "expect_failed", "expectedCount": count,
                    "count": len(matches), "query": query, "ms": elapsed}
        time.sleep(min(0.05, remaining))


def call_tool(name: str, arguments: dict) -> dict:
    label = ACTIVITY_LABELS.get(name)
    if label:
        set_activity(label)
    if name == "list_apps":
        result = run_cu("apps")
        return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                "isError": not result.get("ok", False)}

    if name == "launch_app":
        result = run_cu("launch", "--app", str(arguments["app"]))
        return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                "isError": not result.get("ok", False)}

    if name == "snapshot":
        pid = int(arguments["pid"])
        # A full tree is the baseline refs come from, so it must be settled; a
        # diff is just an observation and can take a single walk.
        full = bool(arguments.get("full"))
        args = ["snapshot", "--pid", str(pid), "--settle", "250" if full else "0"]
        if arguments.get("windowId"):
            args += ["--window", str(int(arguments["windowId"]))]
        if arguments.get("all"):
            args.append("--all")
        result = run_cu(*args)
        if not result.get("ok"):
            return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                    "isError": True}
        previous = snapshot_for(pid, int(arguments["windowId"]) if arguments.get("windowId") else None)
        result["windowId"] = int(arguments["windowId"]) if arguments.get("windowId") else None
        store_snapshot(pid, result["windowId"], result)
        if full or not previous or previous.get("version") != result.get("version"):
            return {"content": [{"type": "text", "text": render_snapshot(result)}]}
        text, use_full = render_diff(previous, result)
        if use_full:
            return {"content": [{"type": "text", "text": "full tree (the diff was larger than the tree)\n"
                                 + render_snapshot(result)}]}
        return {"content": [{"type": "text", "text": text}]}

    if name == "select_text":
        context = ref_context(str(arguments["ref"]), arguments.get("pid"))
        if isinstance(context, dict):
            return {"content": [{"type": "text", "text": json.dumps(context)}], "isError": True}
        pid, role, title, scope = context
        args = ["selecttext", "--pid", str(pid), "--ref", str(arguments["ref"]),
                "--text", str(arguments["text"]), "--role", role]
        if scope is not None:
            args += ["--window", str(int(scope))]
        if title:
            args += ["--title", title]
        if arguments.get("prefix"):
            args += ["--prefix", str(arguments["prefix"])]
        if arguments.get("suffix"):
            args += ["--suffix", str(arguments["suffix"])]
        if arguments.get("selection"):
            args += ["--selection", str(arguments["selection"])]
        result = run_cu(*args)
        indicate_success(result, pid)
        return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                "isError": not result.get("ok", False)}

    if name == "double_click":
        forwarded = dict(arguments)
        forwarded["count"] = 2
        return call_tool("click", forwarded)

    if name == "set_value":
        context = ref_context(str(arguments["ref"]), arguments.get("pid"))
        if isinstance(context, dict):
            return {"content": [{"type": "text", "text": json.dumps(context)}], "isError": True}
        pid, role, title, scope = context
        args = ["setvalue", "--pid", str(pid), "--ref", str(arguments["ref"]),
                "--text", str(arguments["text"]), "--role", role]
        if scope is not None:
            args += ["--window", str(int(scope))]
        if title:
            args += ["--title", title]
        result = run_cu(*args)
        indicate_success(result, pid)
        return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                "isError": not result.get("ok", False)}

    if name == "perform_action":
        context = ref_context(str(arguments["ref"]), arguments.get("pid"))
        if isinstance(context, dict):
            return {"content": [{"type": "text", "text": json.dumps(context)}], "isError": True}
        pid, role, title, scope = context
        args = ["action", "--pid", str(pid), "--ref", str(arguments["ref"]),
                "--name", str(arguments["name"]), "--role", role]
        if scope is not None:
            args += ["--window", str(int(scope))]
        if title:
            args += ["--title", title]
        result = run_cu(*args)
        indicate_success(result, pid)
        return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                "isError": not result.get("ok", False)}

    if name == "expect":
        if "count" in arguments:
            result = expect_count(arguments)
            return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                    "isError": not result.get("ok", False)}
        args = ["expect", "--pid", str(int(arguments["pid"]))]
        if arguments.get("ref"):
            args += ["--ref", str(arguments["ref"])]
        if arguments.get("query"):
            args += ["--find", str(arguments["query"])]
        if arguments.get("windowId"):
            args += ["--window", str(int(arguments["windowId"]))]
        if isinstance(arguments.get("enabled"), bool):
            args += ["--enabled", "true" if arguments["enabled"] else "false"]
        if arguments.get("value") is not None:
            args += ["--value", str(arguments["value"])]
        if arguments.get("contains") is not None:
            args += ["--contains", str(arguments["contains"])]
        if arguments.get("timeoutMs"):
            args += ["--timeout", str(int(arguments["timeoutMs"]))]
        result = run_cu(*args)
        return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                "isError": not result.get("ok", False)}

    if name == "paste_text":
        args = ["paste", "--text", str(arguments["text"])]
        if arguments.get("format"):
            args += ["--format", str(arguments["format"])]
        if arguments.get("ref"):
            args += ["--ref", str(arguments["ref"])]
        if arguments.get("pid"):
            args += ["--pid", str(int(arguments["pid"]))]
            auto_halo(int(arguments["pid"]))
            if not arguments.get("foreground"):
                args.append("--background")
        if arguments.get("tryOffstage"):
            args.append("--try-offstage")
        result = run_cu(*args)
        return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                "isError": not result.get("ok", False)}

    if name == "list_windows":
        listing = dict(windows_listing())
        needle = (arguments.get("app") or "").lower()
        if needle and listing.get("ok"):
            listing["windows"] = [w for w in listing.get("windows", [])
                                  if needle in (w.get("app") or "").lower()]
            listing["count"] = len(listing["windows"])
        return {"content": [{"type": "text", "text": json.dumps(listing, ensure_ascii=False)}],
                "isError": not listing.get("ok", False)}

    if name == "screenshot":
        limit = arguments.get("maxDimension", _config_number("screenshotMaxDimension", 1600))
        extra: list[str] = []
        region = arguments.get("region")
        if region:
            try:
                if isinstance(region, dict):
                    rect = [float(region[key]) for key in ("x", "y", "width", "height")]
                else:
                    rect = [float(part) for part in
                            str(region).replace("x", ",").replace(" ", ",").split(",") if part]
                if len(rect) != 4:
                    raise ValueError("need x, y, width, height")
                extra += ["--region", ",".join(f"{value:g}" for value in rect)]
            except (KeyError, TypeError, ValueError) as error:
                return {"content": [{"type": "text", "text": json.dumps(
                    {"ok": False, "error": "bad_region",
                     "message": f"region needs x, y, width, height in points: {error}"})}],
                    "isError": True}
        fmt = str(arguments.get("format") or "png").lower()
        if fmt in ("jpeg", "jpg"):
            extra += ["--format", "jpeg"]
            if arguments.get("quality"):
                extra += ["--quality", str(float(arguments["quality"]))]
        if arguments.get("screen"):
            args = ["shot", "--screen", "--max-dim", str(int(limit))] + extra
            if "display" in arguments:
                args += ["--display", str(int(arguments["display"]))]
            shot = run_cu(*args)
        elif "windowId" in arguments:
            shot = run_cu("shot", "--window", str(int(arguments["windowId"])),
                          "--max-dim", str(int(limit)), *extra)
        else:
            return {"content": [{"type": "text", "text": json.dumps(
                {"ok": False, "error": "missing_target", "message": "pass windowId or screen: true"})}],
                "isError": True}
        if shot.get("ok") and shot.get("base64"):
            meta = {k: shot[k] for k in ("windowId", "screen", "origin", "size", "scale",
                                         "bytes") if k in shot}
            content = [
                {"type": "image", "data": shot["base64"], "mimeType": shot.get("mimeType", "image/png")},
                {"type": "text", "text": json.dumps(meta)},
            ]
            return {"content": content}
        return {"content": [{"type": "text", "text": json.dumps(shot, ensure_ascii=False)}], "isError": True}

    if name == "activate_window":
        result = run_cu("activate", "--window", str(int(arguments["windowId"])))
        return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                "isError": not result.get("ok", False)}

    if name == "ax_find":
        pid = arguments.get("pid")
        if not pid and arguments.get("windowId"):
            pid = window_pid(int(arguments["windowId"]))
        if not pid:
            return {"content": [{"type": "text", "text": json.dumps(
                {"ok": False, "error": "no_pid", "message": "pass windowId or pid"})}], "isError": True}
        args = ["ax", "--pid", str(int(pid)), "--find", str(arguments["query"])]
        if arguments.get("windowId"):
            args += ["--window", str(int(arguments["windowId"]))]
        if arguments.get("all"):
            args.append("--all")
        found = run_cu(*args)
        return {"content": [{"type": "text", "text": json.dumps(found, ensure_ascii=False)}],
                "isError": not found.get("ok", False)}

    if name == "import_media":
        window_id = arguments.get("windowId")
        pid = arguments.get("pid")
        if window_id and not pid:
            pid = window_pid(int(window_id))
        if pid and not window_id:
            listing = windows_listing()
            chosen = next((w for w in listing.get("windows", [])
                           if int(w.get("pid", 0)) == int(pid)
                           and w.get("windowId") and not w.get("axOnly")), None)
            if chosen:
                window_id = chosen["windowId"]
        if not pid or not window_id:
            payload = {"ok": False, "error": "no_target",
                       "message": "pass windowId (or pid) of the app whose import panel to drive"}
            return {"content": [{"type": "text", "text": json.dumps(payload)}], "isError": True}
        auto_halo(int(pid))
        flow = ImportFlow(
            ImportRunner(),
            panel_query=str(arguments.get("panelQuery") or IMPORT_PANEL_QUERY),
            verify_query=str(arguments.get("verifyQuery") or IMPORT_ITEM_PREFIX),
            item_timeout=float(arguments.get("itemTimeoutMs", 12000)) / 1000.0)
        try:
            outcome = flow.run(
                int(pid), int(window_id), arguments.get("paths") or [],
                dry_run=bool(arguments.get("dryRun")),
                timeout_s=float(arguments.get("timeoutMs", 600000)) / 1000.0)
        except ImportFlowError as error:
            payload = error.as_dict()
            payload.update({"pid": int(pid), "windowId": int(window_id)})
        else:
            payload = {"pid": int(pid), "windowId": int(window_id)}
            payload.update(outcome)
        return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}],
                "isError": not payload.get("ok", False)}

    if name == "start_session":
        window_id = int(arguments["windowId"])
        for process in SESSIONS.pop(window_id, []):
            process.terminate()
        run_cu("resume")
        label = str(arguments.get("label") or "")
        halo = ["halo", "--window", str(window_id)]
        if label:
            halo += ["--label", label]
        processes = [spawn_detached(halo)]
        if arguments.get("cover"):
            cover = ["cover", "--window", str(window_id)]
            if label:
                cover += ["--label", label]
            processes.append(spawn_detached(cover))
        SESSIONS[window_id] = processes
        return {"content": [{"type": "text", "text": json.dumps(
            {"ok": True, "session": "started", "windowId": window_id,
             "cover": bool(arguments.get("cover"))})}]}

    if name == "stop_session":
        windows = list(SESSIONS)
        for processes in SESSIONS.values():
            for process in processes:
                process.terminate()
        SESSIONS.clear()
        killed = stop_all_halos()
        set_activity("已结束")
        run_cu("resume")
        return {"content": [{"type": "text", "text": json.dumps(
            {"ok": True, "session": "stopped", "windows": windows, "haloPids": killed})}]}

    if name == "cover_window":
        args = ["cover", "--window", str(int(arguments["windowId"]))]
        if arguments.get("label"):
            args += ["--label", str(arguments["label"])]
        if "seconds" in arguments:
            args += ["--seconds", str(arguments["seconds"])]
        spawn_detached(args)
        return {"content": [{"type": "text", "text": json.dumps(
            {"ok": True, "cover": "shown", "windowId": arguments["windowId"]})}]}

    if name == "bring_on_stage":
        result = run_cu("stage", "--window", str(int(arguments["windowId"])))
        return {"content": [{"type": "text", "text": json.dumps(result)}],
                "isError": not result.get("ok", False)}

    if name == "bring_to_current_space":
        result = run_cu("space", "--window", str(int(arguments["windowId"])))
        return {"content": [{"type": "text", "text": json.dumps(result)}],
                "isError": not result.get("ok", False)}

    if name == "resume":
        result = run_cu("resume")
        return {"content": [{"type": "text", "text": json.dumps(result)}]}

    if name == "menu":
        args = ["menu", "--pid", str(int(arguments["pid"]))]
        if arguments.get("path"):
            args += ["--path", str(arguments["path"])]
        if arguments.get("confirm"):
            args.append("--confirm")
        result = run_cu(*args)
        return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                "isError": not result.get("ok", False)}

    if name == "cursor_position":
        result = run_cu("cursor")
        return {"content": [{"type": "text", "text": json.dumps(result)}],
                "isError": not result.get("ok", False)}

    if name == "release_mouse":
        result = run_cu("release")
        return {"content": [{"type": "text", "text": json.dumps(result)}],
                "isError": not result.get("ok", False)}

    if name == "zoom_window":
        result = run_cu("zoom", "--window", str(int(arguments["windowId"])))
        return {"content": [{"type": "text", "text": json.dumps(result)}],
                "isError": not result.get("ok", False)}

    if name == "move_window":
        args = ["movewindow", "--window", str(int(arguments["windowId"]))]
        for key, flag in (("x", "--x"), ("y", "--y"), ("width", "--w"), ("height", "--h")):
            if arguments.get(key) is not None:
                args += [flag, str(arguments[key])]
        result = run_cu(*args)
        return {"content": [{"type": "text", "text": json.dumps(result)}],
                "isError": not result.get("ok", False)}

    if name == "ocr_find":
        result = find_text_boxes(arguments.get("windowId"), bool(arguments.get("screen")),
                                 str(arguments.get("query") or ""),
                                 bool(arguments.get("exact")),
                                 int(arguments.get("maxDimension", 1600)))
        if result.get("ok"):
            if "matches" in result:
                result["matches"] = result["matches"][:20]
            if "lines" in result:
                result["lines"] = result["lines"][: int(arguments.get("limit", 60))]
        return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                "isError": not result.get("ok", False)}

    if name == "click_text":
        query = str(arguments["query"])
        # Native controls first: one engine call walks the window once, matches
        # the control and AXPresses it — no coordinates, no OCR, no focus change.
        if arguments.get("windowId"):
            fast = ["clicktext", "--window", str(int(arguments["windowId"])), "--text", query]
            if arguments.get("exact"):
                fast.append("--exact")
            if arguments.get("index") is not None:
                fast += ["--index", str(int(arguments["index"]))]
            ax = run_cu(*fast)
            if ax.get("ok"):
                payload = {"ok": True, "query": query, "text": ax.get("title") or query,
                           "via": ax.get("via"), "source": "ax",
                           "ref": ax.get("ref"), "role": ax.get("role"),
                           "matches": ax.get("matches"), "axMs": ax.get("ms")}
                return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}]}
            if ax.get("error") not in ("text_not_found", "index_out_of_range", "no_frame"):
                return {"content": [{"type": "text", "text": json.dumps(ax, ensure_ascii=False)}],
                        "isError": True}
        found = find_text_boxes(arguments.get("windowId"), bool(arguments.get("screen")),
                                query, bool(arguments.get("exact")),
                                int(arguments.get("maxDimension", 1600)))
        if not found.get("ok"):
            return {"content": [{"type": "text", "text": json.dumps(found, ensure_ascii=False)}],
                    "isError": True}
        matches = found.get("matches", [])
        if arguments.get("exact"):
            needle = query.strip().lower()
            matches = [m for m in matches if (m.get("text") or "").strip().lower() == needle]
        if not matches:
            visible = [line.get("text") for line in found.get("lines", [])][:20]
            return {"content": [{"type": "text", "text": json.dumps(
                {"ok": False, "error": "text_not_found", "query": query,
                 "ms": found.get("ms"), "source": found.get("source"),
                 "visible": visible}, ensure_ascii=False)}], "isError": True}
        if len(matches) > 1 and "index" not in arguments:
            return {"content": [{"type": "text", "text": json.dumps(
                {"ok": False, "error": "ambiguous_text", "query": query,
                 "matches": matches[:10]}, ensure_ascii=False)}], "isError": True}
        pick = matches[int(arguments.get("index", 0))] if arguments.get("index") is not None else matches[0]
        click_args = ["click", "--x", str(pick["cx"]), "--y", str(pick["cy"]), "--background"]
        if arguments.get("windowId"):
            click_args += ["--window", str(int(arguments["windowId"]))]
        clicked = run_cu(*click_args)
        payload = {"ok": bool(clicked.get("ok")), "query": query,
                   "text": pick.get("text"), "x": pick.get("cx"), "y": pick.get("cy"),
                   "confidence": pick.get("confidence"),
                   "ocrMs": found.get("ms"), "source": found.get("source"),
                   "via": clicked.get("via"),
                   "frontmostAfter": clicked.get("frontmostAfter")}
        if arguments.get("verify"):
            time.sleep(0.35)
            after = find_text_boxes(arguments.get("windowId"), bool(arguments.get("screen")),
                                    query, bool(arguments.get("exact")),
                                    int(arguments.get("maxDimension", 1600)))
            still = [m for m in after.get("matches", []) if (m.get("text") or "") == pick.get("text")]
            payload["verify"] = {"stillVisible": bool(still), "ocrMs": after.get("ms"),
                                 "source": after.get("source")}
        return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}],
                "isError": not clicked.get("ok", False)}

    if name == "read_text":
        result = find_text_boxes(arguments.get("windowId"), bool(arguments.get("screen")),
                                 "", False, int(arguments.get("maxDimension", 1600)))
        if result.get("ok"):
            result["lines"] = result.get("lines", [])[: int(arguments.get("limit", 80))]
        return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                "isError": not result.get("ok", False)}

    if name == "selfcheck":
        result = run_cu("selfcheck")
        return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                "isError": not result.get("ok", False)}

    if name == "guards":
        result = run_cu("guards")
        return {"content": [{"type": "text", "text": json.dumps(result)}],
                "isError": not result.get("ok", False)}

    if name == "batch":
        if BATCHING[0]:
            return {"content": [{"type": "text", "text": json.dumps(
                {"ok": False, "error": "nested_batch", "message": "batch cannot call itself"})}],
                "isError": True}
        steps = arguments.get("steps")
        budget = arguments.get("timeoutMs")
        schemas = {tool["name"]: tool["inputSchema"] for tool in TOOLS}
        validation = None
        if not isinstance(steps, list) or len(steps) > 100:
            validation = "steps must be an array of at most 100 tool calls"
        elif budget is not None and (type(budget) is not int or not 1 <= budget <= 600000):
            validation = "timeoutMs must be an integer between 1 and 600000"
        else:
            for index, step in enumerate(steps, 1):
                if not isinstance(step, dict) or not isinstance(step.get("tool"), str):
                    validation = f"step {index}: expected a tool call object"
                    break
                tool, params = step["tool"], step.get("arguments", {})
                if tool == "batch" or tool not in schemas:
                    validation = f"step {index}: unknown or nested tool"
                    break
                if not isinstance(params, dict) or not set(schemas[tool].get("required", [])) <= params.keys():
                    validation = f"step {index}: invalid arguments or missing required fields"
                    break
                kinds = {"integer": (int,), "number": (int, float), "string": (str,),
                         "boolean": (bool,), "object": (dict,), "array": (list,)}
                properties = schemas[tool].get("properties", {})
                if any(key in properties and type(value) not in kinds.get(properties[key].get("type"), (type(value),))
                       for key, value in params.items()):
                    validation = f"step {index}: argument type does not match tool schema"
                    break
                if tool == "expect" and "count" in params and count_expectation_error(params):
                    validation = f"step {index}: invalid count expectation"
                    break
        if validation:
            return {"content": [{"type": "text", "text": json.dumps(
                {"ok": False, "error": "invalid_batch", "message": validation})}], "isError": True}
        BATCHING[0] = True
        lines, failed, images, timings = [], False, [], []
        stop = arguments.get("stopOnError", True)
        started = time.monotonic()
        deadline = started + budget / 1000 if budget is not None else None
        error = None
        try:
            for index, step in enumerate(steps, 1):
                if deadline is not None and time.monotonic() >= deadline:
                    failed, error = True, "batch_timeout"
                    break
                tool = step["tool"]
                step_arguments = dict(step.get("arguments", {}))
                step_started = time.monotonic()
                if tool == "expect" and deadline is not None:
                    remaining_ms = max(1, int((deadline - step_started) * 1000))
                    requested_ms = step_arguments.get("timeoutMs", 2000)
                    if type(requested_ms) is int and requested_ms >= 0:
                        step_arguments["timeoutMs"] = min(requested_ms, remaining_ms)
                try:
                    result = call_tool(tool, step_arguments)
                    if tool in OBSERVABLE:
                        if deadline is not None and time.monotonic() >= deadline:
                            failed, error = True, "batch_timeout"
                        else:
                            result = observe_after(step_arguments, result)
                    body = result.get("content") or []
                    text = next((item.get("text", "") for item in body
                                 if item.get("type") == "text"), "")
                    ok = not result.get("isError", False)
                    shots = [item for item in body if item.get("type") == "image"]
                except Exception:
                    # The input may already have reached the app. Preserve earlier
                    # evidence and stop even when stopOnError is false; never replay.
                    text, shots, ok = "tool raised; outcome unknown, not retried", [], False
                    error = "batch_result_unknown"
                duration = round((time.monotonic() - step_started) * 1000)
                timings.append({"index": index, "tool": tool, "ok": ok, "ms": duration})
                mark = "" if not shots else f"  [image {len(images) + 1}]"
                lines.append(f"{index}. {'ok ' if ok else 'ERR'} {tool}: {text[:300]}{mark}")
                images.extend(shots)
                failed = failed or not ok
                if deadline is not None and time.monotonic() >= deadline and error is None:
                    failed, error = True, "batch_timeout"
                if error is not None or (not ok and stop):
                    break
        finally:
            BATCHING[0] = False
        summary = {"ok": not failed, "steps": timings,
                   "elapsedMs": round((time.monotonic() - started) * 1000)}
        if error:
            summary["error"] = error
            lines.append(f"ERR {error}: stopped; earlier actions were not rolled back")
        return {"content": [{"type": "text", "text": "\n".join(lines)}] + images,
                "structuredContent": summary, "isError": failed}

    if name == "click":
        if "ref" in arguments:
            context = ref_context(str(arguments["ref"]), arguments.get("pid"))
            if isinstance(context, dict):
                return {"content": [{"type": "text", "text": json.dumps(context)}], "isError": True}
            pid, role, title, scope = context
            args = ["click", "--pid", str(pid), "--ref", str(arguments["ref"]), "--role", role]
            if title:
                args += ["--title", title]
            if scope:
                args += ["--window", str(int(scope))]
            if arguments.get("button"):
                args += ["--button", str(arguments["button"])]
            if arguments.get("count"):
                args += ["--count", str(int(arguments["count"]))]
            if arguments.get("phantom", True):
                args.append("--phantom")
            if not arguments.get("foreground"):
                args.append("--background")
            if arguments.get("dryRun"):
                args.append("--dry-run")
            result = run_cu(*args)
            indicate_success(result, pid, dry_run=arguments.get("dryRun", False))
            return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                    "isError": not result.get("ok", False)}
        if "x" not in arguments or "y" not in arguments:
            return {"content": [{"type": "text", "text": json.dumps(
                {"ok": False, "error": "missing_target", "message": "pass ref, or x and y"})}],
                "isError": True}
        args = ["click", "--x", str(arguments["x"]), "--y", str(arguments["y"]),
                "--button", arguments.get("button", "left"),
                "--count", str(int(arguments.get("count", 1)))]
        # A coordinate click means the spot on screen a person would click: the
        # app under the point (or the named pid) comes forward and then the
        # click is posted for real. background: true keeps the old pid-targeted
        # behaviour, which never takes focus but only works on apps that accept
        # events they did not ask for.
        if arguments.get("background") and not arguments.get("foreground"):
            args.append("--background")
        if "pid" in arguments:
            args += ["--pid", str(int(arguments["pid"]))]
        if "windowId" in arguments:
            args += ["--window", str(int(arguments["windowId"]))]
            if arguments.get("force"):
                args.append("--force")
        if arguments.get("phantom", True):
            args.append("--phantom")
        if arguments.get("dryRun"):
            args.append("--dry-run")
        target = indicator_target(window_id=arguments.get("windowId"), pid=arguments.get("pid"),
                                  point=(arguments["x"], arguments["y"]))
        result = run_cu(*args)
        indicate_success(result, target, dry_run=arguments.get("dryRun", False))
        return {"content": [{"type": "text", "text": json.dumps(result)}], "isError": not result.get("ok", False)}

    if name == "type_text":
        args = ["type", "--text", str(arguments["text"])]
        if arguments.get("ref"):
            args += ["--ref", str(arguments["ref"])]
        if arguments.get("pid"):
            args += ["--pid", str(int(arguments["pid"]))]
            auto_halo(int(arguments["pid"]))
        if arguments.get("pid") and not arguments.get("foreground"):
            args.append("--background")
        if arguments.get("tryOffstage"):
            args.append("--try-offstage")
        result = run_cu(*args)
        return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                "isError": not result.get("ok", False)}

    if name == "press_key":
        args = ["key", "--name", str(arguments["name"])]
        if arguments.get("mods"):
            args += ["--mods", str(arguments["mods"])]
        if arguments.get("windowId"):
            args += ["--window", str(int(arguments["windowId"]))]
            target = pid_for_window(int(arguments["windowId"]))
            if target:
                auto_halo(target)
        elif arguments.get("pid"):
            args += ["--pid", str(int(arguments["pid"]))]
            auto_halo(int(arguments["pid"]))
        if (arguments.get("windowId") or arguments.get("pid")) and not arguments.get("foreground"):
            args.append("--background")
        if arguments.get("tryOffstage"):
            args.append("--try-offstage")
        result = run_cu(*args)
        return {"content": [{"type": "text", "text": json.dumps(result)}], "isError": not result.get("ok", False)}

    if name == "scroll":
        args = ["scroll", "--dy", str(arguments["dy"])]
        if "dx" in arguments:
            args += ["--dx", str(arguments["dx"])]
        target = None
        if "x" in arguments and "y" in arguments:
            args += ["--x", str(arguments["x"]), "--y", str(arguments["y"])]
            target = indicator_target(point=(arguments["x"], arguments["y"]))
        result = run_cu(*args)
        indicate_success(result, target)
        return {"content": [{"type": "text", "text": json.dumps(result)}], "isError": not result.get("ok", False)}

    if name == "drag":
        start, end = arguments["from"], arguments["to"]
        args = ["drag", "--from", f"{start['x']},{start['y']}", "--to", f"{end['x']},{end['y']}"]
        if arguments.get("windowId"):
            args += ["--window", str(int(arguments["windowId"]))]
        if arguments.get("pid"):
            args += ["--pid", str(int(arguments["pid"]))]
        if (arguments.get("windowId") or arguments.get("pid")) and not arguments.get("foreground"):
            args.append("--background")
        target = indicator_target(window_id=arguments.get("windowId"),
                                  pid=arguments.get("pid") if not arguments.get("foreground") else None,
                                  point=(start["x"], start["y"]))
        result = run_cu(*args)
        indicate_success(result, target)
        return {"content": [{"type": "text", "text": json.dumps(result)}], "isError": not result.get("ok", False)}

    if name == "highlight_window":
        args = ["halo", "--window", str(int(arguments["windowId"]))]
        if "seconds" in arguments:
            args += ["--seconds", str(arguments["seconds"])]
        if arguments.get("label"):
            args += ["--label", str(arguments["label"])]
        try:
            subprocess.Popen([str(CU), *args], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
        except OSError as error:
            return {"content": [{"type": "text", "text": json.dumps(
                {"ok": False, "error": "spawn_failed", "message": str(error)})}], "isError": True}
        return {"content": [{"type": "text", "text": json.dumps(
            {"ok": True, "halo": "shown", "windowId": arguments["windowId"]})}]}

    return {"content": [{"type": "text", "text": json.dumps(
        {"ok": False, "error": "unknown_tool", "message": name})}], "isError": True}


def reply(message_id, result=None, error=None) -> None:
    payload = {"jsonrpc": "2.0", "id": message_id}
    if error is not None:
        payload["error"] = error
    else:
        payload["result"] = result
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def schema_hash(tools: list[dict]) -> str:
    encoded = json.dumps(tools, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


SCHEMA_HASH = schema_hash(TOOLS)


def proxy_version() -> str:
    # Hash code loaded in this process, not a possibly newer file on disk.
    digest = hashlib.sha256()
    for name, value in sorted(globals().items()):
        if isinstance(value, types.FunctionType) and value.__module__ == __name__:
            digest.update(name.encode())
            digest.update(marshal.dumps(value.__code__))
    digest.update(json.dumps(TOOLS, ensure_ascii=False, sort_keys=True).encode())
    return digest.hexdigest()


PROXY_BUILD_ID = proxy_version()


def main() -> int:
    announce_client()
    # Keep the record after exit (marked closed) so the console can still show that
    # this app connected; the engine prunes records that have been dead for hours.
    atexit.register(mark_closed)
    atexit.register(finish_indicators)
    global INDICATOR_TIMER
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            reply(None, error={"code": -32700, "message": "parse error"})
            continue
        method = message.get("method")
        message_id = message.get("id")
        if method == "initialize":
            CLIENT["initializedAt"] = time.time()
            CLIENT["protocol"] = (message.get("params") or {}).get("protocolVersion", "")
            CLIENT["clientInfo"] = ((message.get("params") or {}).get("clientInfo") or {})
            announce_client()
            reply(message_id, {
                "protocolVersion": PROTOCOL,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "cu-standalone", "version": "0.1.0+" + PROXY_BUILD_ID[:12]},
                "instructions": "Tool schema SHA-256: " + SCHEMA_HASH,
            })
        elif method in ("notifications/initialized", "initialized"):
            announce_client()
            continue
        elif method == "tools/list":
            CLIENT["toolsListedAt"] = time.time()
            announce_client()
            reply(message_id, {"tools": TOOLS})
        elif method == "tools/call":
            params = message.get("params") or {}
            started = time.monotonic()
            name = params.get("name", "")
            arguments = params.get("arguments") or {}
            if INDICATOR_TIMER is not None:
                INDICATOR_TIMER.cancel()
                INDICATOR_TIMER.join()
            try:
                result = call_tool(name, arguments)
                if name in OBSERVABLE:
                    result = observe_after(arguments, result)
            finally:
                # Brief grace period avoids flashing between consecutive actions.
                # Idle clients must not leave an "operating" pill up for 15 minutes.
                INDICATOR_TIMER = threading.Timer(2.0, stop_owned_indicators)
                INDICATOR_TIMER.daemon = True
                INDICATOR_TIMER.start()
            reply(message_id, result)
            record_call(name, time.monotonic() - started, result)
        elif method == "ping":
            reply(message_id, {})
        elif message_id is not None:
            reply(message_id, error={"code": -32601, "message": f"no such method: {method}"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
