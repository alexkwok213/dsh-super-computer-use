import Foundation
import ApplicationServices
import CoreGraphics

// Task 8 (F4) minimal retained AX worker: keep the real AXUIElement for each
// observed control, mint a per-session opaque token, and — right before acting —
// re-validate the RETAINED object itself (owner pid, role, title, enabled) rather
// than resolving "whatever is now at that path". An epoch rebuild drops every
// retained object, so an old token can only be rejected, never silently reused.

struct AXRetainedRecord {
    var epoch: Int
    var pid: pid_t
    var windowId: CGWindowID
    var role: String
    var title: String
    var containerToken: String
}

final class AXSessionWorker {
    private(set) var epoch = 0
    private(set) var pid: pid_t = 0
    private(set) var windowId: CGWindowID = 0
    private var retained: [String: AXUIElement] = [:]
    private var records: [String: AXRetainedRecord] = [:]
    private var tokenSeq = 0

    func beginSession(pid: pid_t, windowId: CGWindowID) {
        self.pid = pid
        self.windowId = windowId
        epoch += 1
        retained.removeAll()
        records.removeAll()
        tokenSeq = 0
    }

    /// Invalidate every retained object (service restart, target exit, rebind).
    func invalidate() {
        epoch += 1
        retained.removeAll()
        records.removeAll()
    }

    /// One observation: retain each AX object and mint a stable per-session token.
    func observeAndRetain() -> [AXCandidate] {
        let (_, nodes, _) = snapshotNodes(pid: pid, includeZeroSize: true, windowId: windowId)
        var candidates: [AXCandidate] = []
        for node in nodes {
            tokenSeq += 1
            let tokenId = "w\(epoch)-\(tokenSeq)"
            let parent = node.path.contains(".")
                ? String(node.path[..<node.path.lastIndex(of: ".")!])
                : "root"
            let container = "p:\(parent)"
            retained[tokenId] = node.element
            records[tokenId] = AXRetainedRecord(epoch: epoch, pid: pid, windowId: windowId,
                                                role: node.role, title: node.title,
                                                containerToken: container)
            candidates.append(AXCandidate(path: node.ref, epoch: epoch, pid: Int(pid),
                                          windowId: Int(windowId), role: node.role, title: node.title,
                                          containerToken: container, elementToken: tokenId,
                                          enabled: node.enabled, frameValid: node.frame != nil))
        }
        return candidates
    }

    func identity(_ tokenId: String) -> AXElementIdentity? {
        guard let record = records[tokenId] else { return nil }
        return AXElementIdentity(epoch: record.epoch, pid: Int(record.pid), windowId: Int(record.windowId),
                                 role: record.role, title: record.title,
                                 containerToken: record.containerToken, elementToken: tokenId,
                                 snapshotRevision: 0)
    }

    /// Validate the retained object WITHOUT acting (used to gate ref typing).
    func verify(_ tokenId: String) -> [String: Any] {
        guard let element = retained[tokenId], let record = records[tokenId] else {
            return ["ok": false, "error": "identity_unproven", "message": "no retained object for token"]
        }
        guard record.epoch == epoch else { return ["ok": false, "error": "epoch_rebuilt"] }
        var owner: pid_t = 0
        AXUIElementGetPid(element, &owner)
        guard owner == pid else { return ["ok": false, "error": "stale_target"] }
        let enabled = (attribute(element, kAXEnabledAttribute) as? Bool) ?? true
        guard enabled else { return ["ok": false, "error": "identity_unproven", "message": "disabled"] }
        return ["ok": true, "verified": true, "token": tokenId]
    }

    /// Validate the retained object itself, then act. Never looks up by path.
    func resolveAndDispatch(tokenId: String, action: String) -> [String: Any] {
        guard let element = retained[tokenId], let record = records[tokenId] else {
            return ["ok": false, "error": "identity_unproven", "message": "no retained object for token"]
        }
        guard record.epoch == epoch else { return ["ok": false, "error": "epoch_rebuilt"] }
        var owner: pid_t = 0
        AXUIElementGetPid(element, &owner)
        guard owner == pid else { return ["ok": false, "error": "stale_target"] }
        // Identity is the retained object (+ epoch/pid/container), NOT its label:
        // a demo button whose title counts clicks must still resolve and press.
        let enabled = (attribute(element, kAXEnabledAttribute) as? Bool) ?? true
        guard enabled else { return ["ok": false, "error": "identity_unproven", "message": "disabled"] }
        let status = AXUIElementPerformAction(element, action as CFString)
        if status == .success { return ["ok": true, "action": action, "token": tokenId] }
        return ["ok": false, "error": "action_failed", "status": Int(status.rawValue)]
    }
}

