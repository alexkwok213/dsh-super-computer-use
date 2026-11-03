import ApplicationServices
import CoreGraphics
import Foundation

// Read-only inspection. expectedElement must be retained from the snapshot that
// produced ref, in this process; a path and matching labels alone do not prove
// that a later element is the same object.
func inspectAXTargetState(pid: pid_t, windowId: CGWindowID, ref: String,
                          role: String, title: String,
                          expectedElement: AXUIElement?) -> [String: Any] {
    func unknown(_ reason: String) -> [String: Any] {
        return ["ok": false, "status": "unknown", "reason": reason,
                "pid": Int(pid), "windowId": Int(windowId), "ref": ref]
    }
    guard pid > 0, windowId != 0, !role.isEmpty, let expectedElement else {
        return unknown("missing_identity_evidence")
    }
    guard AXIsProcessTrusted() else { return unknown("accessibility_unavailable") }
    guard onScreenWindows().contains(where: { $0.id == windowId && $0.pid == pid }) else {
        return unknown("window_owner_unavailable_or_mismatch")
    }
    // windowRoot's geometry/title heuristic is useful for locating a candidate,
    // but is not itself proof of the candidate's CGWindowID.
    let app = AXUIElementCreateApplication(pid)
    guard let window = windowRoot(pid: pid, root: app, windowId: windowId) else {
        return unknown("window_scope_unavailable")
    }
    var windowPID: pid_t = 0
    guard AXUIElementGetPid(window.element, &windowPID) == .success, windowPID == pid,
          let number = attribute(window.element, "AXWindowNumber") as? NSNumber,
          CFGetTypeID(number) == CFNumberGetTypeID(),
          number.int64Value > 0, number.doubleValue == Double(windowId),
          number.uint64Value == UInt64(windowId) else {
        return unknown("window_identity_unproven")
    }
    guard ref.hasPrefix("k") else { return unknown("path_ref_required") }
    let path = String(ref.dropFirst())
    let pieces = path.split(separator: ".", omittingEmptySubsequences: false)
    guard !pieces.isEmpty, pieces.allSatisfy({ !$0.isEmpty && $0.allSatisfy { $0.isASCII && $0.isNumber } }),
          let first = Int(pieces[0]), first == window.index else {
        return unknown("ref_outside_window")
    }
    var target = window.element
    var level = -1
    for part in pieces.dropFirst() {
        // orderedChildren uses children(), which treats AX errors as an empty
        // array. Check the actual result first so an error cannot become absence.
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(target, kAXChildrenAttribute as CFString, &raw) == .success,
              let raw, CFGetTypeID(raw) == CFArrayGetTypeID(),
              let kids = raw as? [AXUIElement], let index = Int(part), index < kids.count else {
            return unknown("ref_path_unavailable")
        }
        let ordered = level == 0 ? orderedChildren(target, level: level) : kids
        guard index < ordered.count else { return unknown("ref_path_changed") }
        target = ordered[index]
        level += 1
    }
    var targetPID: pid_t = 0
    guard AXUIElementGetPid(target, &targetPID) == .success, targetPID == pid,
          CFEqual(target, expectedElement) else { return unknown("target_identity_unproven") }
    guard let actualRole = attribute(target, kAXRoleAttribute) as? String,
          actualRole == role else { return unknown("role_unavailable_or_mismatch") }
    // Match the snapshot label rule, but never turn a failed read into "".
    let actualTitle: String
    if let rawTitle = attribute(target, kAXTitleAttribute) as? String, !rawTitle.isEmpty {
        actualTitle = rawTitle
    } else if let description = attribute(target, kAXDescriptionAttribute) as? String {
        actualTitle = description
    } else {
        return unknown("title_unavailable")
    }
    guard actualTitle == title else { return unknown("title_mismatch") }
    guard actualRole != "AXSecureTextField",
          let subrole = attribute(target, kAXSubroleAttribute) as? String,
          subrole != "AXSecureTextField" else { return unknown("secure_or_unknown_subrole") }

    func read(_ name: String) -> [String: Any] {
        var raw: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(target, name as CFString, &raw)
        guard status == .success, let raw else {
            return ["status": "unknown", "axError": Int(status.rawValue)]
        }
        if CFGetTypeID(raw) == CFStringGetTypeID(), let value = raw as? String {
            return ["status": "known", "value": value]
        }
        if CFGetTypeID(raw) == CFBooleanGetTypeID(), let value = raw as? Bool {
            return ["status": "known", "value": value]
        }
        if CFGetTypeID(raw) == CFNumberGetTypeID(), let value = raw as? NSNumber,
           value.doubleValue.isFinite {
            return ["status": "known", "value": value]
        }
        return ["status": "unknown", "reason": "unsupported_ax_type"]
    }
    // AXSelectedChildren can describe a partial or virtualized view. Without a
    // separately established authoritative URL universe, it cannot prove that
    // all files are selected, even when it returns an empty array or every row.
    let selection: [String: Any] = ["status": "unknown", "complete": false,
                                    "reason": "authoritative_url_set_unavailable"]
    return ["ok": true, "status": "known", "pid": Int(pid), "windowId": Int(windowId),
            "ref": ref, "role": actualRole, "title": actualTitle,
            "value": read(kAXValueAttribute), "enabled": read(kAXEnabledAttribute),
            "focused": read(kAXFocusedAttribute), "selected": read("AXSelected"),
            "selection": selection]
}
