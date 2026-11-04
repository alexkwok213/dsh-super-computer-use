"""Offscreen checks for the AX identity contract (Task 8 / F4).

    python3 -B engine/tests/ax_identity.py
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "Sources" / "AXIdentity.swift"

CHECK = r'''
import Foundation

func base() -> AXElementIdentity {
    AXElementIdentity(epoch: 1, pid: 42, windowId: 7, role: "AXButton", title: "导入",
                      containerToken: "c-list", elementToken: "ptr-0xabc", snapshotRevision: 5)
}
var failures: [String] = []
func expect(_ c: Bool, _ m: String) { if !c { failures.append(m) } }

let t = base()
expect(validateIdentity(token: t, current: base()) == .matched, "identical -> matched")

var epoch = base(); epoch.epoch = 2
expect(validateIdentity(token: t, current: epoch) == .epochRebuilt, "epoch rebuild invalidates")

var other = base(); other.pid = 99
expect(validateIdentity(token: t, current: other) == .staleTarget, "other pid -> staleTarget")
var otherWin = base(); otherWin.windowId = 8
expect(validateIdentity(token: t, current: otherWin) == .staleTarget, "other window -> staleTarget")

// Same-named control reorders: same path/title/role but a DIFFERENT retained
// object -> identity cannot be proven (the F4 bug: path+title matched).
var swapped = base(); swapped.elementToken = "ptr-0xdef"
expect(validateIdentity(token: t, current: swapped) == .identityUnproven, "different element -> unproven")

var container = base(); container.containerToken = "c-other"
expect(validateIdentity(token: t, current: container) == .identityUnproven, "container change -> unproven")

var renamed = base(); renamed.title = "导出"
expect(validateIdentity(token: t, current: renamed) == .matched, "rename of same object stays matched")

// A snapshotRevision change alone does NOT invalidate identity (it is observation only).
var reobs = base(); reobs.snapshotRevision = 99
expect(validateIdentity(token: t, current: reobs) == .matched, "revision-only change stays matched")

// A legacy token with no retained object cannot prove identity.
var legacy = base(); legacy.elementToken = ""
expect(validateIdentity(token: legacy, current: base()) == .identityUnproven, "no elementToken -> unproven")

expect(samePathImpliesIdentity("k0.3.2", "k0.3.2") == false, "same path is not identity")

let out: [String: Any] = ["ok": failures.isEmpty, "failures": failures]
let data = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
'''


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="scu-ax-identity-") as directory:
        work = pathlib.Path(directory)
        main_swift = work / "main.swift"
        binary = work / "ax-identity"
        main_swift.write_text(CHECK)
        subprocess.run(
            ["swiftc", "-swift-version", "5", "-module-cache-path", str(work / "cache"),
             str(SOURCE), str(main_swift), "-o", str(binary)],
            check=True,
        )
        result = subprocess.run([str(binary)], capture_output=True, text=True, check=True)
    payload = json.loads(result.stdout)
    print(json.dumps(payload, ensure_ascii=False))
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