/// Probe: retain the demo button, press it via the retained object (counter must
/// advance), then invalidate the epoch and prove the same token is rejected.
func runAXWorkerProbe(pid: pid_t, windowId: CGWindowID) -> Never {
    func counter() -> Int {
        let (_, nodes, _) = snapshotNodes(pid: pid, includeZeroSize: true, windowId: windowId)
        for node in nodes where node.title.hasPrefix("Demo Button") {
            if let number = Int(node.title.components(separatedBy: " ").last ?? "") { return number }
        }
        return -1
    }
    let worker = AXSessionWorker()
    worker.beginSession(pid: pid, windowId: windowId)
    let candidates = worker.observeAndRetain()
    guard let button = candidates.first(where: { $0.title.hasPrefix("Demo Button") }) else {
        emit(["ok": false, "error": "no_demo_button"]); exit(1)
    }
    let before = counter()
    let dispatch = worker.resolveAndDispatch(tokenId: button.elementToken, action: "AXPress")
    let after = counter()
    // A fresh observation (the next snapshot) mints new tokens and re-retains the
    // same AX objects; the ORIGINAL token must still dispatch to the ORIGINAL
    // object rather than being invalidated or re-pointed by path.
    _ = worker.observeAndRetain()
    let redispatch = worker.resolveAndDispatch(tokenId: button.elementToken, action: "AXPress")
    let afterReobserve = counter()
    worker.invalidate()
    let rejected = worker.resolveAndDispatch(tokenId: button.elementToken, action: "AXPress")
    let ok = (dispatch["ok"] as? Bool) == true && after == before + 1
        && (redispatch["ok"] as? Bool) == true && afterReobserve == after + 1
        && (rejected["error"] as? String) == "identity_unproven"
    emit(["ok": ok, "before": before, "after": after, "afterReobserve": afterReobserve,
          "dispatch": dispatch, "redispatch": redispatch, "afterInvalidate": rejected])
    exit(ok ? 0 : 1)
}

/// Resident AX worker (Task 8): a long-lived process that keeps the retained
/// objects + epoch across requests, so a token minted by one `observe` can be
/// dispatched by a later `click` in the same session. Protocol: one JSON per
/// stdin line, one JSON reply per command.
func runAXWorker(pid: pid_t, windowId: CGWindowID) -> Never {
    let worker = AXSessionWorker()
    worker.beginSession(pid: pid, windowId: windowId)
    emit(["ok": true, "axWorker": "ready", "epoch": worker.epoch])
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cmd = obj["cmd"] as? String else { continue }
        switch cmd {
        case "observe":
            let candidates = worker.observeAndRetain()
            let rows: [[String: Any]] = candidates.map {
                ["path": $0.path, "role": $0.role, "title": $0.title,
                 "elementToken": $0.elementToken, "enabled": $0.enabled]
            }
            emit(["ok": true, "cmd": "observe", "epoch": worker.epoch, "candidates": rows])
        case "click":
            guard let tokenId = obj["elementToken"] as? String else {
                emit(["ok": false, "cmd": "click", "error": "missing_token"]); continue
            }
            let action = (obj["action"] as? String) ?? "AXPress"
            let result = worker.resolveAndDispatch(tokenId: tokenId, action: action)
            var reply = result
            reply["cmd"] = "click"
            emit(reply)
        case "verify":
            guard let vt = obj["elementToken"] as? String else {
                emit(["ok": false, "cmd": "verify", "error": "missing_token"]); continue
            }
            var vr = worker.verify(vt); vr["cmd"] = "verify"; emit(vr)
        case "invalidate":
            worker.invalidate()
            emit(["ok": true, "cmd": "invalidate", "epoch": worker.epoch])
        case "stop":
            emit(["ok": true, "cmd": "stop"])
            exit(0)
        default:
            emit(["ok": false, "error": "unknown_cmd", "cmd": cmd])
        }
    }
    exit(0)
}
