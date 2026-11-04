#!/usr/bin/env python3
"""Native preview-stream lifecycle for the round-2 hardening.

Uses a demo window that belongs to this test (never the user's work) and drives
the real `cu preview-stream` child:

- natural `--seconds` end exits 0 after real frames;
- a closed parent stdin (--watch-parent) ends the helper;
- SIGTERM ends the helper promptly;
- an uncapturable window fails fast with window_not_capturable;
- destroying the captured window triggers SCStream didStopWithError and a
  non-zero exit instead of a stream that silently stays "live";
- no valid first frame exits 6 within the budget (best effort; a window that
  never produces frames is platform-dependent and is reported as untested if it
  cannot be constructed).

    python3 -B engine/tests/preview_stream_lifecycle.py
"""
from __future__ import annotations

import json
import os
import pathlib
import select
import signal
import struct
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
CU = ROOT / "bin" / "cu"


class Failure(Exception):
    pass


def wait_window(timeout: float = 6.0) -> dict:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        listing = subprocess.run([str(CU), "windows"], capture_output=True, text=True)
        try:
            payload = json.loads(listing.stdout)
        except json.JSONDecodeError:
            payload = {}
        last = payload
        window = next(
            (w for w in payload.get("windows", []) if w.get("title") == "cu demo window"),
            None,
        )
        if window:
            return window
        time.sleep(0.15)
    raise Failure(f"demo window did not appear: {last}")


def spawn_stream(window: int, seconds: int = 30) -> subprocess.Popen:
    return subprocess.Popen(
        [
            str(CU),
            "preview-stream",
            "--window",
            str(window),
            "--session",
            "lifecycle-test",
            "--generation",
            "1",
            "--fps",
            "10",
            "--max-dim",
            "480",
            "--seconds",
            str(seconds),
            "--watch-parent",
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def read_frame(proc: subprocess.Popen, timeout: float = 6.0) -> dict:
    """Read one length-prefixed frame from stdout, no buffering past it."""
    fd = proc.stdout.fileno()
    buffer = b""
    deadline = time.time() + timeout
    while len(buffer) < 8:
        remaining = deadline - time.time()
        if remaining <= 0:
            raise Failure(f"no frame header within {timeout}s (stderr={read_stderr(proc)!r})")
        ready, _, _ = select.select([fd], [], [], remaining)
        if not ready:
            continue
        chunk = os.read(fd, 65536)
        if not chunk:
            raise Failure(f"stream closed before a frame (stderr={read_stderr(proc)!r})")
        buffer += chunk
    meta_len, jpeg_len = struct.unpack(">II", buffer[:8])
    if not (0 < meta_len <= 16 * 1024) or not (0 < jpeg_len <= 2 * 1024 * 1024):
        raise Failure(f"invalid frame header {meta_len}/{jpeg_len}")
    total = 8 + meta_len + jpeg_len
    while len(buffer) < total:
        remaining = deadline - time.time()
        if remaining <= 0:
            raise Failure("frame body did not arrive in time")
        ready, _, _ = select.select([fd], [], [], remaining)
        if not ready:
            continue
        chunk = os.read(fd, 65536)
        if not chunk:
            raise Failure("stream closed mid-frame")
        buffer += chunk
    meta = json.loads(buffer[8 : 8 + meta_len].decode("utf-8"))
    meta["_bytes"] = total
    return meta


def read_stderr(proc: subprocess.Popen) -> str:
    try:
        fd = proc.stderr.fileno()
        ready, _, _ = select.select([fd], [], [], 0)
        if not ready:
            return ""
        return os.read(fd, 65536).decode("utf-8", "replace")
    except (ValueError, OSError):
        return ""


def wait_exit(proc: subprocess.Popen, timeout: float) -> int:
    try:
        return proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        raise Failure(f"helper did not exit within {timeout}s")


def close_stdin(proc: subprocess.Popen) -> None:
    try:
        proc.stdin.close()
    except (BrokenPipeError, ValueError):
        pass


def case_natural_end(window: int) -> dict:
    proc = spawn_stream(window, seconds=2)
    try:
        frame = read_frame(proc)
        code = wait_exit(proc, 6)
        stderr = read_stderr(proc) + (proc.stderr.read().decode("utf-8", "replace") or "")
        if code != 0:
            raise Failure(f"natural end exited {code}: {stderr[-300:]!r}")
        if "ready" not in stderr:
            raise Failure(f"no capture-ready diagnostic: {stderr[-300:]!r}")
        return {"exit": code, "firstFrameId": frame.get("frameId"), "frameBytes": frame["_bytes"]}
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=3)


def case_bad_window() -> dict:
    proc = spawn_stream(2147483000, seconds=5)
    try:
        code = wait_exit(proc, 8)
        stderr = proc.stderr.read().decode("utf-8", "replace")
        if code != 2:
            raise Failure(f"bad window exited {code}, expected 2: {stderr[-300:]!r}")
        if "window_not_capturable" not in stderr:
            raise Failure(f"bad window error missing: {stderr[-300:]!r}")
        return {"exit": code, "seconds": "fast"}
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=3)


