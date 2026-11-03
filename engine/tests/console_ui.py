#!/usr/bin/env python3
"""Console UI regression test: machine-checkable hooks of the menu-bar console.

Drives the one-shot hooks of the installed app (or engine/bin/cu when the app is
not installed) and asserts the control panel's structure, rendered sizes and
focus discipline:

  * `menubar --selftest-ui`     -> JSON assertions (pages, rows, menu, MCP config)
  * `menubar --snapshot-console <png> --snapshot-page <page>` -> 1040x1560 PNG
  * `menubar --snapshot-guide <png>` -> 720x300 PNG

The hooks are one-shot helpers: they skip the menu-bar single-instance lock and
must leave a running menu-bar app and the user's focus alone. This test checks
both, so a regression in the hooks fails here.

No config/permission/service state is changed: only PNGs are written (to a temp
dir) and no UI control is pressed. Run it directly (`python3 tests/console_ui.py`)
or through `tests/run_all.sh` (full section).

Env: CU_CONSOLE_UI_BIN overrides the binary under test.
Exit code 0 = all checks pass; 1 = at least one assertion failed.
"""
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time

ENGINE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INSTALLED_BIN = "/Applications/Computer Use.app/Contents/MacOS/Computer Use"

SELFTEST_PAGES = ["overview", "connections", "settings", "diagnostics", "agentSetup"]
SNAPSHOT_PAGES = ["overview", "connections", "settings", "diagnostics", "agent-setup"]
CONSOLE_SIZE = (1040, 1560)   # 520x780 @2x
GUIDE_SIZE = (720, 344)       # 360x172 @2x
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def fail(message):
    raise AssertionError(message)


def check(condition, message):
    if not condition:
        fail(message)


def run_json(binary, args, timeout=90):
    """Run a hook, require exit 0, and parse its stdout as JSON."""
    proc = subprocess.run([binary] + args, capture_output=True, text=True, timeout=timeout)
    label = " ".join(args)
    check(proc.returncode == 0,
          "%s: exit %d (stderr: %s)" % (label, proc.returncode, proc.stderr.strip()[:400]))
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as error:
        fail("%s: stdout is not JSON (%s): %r" % (label, error, proc.stdout[:400]))


def png_size(path):
    """Return (width, height) from a PNG's IHDR; fail if the file is not a PNG."""
    check(os.path.isfile(path), "missing PNG: %s" % path)
    with open(path, "rb") as handle:
        head = handle.read(33)
    check(head[:8] == PNG_MAGIC, "not a PNG: %s" % path)
    return struct.unpack(">II", head[16:24])


def check_png(path, expected):
    """Assert a non-blank PNG of the expected @2x pixel size."""
    size = os.path.getsize(path)
    width, height = png_size(path)
    check((width, height) == expected,
          "%s: %dx%d, expected %dx%d" % (os.path.basename(path), width, height,
                                         expected[0], expected[1]))
    # A blank 1040x1560 PNG compresses to a few KB; real renders are >= 100 KB.
    check(size > 20_000, "%s: only %d bytes, likely blank" % (os.path.basename(path), size))
    return size


def frontmost(binary):
    report = run_json(binary, ["frontmost"], timeout=15)
    check(report.get("ok") is True, "frontmost: ok=false")
    return report


def wait_frontmost_away_from(binary, timeout=2.0):
    """After a one-shot hook exits, the console must not hold the user's focus."""
    deadline = time.time() + timeout
    report = frontmost(binary)
    while report.get("app") == "Computer Use" and time.time() < deadline:
        time.sleep(0.1)
        report = frontmost(binary)
    return report


def console_windows(binary):
    report = run_json(binary, ["windows"], timeout=20)
    return [window for window in report.get("windows", [])
            if window.get("app") in ("Computer Use", "DSH Super Computer Use")]


