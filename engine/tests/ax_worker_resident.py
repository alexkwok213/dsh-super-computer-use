#!/usr/bin/env python3
"""Resident AX worker (Task 8): a token minted by one observe is dispatched by a
later click IN THE SAME PROCESS, survives a re-observe, and is rejected after an
epoch invalidate. Run: python3 -B engine/tests/ax_worker_resident.py
"""
from __future__ import annotations
import json, pathlib, subprocess, sys, time
ROOT = pathlib.Path(__file__).resolve().parent.parent
CU = ROOT / "bin" / "cu"

def counter(pid, wid):
    out = subprocess.run([str(CU), "snapshot", "--pid", str(pid), "--window", str(wid)],
                         capture_output=True, text=True).stdout
    for n in json.loads(out).get("nodes", []):
        t = n.get("title") or ""
        if t.startswith("Demo Button"):
            try: return int(t.split()[-1])
            except ValueError: pass
    return -1

def send(p, obj):
    p.stdin.write(json.dumps(obj) + "\n"); p.stdin.flush()

def recv(p):
    line = p.stdout.readline()
    if not line: raise RuntimeError("worker died")
    return json.loads(line)

def main() -> int:
    demo = subprocess.Popen([str(CU), "demo", "--seconds", "60"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    worker = None
    try:
        time.sleep(1.8)
        listing = json.loads(subprocess.run([str(CU), "windows"], capture_output=True, text=True).stdout)
        w = next((x for x in listing.get("windows", []) if x.get("title") == "cu demo window"), None)
        if not w: raise RuntimeError("no demo window")
        pid, wid = w["pid"], w["windowId"]

        worker = subprocess.Popen([str(CU), "ax-worker", "--pid", str(pid), "--window", str(wid)],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        ready = recv(worker)
        if ready.get("axWorker") != "ready": raise RuntimeError(f"bad ready {ready}")

        send(worker, {"cmd": "observe"})
        obs = recv(worker)
        button = next((c for c in obs["candidates"] if str(c.get("title", "")).startswith("Demo Button")), None)
        if not button: raise RuntimeError("no Demo Button candidate")
        token = button["elementToken"]

        before = counter(pid, wid)
        send(worker, {"cmd": "click", "elementToken": token})
        click1 = recv(worker)
        after = counter(pid, wid)
        if click1.get("ok") is not True or after != before + 1:
            raise RuntimeError(f"first click wrong: {click1} {before}->{after}")

        # Re-observe mints new tokens; the ORIGINAL token must still work here.
        send(worker, {"cmd": "observe"}); recv(worker)
        send(worker, {"cmd": "click", "elementToken": token})
        click2 = recv(worker)
        after2 = counter(pid, wid)
        if click2.get("ok") is not True or after2 != after + 1:
            raise RuntimeError(f"retained token did not survive re-observe: {click2} {after}->{after2}")

        send(worker, {"cmd": "click", "elementToken": "w999-1"})
        bogus = recv(worker)
        if bogus.get("ok") is not False or bogus.get("error") != "identity_unproven":
            raise RuntimeError(f"bogus token not rejected: {bogus}")

        send(worker, {"cmd": "invalidate"}); recv(worker)
        send(worker, {"cmd": "click", "elementToken": token})
        stale = recv(worker)
        if stale.get("error") != "identity_unproven":
            raise RuntimeError(f"token not rejected after invalidate: {stale}")

        send(worker, {"cmd": "stop"}); recv(worker)
        worker.wait(timeout=5)

        print(json.dumps({"ok": True, "before": before, "after": after, "afterReobserve": after2,
                          "bogus": bogus.get("error"), "afterInvalidate": stale.get("error")}, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)); return 1
    finally:
        if worker and worker.poll() is None: worker.kill()
        demo.terminate()
        try: demo.wait(timeout=4)
        except subprocess.TimeoutExpired: demo.kill()

if __name__ == "__main__":
    sys.exit(main())