def case_stdin_eof(window: int) -> dict:
    proc = spawn_stream(window, seconds=30)
    try:
        read_frame(proc)
        close_stdin(proc)
        code = wait_exit(proc, 4)
        if code != 0:
            raise Failure(f"stdin EOF exited {code}")
        return {"exit": code}
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=3)


def case_sigterm(window: int) -> dict:
    proc = spawn_stream(window, seconds=30)
    try:
        read_frame(proc)
        proc.send_signal(signal.SIGTERM)
        code = wait_exit(proc, 3)
        if code != 0:
            raise Failure(f"SIGTERM exited {code}")
        return {"exit": code}
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=3)


def case_capture_destroyed() -> dict:
    demo = subprocess.Popen(
        [str(CU), "demo", "--seconds", "60"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    proc = None
    try:
        window = wait_window()
        proc = spawn_stream(window["windowId"], seconds=30)
        read_frame(proc)
        demo.send_signal(signal.SIGTERM)
        demo.wait(timeout=5)
        code = wait_exit(proc, 6)
        stderr = proc.stderr.read().decode("utf-8", "replace")
        if code == 0:
            raise Failure("capture destruction exited 0; a dead capture must not look healthy")
        if "capture_stopped" not in stderr:
            raise Failure(f"capture_stopped diagnostic missing: {stderr[-400:]!r}")
        return {"exit": code, "reason": "capture_stopped"}
    finally:
        if proc is not None and proc.poll() is None:
            proc.kill()
            proc.wait(timeout=3)
        if demo.poll() is None:
            demo.kill()
            demo.wait(timeout=3)


def case_no_first_frame() -> dict:
    """A window that exists but never delivers a frame must exit 6, not hang."""
    script = (
        "import tkinter as tk\n"
        "r=tk.Tk()\n"
        "r.geometry('200x120+3000+3000')\n"
        "r.update_idletasks()\n"
        "r.after(6000, r.destroy)\n"
        "r.mainloop()\n"
    )
    holder = subprocess.Popen([sys.executable, "-c", script], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    proc = None
    try:
        listing = json.loads(subprocess.run([str(CU), "windows"], capture_output=True, text=True).stdout)
        # Tk's withdrawn/off-screen window may not be in SCShareableContent at
        # all; if we cannot identify it, say so instead of pretending.
        window = next(
            (w for w in listing.get("windows", []) if "tk" in str(w.get("app", "")).lower()),
            None,
        )
        if not window:
            return {"skipped": "no capturable no-frame window in this environment"}
        proc = spawn_stream(window["windowId"], seconds=10)
        code = wait_exit(proc, 8)
        stderr = proc.stderr.read().decode("utf-8", "replace")
        if code != 6:
            raise Failure(f"no-first-frame exited {code}, expected 6: {stderr[-300:]!r}")
        return {"exit": code, "reason": "no_first_frame"}
    finally:
        if proc is not None and proc.poll() is None:
            proc.kill()
            proc.wait(timeout=3)
        holder.kill()
        holder.wait(timeout=3)


def main() -> int:
    demo = subprocess.Popen(
        [str(CU), "demo", "--seconds", "90"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    results: dict = {}
    try:
        window = wait_window()
        results["naturalEnd"] = case_natural_end(window["windowId"])
        results["badWindow"] = case_bad_window()
        results["stdinEof"] = case_stdin_eof(window["windowId"])
        results["sigterm"] = case_sigterm(window["windowId"])
        # Only one demo window may exist: captureDestroyed must destroy the
        # window its own helper is actually capturing.
        demo.terminate()
        demo.wait(timeout=5)
        results["captureDestroyed"] = case_capture_destroyed()
        try:
            results["noFirstFrame"] = case_no_first_frame()
        except Failure as exc:
            results["noFirstFrame"] = {"failed": str(exc)}
        ok = all("failed" not in value for value in results.values())
        print(json.dumps({"ok": ok, "results": results}, ensure_ascii=False, indent=2))
        return 0 if ok else 1
    except Failure as exc:
        print(json.dumps({"ok": False, "error": str(exc), "results": results}, ensure_ascii=False, indent=2))
        return 1
    finally:
        if demo.poll() is None:
            demo.terminate()
            try:
                demo.wait(timeout=5)
            except subprocess.TimeoutExpired:
                demo.kill()


if __name__ == "__main__":
    sys.exit(main())
