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
    private(set) var observationSeq = 0

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
        observationSeq += 1
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
                                          enabled: node.enabled, frameValid: node.frame != nil,
                                          frame: node.frame))
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

    /// R3: validate the retained object AND write its value in ONE command, so
    /// "proven" and "acted on" are the same object with no path re-resolution.
    func input(tokenId: String, text: String) -> [String: Any] {
        guard let element = retained[tokenId], let record = records[tokenId] else {
            return ["ok": false, "error": "identity_unproven", "message": "no retained object for token"]
        }
        guard record.epoch == epoch else { return ["ok": false, "error": "epoch_rebuilt"] }
        var owner: pid_t = 0
        AXUIElementGetPid(element, &owner)
        guard owner == pid else { return ["ok": false, "error": "stale_target"] }
        let enabled = (attribute(element, kAXEnabledAttribute) as? Bool) ?? true
        guard enabled else { return ["ok": false, "error": "identity_unproven", "message": "disabled"] }
        let status = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFString)
        if status == .success { return ["ok": true, "token": tokenId, "wrote": true] }
        return ["ok": false, "error": "input_failed", "status": Int(status.rawValue)]
    }

    /// A request may carry the JS-side binding; refuse if its app/window/epoch
    /// no longer match this worker's own bound target (R1 defense-in-depth).
    func bindingMismatch(_ binding: [String: Any]?) -> [String: Any]? {
        guard let binding else { return nil }
        if let p = binding["pid"] as? Int, p != Int(pid) {
            return ["ok": false, "error": "target_mismatch", "reason": "pid"]
        }
        if let bwin = binding["windowId"] as? Int, bwin != 0, bwin != Int(windowId) {
            return ["ok": false, "error": "target_mismatch", "reason": "windowId"]
        }
        if let be = binding["epoch"] as? Int, be != epoch {
            return ["ok": false, "error": "stale_observation", "reason": "epoch"]
        }
        return nil
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

    func reply(_ obj: [String: Any], requestId: Any?) {
        var out = obj
        if let requestId { out["requestId"] = requestId }
        writeJsonLine(out)
    }

    reply(["ok": true, "axWorker": "ready", "epoch": worker.epoch], requestId: nil)

    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cmd = obj["cmd"] as? String else { continue }
        let requestId = obj["requestId"]
        let binding = obj["binding"] as? [String: Any]

        // Every command except the handshake is refused when the request's
        // target binding disagrees with this worker's own bound target.
        if let mismatch = worker.bindingMismatch(binding) {
            var m = mismatch; m["cmd"] = cmd; reply(m, requestId: requestId); continue
        }

        switch cmd {
        case "observe":
            let candidates = worker.observeAndRetain()
            let nodes: [[String: Any]] = candidates.map { c in
                var row: [String: Any] = ["ref": c.path, "role": c.role, "title": c.title,
                                          "enabled": c.enabled, "elementToken": c.elementToken]
                if let f = c.frame {
                    row["x"] = Double(f.origin.x); row["y"] = Double(f.origin.y)
                    row["w"] = Double(f.size.width); row["h"] = Double(f.size.height)
                }
                return row
            }
            let rows: [[String: Any]] = candidates.map {
                ["path": $0.path, "role": $0.role, "title": $0.title,
                 "elementToken": $0.elementToken, "enabled": $0.enabled]
            }
            reply(["ok": true, "cmd": "observe", "epoch": worker.epoch,
                   "pid": Int(pid), "windowId": Int(windowId),
                   "observationId": "w\(worker.epoch)-obs\(worker.observationSeq)",
                   "nodes": nodes, "candidates": rows], requestId: requestId)
        case "click":
            guard let tokenId = obj["elementToken"] as? String else {
                reply(["ok": false, "cmd": "click", "error": "missing_token"], requestId: requestId); continue
            }
            let action = (obj["action"] as? String) ?? "AXPress"
            var result = worker.resolveAndDispatch(tokenId: tokenId, action: action)
            result["cmd"] = "click"
            reply(result, requestId: requestId)
        case "verify":
            guard let vt = obj["elementToken"] as? String else {
                reply(["ok": false, "cmd": "verify", "error": "missing_token"], requestId: requestId); continue
            }
            var vr = worker.verify(vt); vr["cmd"] = "verify"; reply(vr, requestId: requestId)
        case "input":
            guard let it = obj["elementToken"] as? String, let text = obj["text"] as? String else {
                reply(["ok": false, "cmd": "input", "error": "missing_token_or_text"], requestId: requestId); continue
            }
            var ir = worker.input(tokenId: it, text: text); ir["cmd"] = "input"; reply(ir, requestId: requestId)
        case "invalidate":
            worker.invalidate()
            reply(["ok": true, "cmd": "invalidate", "epoch": worker.epoch], requestId: requestId)
        case "stop":
            reply(["ok": true, "cmd": "stop"], requestId: requestId)
            exit(0)
        default:
            reply(["ok": false, "error": "unknown_cmd", "cmd": cmd], requestId: requestId)
        }
    }
    exit(0)
}