def running_menu_bar_pids():
    """Pids of the launchd menu-bar instance (`... app --quiet`), if any.

    One-shot hooks run the same binary with `menubar ...`; matching the `app
    --quiet` argv keeps the check strictly about the live menu-bar instance.
    """
    try:
        proc = subprocess.run(
            ["/usr/bin/pgrep", "-f", r"Computer Use\.app/Contents/MacOS/Computer Use app --quiet"],
            capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return []
    return [int(line) for line in proc.stdout.split() if line.isdigit()]


def pid_alive(pid):
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def test_selftest(binary):
    """Structural assertions from `--selftest-ui` (the JSON is the contract)."""
    before = frontmost(binary)
    report = run_json(binary, ["menubar", "--selftest-ui"])

    check(report.get("ok") is True, "selftest: ok is not true")
    check(report.get("pages") == SELFTEST_PAGES,
          "selftest: pages=%r, expected %r" % (report.get("pages"), SELFTEST_PAGES))
    check(report.get("pageCount") == 5, "selftest: pageCount=%r" % report.get("pageCount"))
    check(report.get("permissionRows") == 2, "selftest: permissionRows=%r" % report.get("permissionRows"))
    check(isinstance(report.get("agentRows"), int) and report["agentRows"] >= 1,
          "selftest: agentRows=%r" % report.get("agentRows"))
    check(report.get("windowBorderless") is True, "selftest: windowBorderless=%r" % report.get("windowBorderless"))
    check(report.get("windowWidth") == 520, "selftest: windowWidth=%r" % report.get("windowWidth"))
    check(report.get("windowHeight") == 780, "selftest: windowHeight=%r" % report.get("windowHeight"))
    check(report.get("windowVisible") is False, "selftest: selftest left a visible window")
    check(report.get("configurationContainsMCPServers") is True,
          "selftest: MCP page text does not contain mcpServers")
    for key in ("menuCopyConfiguration", "menuResetPermissions", "menuAgentSetup"):
        check(report.get(key) is True, "selftest: %s=%r" % (key, report.get(key)))

    configuration = report.get("configuration")
    check(isinstance(configuration, str) and configuration.strip(), "selftest: configuration missing")
    try:
        parsed = json.loads(configuration)
    except json.JSONDecodeError as error:
        fail("selftest: configuration is not JSON (%s)" % error)
    servers = parsed.get("mcpServers")
    check(isinstance(servers, dict) and "computer-use" in servers,
          "selftest: configuration has no mcpServers[\"computer-use\"]")
    entry = servers["computer-use"]
    check(isinstance(entry, dict) and "command" in entry and "args" in entry,
          "selftest: computer-use MCP entry has no command/args")

    # selftest must not take focus or leave a window behind
    after = wait_frontmost_away_from(binary)
    check(after.get("app") != "Computer Use",
          "selftest left the Computer Use process frontmost")
    check(not console_windows(binary), "selftest left a console window on screen")
    print("PASS selftest: %d pages, %d agent rows, menu + MCP config present, "
          "borderless %dx%d, focus kept (%s -> %s)"
          % (report["pageCount"], report["agentRows"], report["windowWidth"],
             report["windowHeight"], before.get("app"), after.get("app")))


def test_snapshots(binary, workdir):
    """Every page renders a 1040x1560 PNG and gives focus back."""
    rows = []
    for page in SNAPSHOT_PAGES:
        before = frontmost(binary)
        path = os.path.join(workdir, "console-%s.png" % page)
        report = run_json(binary, ["menubar", "--snapshot-console", path,
                                   "--snapshot-page", page])
        check(report.get("ok") is True, "%s: snapshot ok=false: %r" % (page, report))
        check(os.path.abspath(report.get("path", "")) == os.path.abspath(path),
              "%s: snapshot wrote %r, expected %r" % (page, report.get("path"), path))
        check(report.get("via") in ("screencapturekit", "bitmap"),
              "%s: unexpected capture path %r" % (page, report.get("via")))
        check((report.get("width"), report.get("height")) == CONSOLE_SIZE,
              "%s: reported size %rx%r" % (page, report.get("width"), report.get("height")))
        size = check_png(path, CONSOLE_SIZE)
        if report.get("via") == "screencapturekit":
            check(isinstance(report.get("windowId"), int) and report["windowId"] > 0,
                  "%s: SCK capture without a windowId" % page)
        after = wait_frontmost_away_from(binary)
        check(after.get("app") != "Computer Use",
              "%s: console snapshot left the Computer Use process frontmost" % page)
        check(not console_windows(binary), "%s: console window still on screen" % page)
        rows.append("%s=%s/%dpx" % (page, report["via"], size))
    print("PASS snapshots: %s (each %dx%d, focus kept, window closed)"
          % (", ".join(rows), CONSOLE_SIZE[0], CONSOLE_SIZE[1]))


def test_guide(binary, workdir):
    path = os.path.join(workdir, "guide.png")
    before = frontmost(binary)
    report = run_json(binary, ["menubar", "--snapshot-guide", path])
    check(report.get("ok") is True, "guide: ok=false: %r" % report)
    check(os.path.abspath(report.get("path", "")) == os.path.abspath(path),
          "guide: wrote %r, expected %r" % (report.get("path"), path))
    size = check_png(path, GUIDE_SIZE)
    after = wait_frontmost_away_from(binary)
    check(after.get("app") != "Computer Use", "guide snapshot left the Computer Use process frontmost")
    check(not console_windows(binary), "guide snapshot left a console window on screen")
    print("PASS guide: %dx%d, %d bytes, focus kept (%s -> %s)"
          % (GUIDE_SIZE[0], GUIDE_SIZE[1], size, before.get("app"), after.get("app")))


def test_menu_bar_survives(binary, menu_pids, workdir):
    """The one-shot hooks must not retire/restart the running menu-bar instance."""
    if not menu_pids:
        print("SKIP menu-bar survival: no running `app --quiet` instance on this machine")
        return
    # One more hook after the others, so this proves the whole sequence was inert.
    path = os.path.join(workdir, "console-overview-after.png")
    report = run_json(binary, ["menubar", "--snapshot-console", path,
                               "--snapshot-page", "overview"])
    check(report.get("ok") is True, "survival: extra snapshot failed")
    dead = [pid for pid in menu_pids if not pid_alive(pid)]
    check(not dead, "menu-bar instance(s) %r died while running one-shot hooks" % dead)
    print("PASS menu-bar survival: pid(s) %s still alive after all hooks"
          % ", ".join(str(pid) for pid in menu_pids))


def main():
    binary = os.environ.get("CU_CONSOLE_UI_BIN", "")
    if not binary:
        binary = INSTALLED_BIN if os.access(INSTALLED_BIN, os.X_OK) else os.path.join(ENGINE_DIR, "bin", "cu")
    if not os.access(binary, os.X_OK):
        print("SKIP console UI: no executable engine at %s (run engine/build.sh)" % binary)
        return 0
    print("console UI regression: %s" % binary)

    menu_pids = running_menu_bar_pids()
    workdir = tempfile.mkdtemp(prefix="cu-console-ui-")
    keep = "--keep" in sys.argv[1:]
    try:
        test_selftest(binary)
        test_snapshots(binary, workdir)
        test_guide(binary, workdir)
        test_menu_bar_survives(binary, menu_pids, workdir)
    finally:
        if keep:
            print("artefacts kept in %s" % workdir)
        else:
            shutil.rmtree(workdir, ignore_errors=True)
    print("console UI: all checks passed")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except AssertionError as error:
        print("FAIL console UI: %s" % error)
        sys.exit(1)
