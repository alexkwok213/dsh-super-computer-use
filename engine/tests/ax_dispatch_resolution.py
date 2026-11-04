"""Offscreen checks: dispatch resolves by retained elementToken, never by path.

    python3 -B engine/tests/ax_dispatch_resolution.py
"""
from __future__ import annotations
import json, pathlib, subprocess, sys, tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "Sources" / "AXIdentity.swift"

CHECK = r'''
import Foundation
func cand(_ path: String, _ token: String, title: String = "同名") -> AXCandidate {
    AXCandidate(path: path, epoch: 1, pid: 42, windowId: 7, role: "AXButton",
                title: title, containerToken: "c-list", elementToken: token,
                enabled: true, frameValid: true)
}
func tokenFor(_ c: AXCandidate) -> AXElementIdentity {
    AXElementIdentity(epoch: c.epoch, pid: c.pid, windowId: c.windowId, role: c.role,
                      title: c.title, containerToken: c.containerToken, elementToken: c.elementToken,
                      snapshotRevision: 1)
}
var f: [String] = []
func expect(_ c: Bool, _ m: String) { if !c { f.append(m) } }

let a = cand("k0.1", "A")
let b = cand("k0.2", "B")
let tokenA = tokenFor(a)

// A reorders to k0.2, B takes k0.1. Resolve must act on A (by token), never path k0.1 (which is B).
expect(resolveDispatchTarget(token: tokenA, candidates: [b, cand("k0.2", "A")]) == .dispatch(elementToken: "A"),
       "must dispatch original A even after it moved path")
// Sanity: path k0.1 now holds B; resolving by path would hit B.
expect(resolveDispatchTarget(token: tokenA, candidates: [b]) == .reject(.identityUnproven),
       "A gone -> reject, never fall back to path")

var disabled = cand("k0.2", "A"); disabled.enabled = false
expect(resolveDispatchTarget(token: tokenA, candidates: [disabled]) == .reject(.identityUnproven), "disabled -> reject")
var ep = cand("k0.2", "A"); ep.epoch = 2
expect(resolveDispatchTarget(token: tokenA, candidates: [ep]) == .reject(.epochRebuilt), "epoch -> reject")
var otherWin = cand("k0.2", "A"); otherWin.windowId = 9
expect(resolveDispatchTarget(token: tokenA, candidates: [otherWin]) == .reject(.staleTarget), "window -> stale")
var otherContainer = cand("k0.2", "A"); otherContainer.containerToken = "c-2"
expect(resolveDispatchTarget(token: tokenA, candidates: [otherContainer]) == .reject(.identityUnproven), "container -> reject")
expect(resolveDispatchTarget(token: tokenA, candidates: [cand("k0.1","A"), cand("k0.2","A")]) == .reject(.identityUnproven),
       "ambiguous duplicate token -> reject")

let out: [String: Any] = ["ok": f.isEmpty, "failures": f]
print(String(decoding: try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), as: UTF8.self))
'''

def main() -> int:
    with tempfile.TemporaryDirectory(prefix="scu-ax-dispatch-") as d:
        work = pathlib.Path(d); main_swift = work / "main.swift"; binary = work / "ax-dispatch"
        main_swift.write_text(CHECK)
        subprocess.run(["swiftc","-swift-version","5","-module-cache-path",str(work/"cache"),
                        str(SOURCE), str(main_swift), "-o", str(binary)], check=True)
        r = subprocess.run([str(binary)], capture_output=True, text=True, check=True)
    p = json.loads(r.stdout); print(json.dumps(p, ensure_ascii=False)); return 0 if p.get("ok") else 1

if __name__ == "__main__":
    sys.exit(main())
