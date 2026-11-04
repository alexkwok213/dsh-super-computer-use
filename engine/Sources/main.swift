// cu — a small computer-use engine for macOS.
//
// Subcommands print one JSON object per line. It is deliberately standalone:
// nothing here is copied from another application, every capability is built on
// Apple's public APIs (Accessibility, CoreGraphics events, ScreenCaptureKit).
//
//   cu perms
//   cu windows
//   cu shot --window <id> [--out file.png | --base64]
//   cu ax --pid <pid> [--depth 6] [--find text] [--limit 400]
//   cu click --x <n> --y <n> [--button left|right] [--count 1|2]
//   cu type --text "hello"
//   cu key --name enter [--mods cmd,shift]
//   cu scroll --dy <n> [--x <n> --y <n>]
//   cu drag --from <x,y> --to <x,y>
//   cu move --x <n> --y <n>
//   cu halo --window <id> [--seconds <n>] [--label "Safari — scrolling"]
//
// Coordinates in and out of every command are global, top-left origin, which is
// what CGWindowList reports and what CGEvent wants.

import AppKit
import ApplicationServices
import CoreGraphics
import CoreMedia
import CryptoKit
import Foundation
import ObjectiveC
import ScreenCaptureKit
import QuartzCore
import Vision

// MARK: - output

// Native event stream (Spec §5.2). Only active when the caller passes
// `--events-v1`; default CLI output stays one JSON object per line.
var eventsV1 = false
var eventsSessionId = "cli"
var eventsActionId = "cli-action"
var eventsSeq = 0
let eventsClockDomain = "native-monotonic"

func actionTargetDict(pid: pid_t, windowId: Int?) -> [String: Any] {
    return ["pid": Int(pid), "windowId": windowId ?? 0, "targetGeneration": 0, "geometryVersion": 0]
}

func writeJsonLine(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

func emitActionEventLine(_ phase: String, kind: String, target: [String: Any]? = nil,
                         point: CGPoint? = nil, label: String? = nil, reason: String? = nil,
                         verification: [String: Any]? = nil) {
    guard eventsV1 else { return }
    eventsSeq += 1
    var event: [String: Any] = [
        "version": 1,
        "sessionId": eventsSessionId,
        "actionId": eventsActionId,
        "eventId": "\(eventsActionId)#\(eventsSeq)",
        "source": "native",
        "phase": phase,
        "kind": kind,
        "clockDomain": eventsClockDomain,
        "emittedNs": String(DispatchTime.now().uptimeNanoseconds),
    ]
    if let target { event["target"] = target }
    if let point { event["point"] = ["x": Double(point.x), "y": Double(point.y)] }
    if let label { event["label"] = label }
    if let reason { event["reason"] = reason }
    if let verification { event["verification"] = verification }
    writeJsonLine(["kind": "event", "event": event])
}

func emit(_ object: [String: Any]) {
    if eventsV1 {
        writeJsonLine(["kind": "result", "result": object])
    } else {
        writeJsonLine(object)
    }
}

func fail(_ code: String, _ message: String, _ extra: [String: Any] = [:]) -> Never {
    var object: [String: Any] = ["ok": false, "error": code, "message": message]
    extra.forEach { object[$0.key] = $0.value }
    emit(object)
    exit(1)
}

// MARK: - arguments

struct Args {
    let command: String
    private var values: [String: String] = [:]

    init(_ argv: [String]) {
        command = argv.first ?? ""
        var index = 1
        while index < argv.count {
            let token = argv[index]
            if token.hasPrefix("--") {
                let name = String(token.dropFirst(2))
                let next = index + 1 < argv.count ? argv[index + 1] : nil
                if let next, !next.hasPrefix("--") {
                    values[name] = next
                    index += 2
                } else {
                    values[name] = "1"
                    index += 1
                }
            } else {
                index += 1
            }
        }
    }

    subscript(_ name: String) -> String? { values[name] }
    func flag(_ name: String) -> Bool { values[name] != nil }
    func int(_ name: String) -> Int? { values[name].flatMap(Int.init) }
    func double(_ name: String) -> Double? { values[name].flatMap(Double.init) }
    func number(_ name: String, _ fallback: (String) -> Never) -> Double {
        guard let value = double(name) else { fallback("missing --\(name)") }
        return value
    }
}

// MARK: - permissions

func permissions() -> [String: Any] {
    let ax = AXIsProcessTrusted()
    let screen = CGPreflightScreenCaptureAccess()
    return ["ok": true, "accessibility": ax, "screenRecording": screen,
            "pid": ProcessInfo.processInfo.processIdentifier,
            "executable": CommandLine.arguments[0]]
}

@discardableResult
func requireAccessibility() -> Bool {
    if AXIsProcessTrusted() { return true }
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
    return AXIsProcessTrustedWithOptions(options as CFDictionary)
}

// Same behavior as Claude's app: when a grant is missing, make macOS raise its
// own consent dialog instead of telling the user to hunt for the right pane.
func requestPermissionsIfMissing() {
    if !AXIsProcessTrusted() { _ = requireAccessibility() }
    if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
}

// MARK: - window list

struct WindowInfo {
    let id: CGWindowID
    let pid: pid_t
    let app: String
    let title: String
    let bounds: CGRect
    let layer: Int
}

func onScreenWindows() -> [WindowInfo] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }
    var result: [WindowInfo] = []
    for entry in raw {
        let layer = entry[kCGWindowLayer as String] as? Int ?? 0
        guard layer == 0 else { continue }
        let alpha = entry[kCGWindowAlpha as String] as? Double ?? 1
        guard alpha > 0.01 else { continue }
        guard let number = entry[kCGWindowNumber as String] as? Int,
              let pid = entry[kCGWindowOwnerPID as String] as? Int,
              let dictionary = entry[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: dictionary as CFDictionary) else { continue }
        guard rect.width >= 40, rect.height >= 40 else { continue }
        let app = entry[kCGWindowOwnerName as String] as? String ?? ""
        let title = entry[kCGWindowName as String] as? String ?? ""
        result.append(WindowInfo(id: CGWindowID(number), pid: pid_t(pid), app: app,
                                 title: title, bounds: rect, layer: layer))
    }
    return result
}

func describe(_ window: WindowInfo) -> [String: Any] {
    var object: [String: Any] = [
        "windowId": Int(window.id), "pid": Int(window.pid), "app": window.app,
        "title": window.title,
        "bounds": ["x": window.bounds.origin.x, "y": window.bounds.origin.y,
                   "width": window.bounds.width, "height": window.bounds.height]]
    if let front = NSWorkspace.shared.frontmostApplication?.processIdentifier {
        object["frontmost"] = front == window.pid
    }
    return object
}

/// Sheets, dialogs and progress panels can be AXWindows with no CGWindowList
/// entry: 剪映's “导入素材” progress window is exactly that, invisible to both
/// `windows` and window-scoped screenshots. Read the frontmost app's AX window
/// list (plus nested sheets/dialogs) so such a window can at least be seen.
/// These entries carry `axOnly: true` and windowId 0; target them by app scope.
func axWindowInfos(pid: pid_t) -> [(title: String, role: String, bounds: CGRect)] {
    let app = AXUIElementCreateApplication(pid)
    // A busy or hung app must not stall the window list.
    AXUIElementSetMessagingTimeout(app, 1.0)
    guard let roots = attribute(app, kAXWindowsAttribute) as? [AXUIElement] else { return [] }
    var result: [(String, String, CGRect)] = []
    var queue = roots
    var visited = 0
    while let element = queue.popLast(), visited < 300 {
        visited += 1
        let role = stringAttribute(element, kAXRoleAttribute)
        let title = stringAttribute(element, kAXTitleAttribute)
        if let position = attribute(element, kAXPositionAttribute),
           let extent = attribute(element, kAXSizeAttribute),
           CFGetTypeID(position) == AXValueGetTypeID(),
           CFGetTypeID(extent) == AXValueGetTypeID() {
            var point = CGPoint.zero
            var size = CGSize.zero
            AXValueGetValue(position as! AXValue, .cgPoint, &point)
            AXValueGetValue(extent as! AXValue, .cgSize, &size)
            result.append((title, role, CGRect(origin: point, size: size)))
        }
        for child in children(element) {
            let childRole = stringAttribute(child, kAXRoleAttribute)
            if childRole == "AXSheet" || childRole == "AXDialog" || childRole == "AXWindow" {
                queue.append(child)
            }
        }
    }
    return result
}

/// AX-only windows for the frontmost app and any explicitly requested pid.
/// A window already in CGWindowList is matched by pid and geometry: CG often
/// reports no title (or a different one), so comparing titles would list the
/// same window twice. Sheets sharing the parent's exact frame are the one case
/// this can drop; sheets that matter (a progress dialog) are inset.
func axOnlyWindows(scanPids: [pid_t], known: [WindowInfo]) -> [[String: Any]] {
    var result: [[String: Any]] = []
    for pid in scanPids {
        guard let running = NSRunningApplication(processIdentifier: pid) else { continue }
        for info in axWindowInfos(pid: pid) {
            guard info.bounds.width >= 40, info.bounds.height >= 40 else { continue }
            let duplicate = known.contains { window in
                window.pid == pid &&
                abs(window.bounds.origin.x - info.bounds.origin.x) < 3 &&
                abs(window.bounds.origin.y - info.bounds.origin.y) < 3 &&
                abs(window.bounds.width - info.bounds.width) < 3 &&
                abs(window.bounds.height - info.bounds.height) < 3
            }
            guard !duplicate else { continue }
            var object: [String: Any] = [
                "windowId": 0, "pid": Int(pid),
                "app": running.localizedName ?? "",
                "title": info.title, "role": info.role, "axOnly": true,
                "bounds": ["x": info.bounds.origin.x, "y": info.bounds.origin.y,
                           "width": info.bounds.width, "height": info.bounds.height]]
            if let front = NSWorkspace.shared.frontmostApplication?.processIdentifier {
                object["frontmost"] = front == pid
            }
            result.append(object)
        }
    }
    return result
}

/// Stage Manager keeps a "Gesture Blocking Overlay" twin for every off-stage
/// window; matching bounds identify those without guessing from size.
func offStageIds(_ windows: [WindowInfo]) -> Set<CGWindowID> {
    let overlays = windows.filter { $0.app == "WindowManager" && $0.title.contains("Gesture Blocking") }
    var ids: Set<CGWindowID> = []
    for window in windows where window.app != "WindowManager" {
        for overlay in overlays {
            if abs(overlay.bounds.origin.x - window.bounds.origin.x) < 6,
               abs(overlay.bounds.origin.y - window.bounds.origin.y) < 6,
               abs(overlay.bounds.width - window.bounds.width) < 12,
               abs(overlay.bounds.height - window.bounds.height) < 12 {
                ids.insert(window.id)
                break
            }
        }
    }
    return ids
}

// MARK: - focus

func frontmost() -> (pid: pid_t, app: String) {
    guard let app = NSWorkspace.shared.frontmostApplication else { return (0, "") }
    return (app.processIdentifier, app.localizedName ?? "")
}

@discardableResult
func activate(pid: pid_t) -> Bool {
    guard let app = NSRunningApplication(processIdentifier: pid) else { return false }
    audit("activate pid=\(pid) app=\(app.localizedName ?? "") caller=\(CommandLine.arguments.dropFirst().first ?? "")")
    if #available(macOS 14.0, *) {
        app.activate()
    } else {
        app.activate(options: [.activateIgnoringOtherApps])
    }
    let deadline = Date().addingTimeInterval(1.6)
    while Date() < deadline {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { return true }
        usleep(50_000)
    }
    // Cooperative activation is often refused when another app holds focus.
    // `open -b` goes through LaunchServices and is the reliable fallback.
    if let bundle = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        task.arguments = ["-b", bundle]
        try? task.run()
        task.waitUntilExit()
        let second = Date().addingTimeInterval(1.6)
        while Date() < second {
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { return true }
            usleep(50_000)
        }
    }
    return NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
}

func frontmostPID() -> pid_t {
    NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
}

// MARK: - staying in the background

/// Who was frontmost before this helper process started. Read it *before* the
/// first `NSApplication.shared`: AppKit activates a freshly launched
/// NSApplication when the app that spawned it is frontmost, and a helper that
/// owns no windows then holds the user's focus hostage — keystrokes go nowhere
/// and every app they try to click loses activation first.
func frontmostBeforeLaunch() -> pid_t {
    NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
}

/// Hand the user's focus back to whoever had it. Only acts when this process
/// actually became the active app, so it is harmless to call on a normal run.
func yieldFocus(to previous: pid_t) {
    guard frontmostPID() == getpid() else { return }
    if previous > 0, previous != getpid(),
       let app = NSRunningApplication(processIdentifier: previous) {
        if #available(macOS 14.0, *) {
            if app.activate() { return }
        } else if app.activate(options: [.activateIgnoringOtherApps]) {
            return
        }
    }
    // macOS 14+ sometimes refuses one app activating another. Deactivating self
    // still lets the window server hand focus back to the previous app.
    NSApp.deactivate()
}

/// AppKit's launch activation can land a few hundred milliseconds after the
/// window is ordered front (measured with `tests/focus_probe.command`), so the
/// hand-back runs on the same delays a user would notice.
func stayInBackground(_ previous: pid_t) {
    yieldFocus(to: previous)
    for delay in [0.25, 0.8] {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            yieldFocus(to: previous)
        }
    }
}

// MARK: - screen capture

struct Capture {
    let png: Data
    let origin: CGPoint     // top-left of the captured area, global points
    let size: CGSize        // captured area in points
    let scale: Double       // image pixels per point
    // How the bytes are already encoded. screencapture can write JPEG directly,
    // which lets a jpeg request skip a PNG encode followed by a decode.
    var encoding: String = "png"
}

@available(macOS 14.0, *)
func capture(windowId: CGWindowID? = nil, screen: Bool = false,
             displayIndex: Int = 0, maxDimension: Int = 0,
             timeout: TimeInterval = 1.5) throws -> Capture {
    let semaphore = DispatchSemaphore(value: 0)
    var outcome: Result<Capture, Error>!
    Task.detached {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)
            var filter: SCContentFilter
            var area: CGRect
            if screen || windowId == nil {
                let displays = content.displays.sorted { $0.displayID < $1.displayID }
                guard displayIndex >= 0, displayIndex < displays.count else {
                    throw NSError(domain: "cu", code: 2,
                                  userInfo: [NSLocalizedDescriptionKey: "no display \(displayIndex)"])
                }
                let display = displays[displayIndex]
                filter = SCContentFilter(display: display, excludingWindows: [])
                // The matching NSScreen carries the point geometry and the origin
                // in global coordinates, which matters once there are two displays.
                let screen = NSScreen.screens.first {
                    ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?
                        .uint32Value == display.displayID
                }
                let frame = screen?.frame ?? CGRect(x: 0, y: 0,
                                                    width: CGFloat(display.width),
                                                    height: CGFloat(display.height))
                // Cocoa frames are bottom-left; capture metadata is top-left.
                let screenHeight = NSScreen.screens.first?.frame.height ?? frame.height
                area = CGRect(x: frame.origin.x,
                              y: screenHeight - frame.origin.y - frame.height,
                              width: frame.width, height: frame.height)
            } else {
                guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
                    throw NSError(domain: "cu", code: 2,
                                  userInfo: [NSLocalizedDescriptionKey: "window \(windowId!) is not capturable"])
                }
                filter = SCContentFilter(desktopIndependentWindow: window)
                area = window.frame
            }
            let configuration = SCStreamConfiguration()
            configuration.width = Int(max(1, area.width) * 2)
            configuration.height = Int(max(1, area.height) * 2)
            configuration.showsCursor = false
            configuration.captureResolution = .best
            let image = try await SCScreenshotManager.captureImage(
                contentFilter: filter, configuration: configuration)
            var output = image
            if maxDimension > 0 && image.width > maxDimension {
                // Scale in an explicit bitmap context: an NSImage lockFocus would
                // come back 2x on a Retina screen and defeat the point.
                let ratio = Double(maxDimension) / Double(image.width)
                let width = maxDimension
                let height = max(1, Int((Double(image.height) * ratio).rounded()))
                if let context = CGContext(data: nil, width: width, height: height,
                                           bitsPerComponent: 8, bytesPerRow: 0,
                                           space: CGColorSpaceCreateDeviceRGB(),
                                           bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue) {
                    context.interpolationQuality = .high
                    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
                    if let scaled = context.makeImage() { output = scaled }
                }
            }
            let rep = NSBitmapImageRep(cgImage: output)
            guard let png = rep.representation(using: .png, properties: [:]) else {
                throw NSError(domain: "cu", code: 3,
                              userInfo: [NSLocalizedDescriptionKey: "png encoding failed"])
            }
            let scale = area.width > 0 ? Double(output.width) / Double(area.width) : 2
            outcome = .success(Capture(png: png, origin: area.origin, size: area.size, scale: scale))
        } catch {
            outcome = .failure(error)
        }
        semaphore.signal()
    }
    if semaphore.wait(timeout: .now() + timeout) == .timedOut {
        // The detached task may still finish and write `outcome`; we have already
        // given up on it and must not read that memory after this return.
        throw NSError(domain: "cu", code: 5,
                      userInfo: [NSLocalizedDescriptionKey:
                        "ScreenCaptureKit did not answer in \(Int(timeout)) s"])
    }
    switch outcome {
    case .success(let capture): return capture
    case .failure(let error): throw error
    case nil: throw NSError(domain: "cu", code: 4,
                            userInfo: [NSLocalizedDescriptionKey: "capture produced nothing"])
    }
}

// MARK: - accessibility

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func stringAttribute(_ element: AXUIElement, _ name: String) -> String {
    attribute(element, name) as? String ?? ""
}

func frame(of element: AXUIElement) -> CGRect? {
    var origin = CGPoint.zero
    var size = CGSize.zero
    guard let position = attribute(element, kAXPositionAttribute),
          let extent = attribute(element, kAXSizeAttribute) else { return nil }
    AXValueGetValue(position as! AXValue, .cgPoint, &origin)
    AXValueGetValue(extent as! AXValue, .cgSize, &size)
    return CGRect(origin: origin, size: size)
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}

struct Node {
    let element: AXUIElement
    let role: String
    let title: String
    let value: String
    let frame: CGRect?
    let depth: Int
    let enabled: Bool
}

func walk(from root: AXUIElement, depth: Int, limit: Int, visit: (Node) -> Bool) -> Bool {
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var visited = 0
    while !queue.isEmpty {
        let (element, level) = queue.removeFirst()
        if level >= depth { continue }
        for child in children(element) {
            let node = Node(element: child,
                            role: stringAttribute(child, kAXRoleAttribute),
                            title: stringAttribute(child, kAXTitleAttribute),
                            value: stringAttribute(child, kAXValueAttribute),
                            frame: frame(of: child),
                            depth: level + 1,
                            enabled: (attribute(child, kAXEnabledAttribute) as? Bool) ?? true)
            visited += 1
            if visit(node) { return true }
            if visited >= limit { return false }
            queue.append((child, level + 1))
        }
    }
    return false
}

func nodeJSON(_ node: Node) -> [String: Any] {
    var object: [String: Any] = ["role": node.role, "title": node.title,
                                 "value": String(node.value.prefix(200)), "depth": node.depth,
                                 "enabled": node.enabled]
    if let frame = node.frame {
        object["x"] = frame.origin.x
        object["y"] = frame.origin.y
        object["w"] = frame.size.width
        object["h"] = frame.size.height
        object["cx"] = frame.midX
        object["cy"] = frame.midY
    }
    return object
}

// MARK: - input

let eventSource = CGEventSource(stateID: .hidSystemState)

func post(_ event: CGEvent?) {
    event?.post(tap: .cghidEventTap)
    usleep(12_000)
}

func mouseButton(_ name: String) -> (CGMouseButton, CGEventType, CGEventType) {
    switch name {
    case "right": return (.right, .rightMouseDown, .rightMouseUp)
    case "middle": return (.center, .otherMouseDown, .otherMouseUp)
    default: return (.left, .leftMouseDown, .leftMouseUp)
    }
}

func postToPid(_ event: CGEvent?, _ pid: pid_t) {
    event?.postToPid(pid)
    usleep(12_000)
}

func clickToPid(_ pid: pid_t, x: Double, y: Double, button: String, count: Int) {
    let (which, downType, upType) = mouseButton(button)
    let point = CGPoint(x: x, y: y)
    let move = CGEvent(mouseEventSource: eventSource, mouseType: .mouseMoved,
                       mouseCursorPosition: point, mouseButton: which)
    postToPid(move, pid)
    for clickIndex in 1...max(1, count) {
        let down = CGEvent(mouseEventSource: eventSource, mouseType: downType,
                           mouseCursorPosition: point, mouseButton: which)
        down?.setIntegerValueField(.mouseEventClickState, value: Int64(clickIndex))
        postToPid(down, pid)
        let up = CGEvent(mouseEventSource: eventSource, mouseType: upType,
                         mouseCursorPosition: point, mouseButton: which)
        up?.setIntegerValueField(.mouseEventClickState, value: Int64(clickIndex))
        postToPid(up, pid)
    }
}

func typeToPid(_ pid: pid_t, _ text: String) {
    for chunkStart in stride(from: 0, to: text.count, by: 20) {
        let start = text.index(text.startIndex, offsetBy: chunkStart)
        let end = text.index(start, offsetBy: min(20, text.count - chunkStart))
        let units = Array(String(text[start..<end]).utf16)
        guard let down = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: true) else { continue }
        down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        postToPid(down, pid)
        usleep(10_000)
    }
}

func pressToPid(_ pid: pid_t, name: String, modifiers: CGEventFlags) {
    guard let code = keyCodes[name.lowercased()] else {
        fail("unknown_key", "no key code for \(name)")
    }
    if let down = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: true) {
        down.flags = modifiers
        postToPid(down, pid)
    }
    usleep(10_000)
    if let up = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: false) {
        up.flags = modifiers
        postToPid(up, pid)
    }
}


/// Coordinates are the only thing that needs a trustworthy frame; an AX action
/// does not. Some Chromium builds keep stale frames after a Stage Manager
/// transition, so this is checked right before a synthetic click, not before an
/// AXPress.
func frameLooksStale(_ node: SnapNode, pid: pid_t) -> Bool {
    guard let frame = node.frame else { return false }
    let point = CGPoint(x: frame.midX, y: frame.midY)
    return !onScreenWindows().contains { $0.pid == pid && $0.bounds.contains(point) }
}

func focusedElement(pid: pid_t) -> AXUIElement? {
    let root = AXUIElementCreateApplication(pid)
    return axElement(attribute(root, kAXFocusedUIElementAttribute))
}

/// Resolve an explicit --pid/--window pair as ONE target (Spec §7.1, F1).
/// A window decides its own owner, but a window must never silently override a
/// *different* explicit pid: that is how an action aimed at app B landed on app
/// A's window. A mismatch is refused as target_mismatch before any input.
func resolveTargetPair(pid explicitPid: Int?, window explicitWindow: Int?,
                       action: String) -> (pid: pid_t?, windowId: CGWindowID?) {
    guard let windowId = explicitWindow else {
        if let explicitPid, explicitPid != 0 { return (pid_t(explicitPid), nil) }
        return (nil, nil)
    }
    let wid = CGWindowID(windowId)
    guard let window = onScreenWindows().first(where: { $0.id == wid }) else {
        fail("window_gone", "window \(windowId) is not on screen",
             ["action": action, "windowId": windowId])
    }
    if let explicitPid, explicitPid != 0, pid_t(explicitPid) != window.pid {
        fail("target_mismatch",
             "pid \(explicitPid) does not own window \(windowId)",
             ["action": action, "pid": explicitPid, "windowId": windowId,
              "ownerPid": Int(window.pid)])
    }
    return (window.pid, wid)
}

/// Background target: never activates anything, still runs the safety layer.
func backgroundTarget(_ args: Args, _ action: String, allowOffStage: Bool = false) -> pid_t {
    let pair = resolveTargetPair(pid: args.int("pid"), window: args.int("window"), action: action)
    guard let resolved = pair.pid, resolved != 0 else {
        fail("missing_pid", "\(action) in the background needs --pid or --window")
    }
    let windows = onScreenWindows()
    let offStage = offStageIds(windows)
    let own = windows.filter { $0.pid == resolved && !$0.app.isEmpty }
    if !allowOffStage, !own.isEmpty, own.allSatisfy({ offStage.contains($0.id) }) {
        // Background events go to a process, but a window that is not on the
        // current stage is not composited at all; the events would vanish.
        fail("off_stage_window",
             "the app's windows are off-stage (Stage Manager); bring one on stage first",
             ["pid": Int(resolved), "hint": "cu stage --window <id>, or pass foreground: true"])
    }
    if !args.flag("force"), !args.flag("no-preflight") {
        if let refusal = preflight(action: action, point: nil, pid: resolved, requireFocus: false,
                                   secureAllowed: false, ignoreSheet: args.flag("ignore-sheet")) {
            refuse(refusal)
        }
    }
    return resolved
}

/// Off-stage windows are normally refused because pid-posted events often vanish
/// before they reach the app. Some apps (Electron) still take them; instead of
/// guessing, the caller attempts the injection and proves it landed by reading
/// the app's own state back. This fingerprint is only used to detect "nothing
/// observable happened", never to claim success the app did not show.
func inputFingerprint(pid: pid_t) -> String {
    var parts: [String] = []
    if let focused = focusedElement(pid: pid) {
        parts.append(stringAttribute(focused, kAXRoleAttribute))
        parts.append(stringAttribute(focused, kAXValueAttribute))
        if let frame = frame(of: focused) {
            parts.append("\(Int(frame.origin.x)),\(Int(frame.origin.y))")
        }
    }
    return parts.joined(separator: "|")
}


func scrollToPid(_ pid: pid_t, dx: Double, dy: Double) {
    let event = CGEvent(scrollWheelEvent2Source: eventSource, units: .pixel, wheelCount: 2,
                        wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0)
    if let event { event.postToPid(pid) }
}

func click(x: Double, y: Double, button: String, count: Int) {
    let (which, downType, upType) = mouseButton(button)
    let point = CGPoint(x: x, y: y)
    CGEvent(mouseEventSource: eventSource, mouseType: .mouseMoved,
            mouseCursorPosition: point, mouseButton: which)?.post(tap: .cghidEventTap)
    usleep(30_000)
    for clickIndex in 1...max(1, count) {
        let down = CGEvent(mouseEventSource: eventSource, mouseType: downType,
                           mouseCursorPosition: point, mouseButton: which)
        down?.setIntegerValueField(.mouseEventClickState, value: Int64(clickIndex))
        post(down)
        let up = CGEvent(mouseEventSource: eventSource, mouseType: upType,
                         mouseCursorPosition: point, mouseButton: which)
        up?.setIntegerValueField(.mouseEventClickState, value: Int64(clickIndex))
        post(up)
    }
}

func drag(from: CGPoint, to: CGPoint) {
    CGEvent(mouseEventSource: eventSource, mouseType: .mouseMoved,
            mouseCursorPosition: from, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(40_000)
    CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseDown,
            mouseCursorPosition: from, mouseButton: .left)?.post(tap: .cghidEventTap)
    let steps = 24
    for step in 1...steps {
        let progress = Double(step) / Double(steps)
        let point = CGPoint(x: from.x + (to.x - from.x) * progress,
                            y: from.y + (to.y - from.y) * progress)
        CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseDragged,
                mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(9_000)
    }
    CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseUp,
            mouseCursorPosition: to, mouseButton: .left)?.post(tap: .cghidEventTap)
}

func dragToPid(_ pid: pid_t, from: CGPoint, to: CGPoint, button: String, steps: Int = 18) {
    let (which, downType, upType) = mouseButton(button)
    let dragged: CGEventType = button == "right" ? .rightMouseDragged
        : (button == "middle" ? .otherMouseDragged : .leftMouseDragged)
    postToPid(CGEvent(mouseEventSource: eventSource, mouseType: .mouseMoved,
                      mouseCursorPosition: from, mouseButton: which), pid)
    postToPid(CGEvent(mouseEventSource: eventSource, mouseType: downType,
                      mouseCursorPosition: from, mouseButton: which), pid)
    for step in 1...steps {
        let progress = Double(step) / Double(steps)
        let point = CGPoint(x: from.x + (to.x - from.x) * progress,
                            y: from.y + (to.y - from.y) * progress)
        postToPid(CGEvent(mouseEventSource: eventSource, mouseType: dragged,
                          mouseCursorPosition: point, mouseButton: which), pid)
    }
    postToPid(CGEvent(mouseEventSource: eventSource, mouseType: upType,
                      mouseCursorPosition: to, mouseButton: which), pid)
}

func scroll(dx: Double, dy: Double, at point: CGPoint?) {
    if let point {
        CGEvent(mouseEventSource: eventSource, mouseType: .mouseMoved,
                mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(20_000)
    }
    CGEvent(scrollWheelEvent2Source: eventSource, units: .pixel, wheelCount: 2,
            wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0)?.post(tap: .cghidEventTap)
}

let keyCodes: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "forwarddelete": 117,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98,
    "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
    "3": 20, "4": 21, "6": 22, "5": 23, "equal": 24, "9": 25, "7": 26, "minus": 27,
    "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40,
    "n": 45, "m": 46, "comma": 43, "period": 47, "slash": 44, "semicolon": 41,
    "quote": 39, "leftbracket": 33, "rightbracket": 30, "backslash": 42, "grave": 50,
]

func flags(_ modifiers: String) -> CGEventFlags {
    var flags: CGEventFlags = []
    for part in modifiers.split(separator: ",") {
        switch part.trimmingCharacters(in: .whitespaces) {
        case "cmd", "command": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "opt", "option", "alt": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "fn": flags.insert(.maskSecondaryFn)
        default: break
        }
    }
    return flags
}

func press(name: String, modifiers: CGEventFlags) {
    guard let code = keyCodes[name.lowercased()] else {
        fail("unknown_key", "no key code for \(name)")
    }
    let down = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: true)
    down?.flags = modifiers
    down?.post(tap: .cghidEventTap)
    usleep(15_000)
    let up = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: false)
    up?.flags = modifiers
    up?.post(tap: .cghidEventTap)
}

func focusedValue(pid: pid_t) -> String? {
    let root = AXUIElementCreateApplication(pid)
    guard let focused = axElement(attribute(root, kAXFocusedUIElementAttribute)) else { return nil }
    let role = stringAttribute(focused, kAXRoleAttribute)
    guard role == "AXTextArea" || role == "AXTextField" || role == "AXComboBox" else { return nil }
    return stringAttribute(focused, kAXValueAttribute)
}

func typeText(_ text: String) {
    // Unicode injection keeps the layout out of it: the string is delivered as-is.
    for scalarChunk in stride(from: 0, to: text.count, by: 20) {
        let start = text.index(text.startIndex, offsetBy: scalarChunk)
        let end = text.index(start, offsetBy: min(20, text.count - scalarChunk))
        let chunk = String(text[start..<end])
        let units = Array(chunk.utf16)
        // A down event carrying the string is what inserts it; the matching key-up
        // with an empty payload makes some editors (TextEdit) drop the whole run.
        let down = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: true)
        down?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        down?.post(tap: .cghidEventTap)
        usleep(12_000)
    }
}

/// Stage Manager keeps windows on a stage and shows the others as left-edge
/// thumbnails. A click can only land on a window that is on the current stage, so
/// targeting one of its thumbnails brings it forward first.
func stageThumbnail(for pid: pid_t) -> WindowInfo? {
    onScreenWindows().first { $0.pid == pid && $0.bounds.width < 420 && $0.bounds.height < 300 }
}

@discardableResult
func bringOnStage(pid: pid_t, target: CGWindowID) -> Bool {
    if onScreenWindows().contains(where: { $0.id == target }) { return true }
    guard let thumbnail = stageThumbnail(for: pid) else { return false }
    click(x: thumbnail.bounds.midX, y: thumbnail.bounds.midY, button: "left", count: 1)
    pump(0.55)
    return onScreenWindows().contains(where: { $0.id == target })
}

// MARK: - preflight

// The reasons below mirror the refusal vocabulary the shipped engine reports
// (secure_input_active, sheet_or_modal_on_target_window, another_window_on_top,
// app_hidden, …), so a caller can react to the same conditions either way.

let pausePath = NSString(string: "~/.cu/pause").expandingTildeInPath

let lastActionPath = NSString(string: "~/.cu/last-action").expandingTildeInPath

let actionsLogPath = NSString(string: "~/.cu/actions.log").expandingTildeInPath

// The service log only sees traffic that comes through /v1/exec, so a command run
// straight from a shell left no trace — which made "who moved my front window"
// unanswerable. Every action and every activation is appended here instead.
func audit(_ note: String) {
    let manager = FileManager.default
    try? manager.createDirectory(atPath: NSString(string: "~/.cu").expandingTildeInPath,
                                 withIntermediateDirectories: true)
    if let size = (try? manager.attributesOfItem(atPath: actionsLogPath)[.size]) as? Int, size > 2_000_000 {
        if let text = try? String(contentsOfFile: actionsLogPath, encoding: .utf8) {
            let kept = text.split(separator: "\n").suffix(1000).joined(separator: "\n")
            try? (kept + "\n").write(toFile: actionsLogPath, atomically: true, encoding: .utf8)
        }
    }
    let line = "\(ISO8601DateFormatter().string(from: Date())) | \(note)\n"
    if let handle = try? FileHandle(forWritingTo: URL(fileURLWithPath: actionsLogPath)) {
        handle.seekToEndOfFile()
        handle.write(line.data(using: .utf8) ?? Data())
        try? handle.close()
    } else {
        try? line.write(toFile: actionsLogPath, atomically: true, encoding: .utf8)
    }
}

func markAction() {
    try? FileManager.default.createDirectory(atPath: NSString(string: "~/.cu").expandingTildeInPath,
                                            withIntermediateDirectories: true)
    let stamp = String(Date().timeIntervalSince1970)
    try? stamp.write(toFile: lastActionPath, atomically: true, encoding: .utf8)
    let argv = CommandLine.arguments.dropFirst().joined(separator: " ")
    audit("action=\(String(argv.prefix(160))) frontmost=\(frontmost().app)")
}

/// True when a HID event happened after our own last action — i.e. the user
/// touched the machine in between. Our synthetic events land in the same counter,
/// so only the comparison against our own timestamp can tell them apart.
func userIntervened() -> Bool {
    guard let text = try? String(contentsOfFile: lastActionPath, encoding: .utf8),
          let stamp = Double(text.trimmingCharacters(in: .whitespacesAndNewlines)) else {
        return false
    }
    let since = Date().timeIntervalSince1970 - stamp
    let idle = userIdleSeconds()
    // Only a *recent* human event matters: an old one (idle large) is simply the
    // event that preceded our action, and blocking on it kept the engine stuck
    // forever until the idle counter caught up with our timestamp.
    // Only the window right after our own action matters: with an old marker a
    // later human touch must not block the next unrelated call forever.
    guard since > 1.0, since < 5.0, idle < 1.0 else { return false }
    return idle + 0.35 < since
}

func fullScreenOverlayExists() -> Bool {
    let screenArea = (NSScreen.screens.first?.frame.width ?? 1728)
        * (NSScreen.screens.first?.frame.height ?? 1117)
    return onScreenWindows().contains {
        $0.app == "WindowManager" && $0.bounds.width * $0.bounds.height > screenArea * 0.8
    }
}

func pauseActive() -> Bool {
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: pausePath),
          let modified = attributes[.modificationDate] as? Date else { return false }
    return Date().timeIntervalSince(modified) < 60
}

func markPause() {
    try? FileManager.default.createDirectory(atPath: NSString(string: "~/.cu").expandingTildeInPath,
                                            withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: pausePath, contents: Data())
}

func clearPause() {
    try? FileManager.default.removeItem(atPath: pausePath)
}

func secureInputPID() -> pid_t? {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return nil }
    if let pid = session["kCGSSessionSecureInputPID"] as? Int, pid > 0 { return pid_t(pid) }
    return nil
}

func userIdleSeconds() -> Double {
    let types: [CGEventType] = [.keyDown, .leftMouseDown, .rightMouseDown, .scrollWheel]
    let values = types.map {
        CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0)
    }
    return values.min() ?? 0
}

func appHidden(_ pid: pid_t) -> Bool {
    NSRunningApplication(processIdentifier: pid)?.isHidden ?? false
}

func appGone(_ pid: pid_t) -> Bool {
    NSRunningApplication(processIdentifier: pid)?.isTerminated ?? true
}

func parentPID(of pid: pid_t) -> pid_t {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return 0 }
    return info.kp_eproc.e_ppid
}

/// The .app that launched this process. A CLI spawned by an editor inherits
/// that app's TCC identity, so Screen Recording belongs to the editor, not to
/// `cu` — the error message has to name the app the user can actually find in
/// System Settings.
func hostAppName() -> String? {
    var pid = getppid()
    for _ in 0..<12 {
        guard pid > 0 else { return nil }
        var buffer = [CChar](repeating: 0, count: 4096)
        let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        if length > 0 {
            let path = String(cString: buffer)
            if let range = path.range(of: ".app/Contents/") {
                var name = String(path[path.startIndex..<range.lowerBound])
                name = (name as NSString).lastPathComponent
                if name.hasSuffix(".app") { name = String(name.dropLast(4)) }
                return name.prefix(1).uppercased() + name.dropFirst()
            }
        }
        pid = parentPID(of: pid)
    }
    return nil
}

func windowAt(_ point: CGPoint) -> WindowInfo? {
    onScreenWindows().first { $0.bounds.contains(point) }
}

/// Bounds of the sheets/modals currently attached to the app.
///
/// A modal does not make the whole app untouchable — most of the time it is
/// exactly the thing that has to be driven (a Save dialog, an Open panel, an
/// alert). What has to be refused is a coordinate action aimed at the
/// controls *behind* it, which the app ignores; so callers need its bounds,
/// not a yes/no answer.
func openModalBounds(_ pid: pid_t) -> CGRect? {
    let root = AXUIElementCreateApplication(pid)
    var frames: [CGRect] = []
    func collect(_ element: AXUIElement, _ depth: Int) {
        let role = stringAttribute(element, kAXRoleAttribute)
        let modal = (attribute(element, kAXModalAttribute) as? Bool) == true
        if role == "AXSheet" || role == "AXDialog" || modal, let box = frame(of: element) {
            frames.append(box)
        }
        if depth >= 3 { return }
        for child in children(element) { collect(child, depth + 1) }
    }
    if let windows = attribute(root, kAXWindowsAttribute) as? [AXUIElement] {
        for window in windows { collect(window, 0) }
    }
    guard var union = frames.first else { return nil }
    for box in frames.dropFirst() { union = union.union(box) }
    return union
}

func hasSheet(_ pid: pid_t) -> Bool {
    openModalBounds(pid) != nil
}

/// Returns a refusal payload, or nil when the action may proceed.
let allowlistPath = NSString(string: "~/.cu/allowed-apps.json").expandingTildeInPath

func allowlist() -> [String] {
    guard let data = FileManager.default.contents(atPath: allowlistPath),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let apps = object["apps"] as? [String] else { return [] }
    return apps
}

func appIdentifier(_ pid: pid_t) -> (bundle: String, name: String) {
    let app = NSRunningApplication(processIdentifier: pid)
    return (app?.bundleIdentifier ?? "", app?.localizedName ?? "")
}

func userInterventionGuarded() -> Bool {
    if ProcessInfo.processInfo.environment.keys.contains("CU_NO_USER_PAUSE") {
        return false
    }
    if let data = FileManager.default.contents(atPath: serviceConfigPath),
       let decoded = try? JSONDecoder().decode(ServiceConfig.self, from: data),
       decoded.pauseOnUserActivity == false {
        return false
    }
    return userIntervened()
}

func preflight(action: String, point: CGPoint?, pid: pid_t?, requireFocus: Bool,
               secureAllowed: Bool, ignoreSheet: Bool) -> [String: Any]? {
    let extras: [String: Any] = ["action": action,
                                 "userIdleSeconds": (userIdleSeconds() * 1000).rounded() / 1000]
    if userInterventionGuarded() {
        return ["ok": false, "error": "user_recently_active",
                "message": "the user typed or clicked after the last action; pausing briefly",
                "retryAfterMs": 400].merging(extras) { $1 }
    }
    if pauseActive() {
        return ["ok": false, "error": "paused_by_user",
                "message": "the user stopped computer use from the controller; call resume first",
                "retryAfterMs": 0].merging(extras) { $1 }
    }
    if !secureAllowed, let securePID = secureInputPID() {
        return ["ok": false, "error": "secure_input_active",
                "message": "secure keyboard entry is on (pid \(securePID)); refusing to act",
                "secureInputPid": Int(securePID)].merging(extras) { $1 }
    }
    if let pid {
        if appGone(pid) {
            return ["ok": false, "error": "app_gone", "message": "the app is no longer running",
                    "pid": Int(pid)].merging(extras) { $1 }
        }
        if appHidden(pid) {
            return ["ok": false, "error": "app_hidden",
                    "message": "the app is hidden (⌘H); it has no window on screen",
                    "pid": Int(pid)].merging(extras) { $1 }
        }
    }
    if let pid, !onScreenWindows().contains(where: { $0.pid == pid }) {
        return ["ok": false, "error": "window_off_space",
                "message": "the app has no window on the current Space",
                "pid": Int(pid)].merging(extras) { $1 }
    }
    // A system layer can cover the screen (Mission Control, a full-screen app
    // switcher). Stage Manager is different: its off-stage thumbnails sit on the
    // left with a "Gesture Blocking Overlay" twin, and that is normal — only a
    // layer that actually covers the target point has to refuse.
    let screenArea = (NSScreen.screens.first?.frame.width ?? 1728)
        * (NSScreen.screens.first?.frame.height ?? 1117)
    let covering = onScreenWindows().filter { $0.app == "WindowManager" }
    let fullScreenLayer = covering.contains {
        $0.bounds.width * $0.bounds.height > screenArea * 0.8
    }
    if fullScreenLayer {
        return ["ok": false, "error": "occluder_fills_screen",
                "message": "a system overlay covers the screen; nothing can be clicked reliably"].merging(extras) { $1 }
    }
    if let point, covering.contains(where: { $0.title.contains("Gesture Blocking") && $0.bounds.contains(point) }) {
        return ["ok": false, "error": "off_stage_window",
                "message": "that window is off-stage (Stage Manager thumbnail); bring it on stage first",
                "point": ["x": point.x, "y": point.y]].merging(extras) { $1 }
    }
    if let point {
        if let top = windowAt(point), let pid, top.pid != pid {
            return ["ok": false, "error": "another_window_on_top",
                    "message": "\(top.app) is above the target at that point",
                    "topWindow": describe(top),
                    "point": ["x": point.x, "y": point.y]].merging(extras) { $1 }
        }
        if windowAt(point) == nil {
            return ["ok": false, "error": "point_outside_any_window",
                    "message": "no window is at that point",
                    "point": ["x": point.x, "y": point.y]].merging(extras) { $1 }
        }
    }
    if requireFocus, let pid, frontmostPID() != pid {
        return ["ok": false, "error": "not_frontmost",
                "message": "the target app does not hold focus",
                "frontmost": frontmost().app, "pid": Int(pid)].merging(extras) { $1 }
    }
    if let pid {
        let allowed = allowlist()
        if !allowed.isEmpty {
            let identity = appIdentifier(pid)
            let matches = allowed.contains {
                $0.caseInsensitiveCompare(identity.bundle) == .orderedSame
                    || $0.caseInsensitiveCompare(identity.name) == .orderedSame
            }
            if !matches {
                return ["ok": false, "error": "app_not_allowed",
                        "message": "\(identity.name) is not in ~/.cu/allowed-apps.json",
                        "app": identity.name, "bundleId": identity.bundle].merging(extras) { $1 }
            }
        }
    }
    // Note: an "user is typing" pause is reported by `guards` but not enforced.
    // Synthetic events posted here are indistinguishable from hardware ones via
    // public APIs, so the engine's own click would trip its own guard.
    // A sheet or modal belongs to the target app and is usually the very thing
    // that has to be driven from here. Refuse only a coordinate action that
    // lands outside it — the app would swallow that event, and "clicked,
    // nothing happened" is the expensive failure to debug. Keystrokes and
    // element actions need no point at all: they go to the modal itself.
    if !ignoreSheet, let pid, let modal = openModalBounds(pid), let point, !modal.contains(point) {
        return ["ok": false, "error": "sheet_or_modal_on_target_window",
                "message": "a sheet or modal dialog is open; that point is outside it — act on the dialog itself or dismiss it first",
                "pid": Int(pid),
                "sheet": ["x": modal.origin.x, "y": modal.origin.y,
                          "width": modal.width, "height": modal.height],
                "point": ["x": point.x, "y": point.y]].merging(extras) { $1 }
    }
    return nil
}

// MARK: - phantom cursor

final class PhantomPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class PhantomView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        let accent = NSColor(srgbRed: 0.85, green: 0.47, blue: 0.34, alpha: 0.95)
        let ring = NSBezierPath(ovalIn: bounds.insetBy(dx: 2, dy: 2))
        ring.lineWidth = 2
        accent.setStroke()
        ring.stroke()
        accent.withAlphaComponent(0.25).setFill()
        NSBezierPath(ovalIn: bounds.insetBy(dx: 6, dy: 6)).fill()
        NSColor.white.setFill()
        NSBezierPath(ovalIn: NSRect(x: bounds.midX - 1.5, y: bounds.midY - 1.5,
                                    width: 3, height: 3)).fill()
    }
}

func showPhantomCursor(at point: CGPoint, seconds: Double = 0.35) {
    let app = NSApplication.shared
    if app.activationPolicy() != .accessory { app.setActivationPolicy(.accessory) }
    let size: CGFloat = 26
    let frame = NSRect(x: point.x - size / 2, y: point.y - size / 2, width: size, height: size)
    let panel = PhantomPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel],
                             backing: .buffered, defer: false)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.level = .statusBar
    panel.ignoresMouseEvents = true
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    panel.contentView = PhantomView(frame: NSRect(origin: .zero, size: frame.size))
    panel.orderFrontRegardless()
    // The click happens in this same process, so the panel only has to survive a
    // few pumped run-loop turns; it goes away when the process exits.
    _ = seconds
}

func pump(_ seconds: Double) {
    RunLoop.main.run(until: Date().addingTimeInterval(seconds))
}


func refuse(_ payload: [String: Any]) -> Never {
    emit(payload)
    exit(1)
}

/// Resolve an optional --pid/--window target, bring it forward, run the shared
/// checks, and return the pid (nil when the command is purely positional).
@discardableResult
func guardedFocus(_ args: Args, action: String, point: CGPoint? = nil,
                  secure: Bool = false) -> pid_t? {
    let pair = resolveTargetPair(pid: args.int("pid"), window: args.int("window"), action: action)
    var pid: pid_t? = pair.pid
    let skip = args.flag("force") || args.flag("no-preflight")
    if let pid, !skip {
        _ = activate(pid: pid)
        let deadline = Date().addingTimeInterval(1.2)
        while Date() < deadline && frontmostPID() != pid { usleep(50_000) }
        if let refusal = preflight(action: action, point: point, pid: pid,
                                   requireFocus: true, secureAllowed: secure,
                                   ignoreSheet: args.flag("ignore-sheet")) {
            refuse(refusal)
        }
    } else if !skip {
        if let refusal = preflight(action: action, point: point, pid: nil,
                                   requireFocus: false, secureAllowed: secure,
                                   ignoreSheet: false) {
            refuse(refusal)
        }
    }
    return pid
}

// MARK: - menu


func axElement(_ raw: CFTypeRef?) -> AXUIElement? {
    guard let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
    return (raw as! AXUIElement)
}

func menuBar(_ pid: pid_t) -> AXUIElement? {
    axElement(attribute(AXUIElementCreateApplication(pid), kAXMenuBarAttribute))
}

func menuBarItems(_ pid: pid_t) -> [(title: String, element: AXUIElement)] {
    guard let bar = menuBar(pid) else { return [] }
    return children(bar).map { (stringAttribute($0, kAXTitleAttribute), $0) }
        .filter { !$0.0.isEmpty }
}

func menuItemElements(_ barItem: AXUIElement) -> [AXUIElement] {
    var items: [AXUIElement] = []
    for menu in children(barItem) {
        items.append(contentsOf: children(menu))
    }
    return items
}

func menuShortcut(_ item: AXUIElement) -> String {
    let key = stringAttribute(item, kAXMenuItemCmdCharAttribute)
    guard !key.isEmpty else { return "" }
    var mods = ""
    if let raw = attribute(item, kAXMenuItemCmdModifiersAttribute) as? Int {
        if raw & 1 == 0 { mods += "cmd+" }   // bit 0 means "no command" is set
        if raw & 2 != 0 { mods += "shift+" }
        if raw & 4 != 0 { mods += "opt+" }
        if raw & 8 != 0 { mods += "ctrl+" }
    }
    return mods + key
}

func menuTreeJSON(_ pid: pid_t, maxItems: Int = 60) -> [[String: Any]] {
    menuBarItems(pid).map { entry in
        let items: [[String: Any]] = menuItemElements(entry.element).prefix(maxItems).map { item in
            let title = stringAttribute(item, kAXTitleAttribute)
            var row: [String: Any] = ["title": title,
                                      "enabled": (attribute(item, kAXEnabledAttribute) as? Bool) ?? true]
            let shortcut = menuShortcut(item)
            if !shortcut.isEmpty { row["shortcut"] = shortcut }
            if !children(item).isEmpty { row["submenu"] = true }
            return row
        }.filter { !($0["title"] as? String ?? "").isEmpty }
        return ["title": entry.title, "items": items]
    }
}

let destructiveMenuWords = ["关闭", "退出", "删除", "清空", "移除", "格式化", "卸载", "抹掉",
                            "quit", "close", "delete", "remove", "erase", "empty", "format", "uninstall"]

func menuItemIsDestructive(_ title: String) -> Bool {
    let lower = title.lowercased()
    return destructiveMenuWords.contains { lower.contains($0.lowercased()) }
}

func pressMenuItem(pid: pid_t, path: [String], confirm: Bool) -> [String: Any] {
    guard path.count >= 2 else {
        return ["ok": false, "error": "need_menu_and_item",
                "message": "pass a menu and an item, e.g. --path \"File/New Window\"; use the listing to explore"]
    }
    guard let first = path.first else {
        return ["ok": false, "error": "empty_path", "message": "pass --path \"File/New\""]
    }
    guard let barItem = menuBarItems(pid).first(where: { $0.title == first })?.element else {
        return ["ok": false, "error": "menu_not_found", "message": "no menu bar item titled \(first)"]
    }
    _ = AXUIElementPerformAction(barItem, kAXPressAction as CFString)
    pump(0.15)

    var current = barItem
    var remaining = Array(path.dropFirst())
    var pressed: [String] = [first]
    while let next = remaining.first {
        let items = menuItemElements(current)
        guard let match = items.first(where: { stringAttribute($0, kAXTitleAttribute) == next }) else {
            _ = AXUIElementPerformAction(barItem, kAXCancelAction as CFString)
            return ["ok": false, "error": "menu_item_not_found",
                    "message": "no item titled \(next) under \(pressed.joined(separator: "/"))"]
        }
        if !confirm, menuItemIsDestructive(next) {
            _ = AXUIElementPerformAction(barItem, kAXCancelAction as CFString)
            return ["ok": false, "error": "destructive_menu_item",
                    "message": "\(next) looks destructive; pass confirm: true to allow it",
                    "path": (pressed + [next]).joined(separator: "/")]
        }
        let enabled = (attribute(match, kAXEnabledAttribute) as? Bool) ?? true
        guard enabled else {
            _ = AXUIElementPerformAction(barItem, kAXCancelAction as CFString)
            return ["ok": false, "error": "menu_item_disabled",
                    "message": "\(next) is greyed out"]
        }
        // A menu item that is on screen answers a real click more reliably than
        // AXPress does (Chromium ignores the action for open menus).
        if let frame = frame(of: match), frame.width >= 2, frame.height >= 2 {
            click(x: frame.midX, y: frame.midY, button: "left", count: 1)
        } else {
            _ = AXUIElementPerformAction(match, kAXPressAction as CFString)
        }
        pump(0.12)
        pressed.append(next)
        remaining.removeFirst()
        current = match
    }
    return ["ok": true, "action": "menu", "path": pressed.joined(separator: "/")]
}

// MARK: - misc window actions

func cursorPosition() -> CGPoint {
    CGEvent(source: nil)?.location ?? .zero
}

func releaseMouse() {
    let point = cursorPosition()
    CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseUp,
            mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
}

func axWindows(for target: WindowInfo) -> [AXUIElement] {
    guard let windows = attribute(AXUIElementCreateApplication(target.pid), kAXWindowsAttribute) as? [AXUIElement] else {
        return []
    }
    // A fullscreen window no longer matches its CG frame exactly, so fall back to
    // matching by title before giving up.
    var candidates = windows.filter { window in
        guard let frame = frame(of: window) else { return false }
        return abs(frame.origin.x - target.bounds.origin.x) <= 2
            && abs(frame.origin.y - target.bounds.origin.y) <= 2
            && abs(frame.width - target.bounds.width) <= 2
            && abs(frame.height - target.bounds.height) <= 2
    }
    if candidates.isEmpty, !target.title.isEmpty {
        candidates = windows.filter { stringAttribute($0, kAXTitleAttribute) == target.title }
    }
    return candidates
}

func firstDescendant(_ element: AXUIElement, depth: Int = 3,
                     where match: (AXUIElement) -> Bool) -> AXUIElement? {
    if match(element) { return element }
    guard depth > 0 else { return nil }
    for child in children(element) {
        if let found = firstDescendant(child, depth: depth - 1, where: match) { return found }
    }
    return nil
}

func zoomWindow(_ windowId: CGWindowID) -> [String: Any] {
    guard let target = onScreenWindows().first(where: { $0.id == windowId }) else {
        return ["ok": false, "error": "window_gone", "message": "window \(windowId) is not on screen"]
    }
    let candidates = axWindows(for: target)
    guard !candidates.isEmpty else {
        return ["ok": false, "error": "no_ax_windows", "message": "the app exposes no windows"]
    }
    for window in candidates {
        if let button = firstDescendant(window, depth: 4, where: { element in
            let subrole = stringAttribute(element, kAXSubroleAttribute)
            if subrole == "AXZoomButton" || subrole == "AXFullScreenButton" { return true }
            return stringAttribute(element, kAXRoleAttribute) == "AXButton"
                && stringAttribute(element, kAXDescriptionAttribute).lowercased().contains("zoom")
        }) {
            let status = AXUIElementPerformAction(button, kAXPressAction as CFString)
            return ["ok": status == .success, "action": "zoom", "windowId": Int(windowId)]
        }
    }
    // Fullscreen windows hide the green button; Escape is the toggle back.
    let screenArea = (NSScreen.screens.first?.frame.width ?? 1728)
        * (NSScreen.screens.first?.frame.height ?? 1117)
    if target.bounds.width * target.bounds.height > screenArea * 0.85 {
        pressToPid(target.pid, name: "escape", modifiers: [])
        return ["ok": true, "action": "zoom", "windowId": Int(windowId), "via": "escape",
                "note": "the window was fullscreen; sent Escape to leave it"]
    }
    return ["ok": false, "error": "no_zoom_button", "message": "no zoom button found on that window"]
}

// Moving/resizing through AX leaves focus and the cursor alone; a synthetic
// title-bar drag cannot, because AppKit only starts a window drag for the
// active app.
func moveWindow(_ windowId: CGWindowID, x: Double?, y: Double?,
                width: Double? = nil, height: Double? = nil) -> [String: Any] {
    guard let target = onScreenWindows().first(where: { $0.id == windowId }) else {
        return ["ok": false, "error": "window_gone", "message": "window \(windowId) is not on screen"]
    }
    guard let window = axWindows(for: target).first else {
        return ["ok": false, "error": "no_ax_windows", "message": "the app exposes no window for that id"]
    }
    if let x, let y {
        var point = CGPoint(x: x, y: y)
        guard let value = AXValueCreate(.cgPoint, &point) else {
            return ["ok": false, "error": "bad_point", "message": "could not encode the position"]
        }
        let status = AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, value)
        if status != .success {
            return ["ok": false, "error": "set_position_failed",
                    "message": "AXUIElementSetAttributeValue returned \(status.rawValue)"]
        }
    }
    if let width, let height {
        var size = CGSize(width: width, height: height)
        guard let value = AXValueCreate(.cgSize, &size) else {
            return ["ok": false, "error": "bad_size", "message": "could not encode the size"]
        }
        let status = AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, value)
        if status != .success {
            return ["ok": false, "error": "set_size_failed",
                    "message": "AXUIElementSetAttributeValue returned \(status.rawValue)"]
        }
    }
    let moved = frame(of: window).map { ["x": $0.origin.x, "y": $0.origin.y,
                                         "width": $0.size.width, "height": $0.size.height] } ?? [:]
    return ["ok": true, "action": "move", "windowId": Int(windowId), "frame": moved,
            "frontmostAfter": frontmost().app]
}


final class CoverView: NSView {
    var label: String = ""
    var onStop: (() -> Void)?

    override func draw(_ dirtyRect: NSRect) {
        NSColor(srgbRed: 0.07, green: 0.07, blue: 0.08, alpha: 0.28).setFill()
        bounds.fill()
        let border = bounds.insetBy(dx: 1.5, dy: 1.5)
        let path = NSBezierPath(roundedRect: border, xRadius: 10, yRadius: 10)
        path.lineWidth = 3
        NSColor(srgbRed: 0.85, green: 0.47, blue: 0.34, alpha: 0.95).setStroke()
        path.stroke()

        guard !label.isEmpty else { return }
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
            .foregroundColor: NSColor.white,
        ]
        let size = (label as NSString).size(withAttributes: attributes)
        let chip = NSRect(x: 10, y: bounds.height - 40, width: min(bounds.width - 20, size.width + 52), height: 28)
        NSColor(srgbRed: 0.10, green: 0.10, blue: 0.10, alpha: 0.92).setFill()
        NSBezierPath(roundedRect: chip, xRadius: 8, yRadius: 8).fill()
        NSColor(srgbRed: 0.85, green: 0.47, blue: 0.34, alpha: 1).setFill()
        NSBezierPath(ovalIn: NSRect(x: chip.minX + 9, y: chip.midY - 3.5, width: 7, height: 7)).fill()
        (label as NSString).draw(at: NSPoint(x: chip.minX + 24, y: chip.minY + 7), withAttributes: attributes)
        let stopRect = NSRect(x: chip.maxX - 24, y: chip.midY - 8, width: 16, height: 16)
        NSColor.white.withAlphaComponent(0.8).setStroke()
        let cross = NSBezierPath()
        cross.lineWidth = 1.7
        cross.move(to: NSPoint(x: stopRect.minX + 4, y: stopRect.minY + 4))
        cross.line(to: NSPoint(x: stopRect.maxX - 4, y: stopRect.maxY - 4))
        cross.move(to: NSPoint(x: stopRect.maxX - 4, y: stopRect.minY + 4))
        cross.line(to: NSPoint(x: stopRect.minX + 4, y: stopRect.maxY - 4))
        cross.stroke()
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if point.y > bounds.height - 48 {
            onStop?()
        }
    }
}

func runCover(windowId: CGWindowID, seconds: Double, label: String) -> Never {
    let previous = frontmostBeforeLaunch()
    guard let window = onScreenWindows().first(where: { $0.id == windowId }) else {
        fail("window_gone", "window \(windowId) is not on screen")
    }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let frame = cocoaFrame(for: window.bounds)
    let panel = HaloPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel],
                          backing: .buffered, defer: false)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.level = .statusBar
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    panel.ignoresMouseEvents = false   // an occluder: the user cannot click through it
    let view = CoverView(frame: NSRect(origin: .zero, size: frame.size))
    view.label = label.isEmpty ? "自动操作进行中 · 点右侧 × 停止" : label
    view.onStop = {
        markPause()
        emit(["ok": true, "cover": "stopped", "windowId": Int(windowId), "paused": true])
        exit(0)
    }
    panel.contentView = view
    panel.orderFrontRegardless()
    stayInBackground(previous)
    let follow = Timer(timeInterval: 0.25, repeats: true) { _ in
        guard let current = onScreenWindows().first(where: { $0.id == windowId }) else {
            emit(["ok": true, "cover": "window_gone", "windowId": Int(windowId)])
            exit(0)
        }
        let next = cocoaFrame(for: current.bounds)
        if next != panel.frame {
            panel.setFrame(next, display: true)
            panel.contentView?.frame = NSRect(origin: .zero, size: next.size)
            panel.contentView?.needsDisplay = true
        }
    }
    RunLoop.main.add(follow, forMode: .common)
    emit(["ok": true, "cover": "shown", "windowId": Int(windowId), "app": window.app])
    if seconds > 0 {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
            emit(["ok": true, "cover": "timeout", "windowId": Int(windowId)])
            exit(0)
        }
    }
    app.run()
    exit(0)
}

// MARK: - halo

func cocoaFrame(for cgFrame: CGRect) -> NSRect {
    let screenHeight = NSScreen.screens.first?.frame.height ?? 0
    return NSRect(x: cgFrame.origin.x,
                  y: screenHeight - cgFrame.origin.y - cgFrame.height,
                  width: cgFrame.width, height: cgFrame.height)
}

final class HaloView: NSView {
    var label: String = ""
    private let gradient = CAGradientLayer()
    private let outline = CAShapeLayer()
    private let glow = CAShapeLayer()

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        let blue = NSColor(srgbRed: 0.24, green: 0.48, blue: 1, alpha: 1).cgColor
        let cyan = NSColor(srgbRed: 0.28, green: 0.87, blue: 0.98, alpha: 1).cgColor
        let violet = NSColor(srgbRed: 0.66, green: 0.43, blue: 1, alpha: 1).cgColor
        gradient.colors = [blue, cyan, violet, blue]
        gradient.locations = [0, 0.34, 0.7, 1]
        gradient.startPoint = CGPoint(x: 0, y: 0)
        gradient.endPoint = CGPoint(x: 1, y: 1)
        outline.fillColor = nil
        outline.strokeColor = NSColor.white.cgColor
        outline.lineWidth = 1.8
        gradient.mask = outline
        glow.fillColor = nil
        glow.strokeColor = blue
        glow.lineWidth = 2
        glow.shadowColor = blue
        glow.shadowRadius = 7
        glow.shadowOpacity = 0.85
        glow.shadowOffset = .zero
        layer?.addSublayer(glow)
        layer?.addSublayer(gradient)
        NSWorkspace.shared.notificationCenter.addObserver(self,
            selector: #selector(displayOptionsChanged),
            name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil)
        displayOptionsChanged()
        updateGeometry()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit { NSWorkspace.shared.notificationCenter.removeObserver(self) }

    @objc private func displayOptionsChanged() {
        setReducedMotion(NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
    }

    func setReducedMotion(_ reduced: Bool) {
        // Render-server animation; no frame timer or repeated AppKit drawing.
        glow.removeAnimation(forKey: "breathing")
        guard !reduced else { return }
        let breathe = CABasicAnimation(keyPath: "opacity")
        breathe.fromValue = 0.35
        breathe.toValue = 0.8
        breathe.duration = 2.4
        breathe.autoreverses = true
        breathe.repeatCount = .infinity
        breathe.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        glow.add(breathe, forKey: "breathing")
    }

    private func updateGeometry() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        gradient.frame = bounds
        outline.frame = bounds
        glow.frame = bounds
        let path = CGPath(roundedRect: bounds.insetBy(dx: 12, dy: 12),
                          cornerWidth: 12, cornerHeight: 12, transform: nil)
        outline.path = path
        glow.path = path
        glow.shadowPath = path.copy(strokingWithWidth: 2, lineCap: .round,
                                    lineJoin: .round, miterLimit: 1)
        CATransaction.commit()
    }

    override func layout() {
        super.layout()
        updateGeometry()
    }

    // The panel also sets ignoresMouseEvents. View-level hitTest alone cannot
    // guarantee input passes through to a different application's window.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

final class HaloStopView: NSView {
    var label: String = ""
    var accent = NSColor(srgbRed: 0.28, green: 0.78, blue: 1, alpha: 1)
    var onStop: (() -> Void)?

    override func draw(_ dirtyRect: NSRect) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .medium),
            .foregroundColor: NSColor.white, .paragraphStyle: paragraph,
        ]
        let chip = bounds.insetBy(dx: 1, dy: 1)
        let chipPath = NSBezierPath(roundedRect: chip, xRadius: 7, yRadius: 7)
        NSColor(srgbRed: 0.10, green: 0.10, blue: 0.10, alpha: 0.88).setFill()
        chipPath.fill()
        accent.setFill()
        NSBezierPath(ovalIn: NSRect(x: chip.minX + 8, y: chip.midY - 3, width: 6, height: 6)).fill()
        (label as NSString).draw(in: NSRect(x: chip.minX + 20, y: chip.midY - 8,
                                           width: max(0, chip.width - 48), height: 16),
                                 withAttributes: attributes)
        NSColor.white.withAlphaComponent(0.85).setFill()
        NSBezierPath(roundedRect: NSRect(x: chip.maxX - 18, y: chip.midY - 4,
                                         width: 8, height: 8), xRadius: 2, yRadius: 2).fill()
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        toolTip = "Stop computer use"
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel("Stop computer use")
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = superview.map { convert(point, from: $0) } ?? point
        return bounds.contains(local) ? self : nil
    }

    override func accessibilityPerformPress() -> Bool {
        onStop?()
        return true
    }

    override func mouseDown(with event: NSEvent) { onStop?() }
}

final class HaloPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

let activityPath = NSString(string: "~/.cu/activity.json").expandingTildeInPath

func currentActivity() -> String? {
    guard let data = FileManager.default.contents(atPath: activityPath),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let text = object["text"] as? String, !text.isEmpty,
          let stamp = object["ts"] as? Double else { return nil }
    guard Date().timeIntervalSince1970 - stamp < 20 else { return nil }
    return text
}

func runHalo(windowId: CGWindowID, seconds: Double, label: String) -> Never {
    let previous = frontmostBeforeLaunch()
    guard let window = onScreenWindows().first(where: { $0.id == windowId }) else {
        fail("window_gone", "window \(windowId) is not on screen")
    }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)

    let frame = cocoaFrame(for: window.bounds).insetBy(dx: -12, dy: -12)
    let panel = HaloPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel],
                          backing: .buffered, defer: false)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.level = .statusBar
    panel.collectionBehavior = [.canJoinAllSpaces, .canJoinAllApplications,
                                .fullScreenAuxiliary, .stationary]
    panel.ignoresMouseEvents = true
    panel.contentView = HaloView(frame: NSRect(origin: .zero, size: frame.size))

    // Only this small panel receives input. NSView.hitTest cannot make the
    // window-sized panel pass clicks through to a different application.
    func controlFrame(_ target: NSRect) -> NSRect {
        let width = min(CGFloat(300), max(CGFloat(80), target.width - 32))
        return NSRect(x: target.minX + 16, y: target.maxY - 46, width: width, height: 28)
    }
    let control = HaloPanel(contentRect: controlFrame(frame),
        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    control.isOpaque = false
    control.backgroundColor = .clear
    control.hasShadow = false
    control.level = .statusBar
    control.collectionBehavior = panel.collectionBehavior
    let view = HaloStopView(frame: NSRect(origin: .zero, size: control.frame.size))
    view.label = label.isEmpty ? window.app : label
    view.onStop = {
        markPause()
        emit(["ok": true, "halo": "stopped", "windowId": Int(windowId), "paused": true])
        exit(0)
    }
    control.contentView = view
    panel.orderFrontRegardless()
    control.orderFrontRegardless()
    stayInBackground(previous)

    let activity = Timer(timeInterval: 0.3, repeats: true) { _ in
        let base = label.isEmpty ? window.app : label
        let next = currentActivity().map { "\(base) · \($0)" } ?? base
        if view.label != next {
            view.label = next
            view.needsDisplay = true
        }
    }
    activity.tolerance = 0.05
    RunLoop.main.add(activity, forMode: .common)

    // Query only the target: no window titles, app lookups or full desktop sweep.
    // Geometry follows at 30 Hz; breathing remains render-server driven.
    let follow = Timer(timeInterval: 1.0 / 30.0, repeats: true) { _ in
        guard let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, windowId)
                as? [[String: Any]],
              let row = rows.first,
              row[kCGWindowIsOnscreen as String] as? Bool == true,
              (row[kCGWindowAlpha as String] as? Double ?? 1) > 0.01,
              (row[kCGWindowLayer as String] as? Int ?? 0) == 0,
              let rawBounds = row[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: rawBounds),
              bounds.width >= 40, bounds.height >= 40 else {
            emit(["ok": true, "halo": "window_gone", "windowId": Int(windowId)])
            exit(0)
        }
        let next = cocoaFrame(for: bounds).insetBy(dx: -12, dy: -12)
        if next != panel.frame {
            panel.setFrame(next, display: true)
            panel.contentView?.frame = NSRect(origin: .zero, size: next.size)
            control.setFrame(controlFrame(next), display: true)
            view.frame = NSRect(origin: .zero, size: control.frame.size)
        }
    }
    RunLoop.main.add(follow, forMode: .common)

    emit(["ok": true, "halo": "shown", "windowId": Int(windowId),
          "app": window.app, "title": window.title])

    if seconds > 0 {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
            emit(["ok": true, "halo": "timeout", "windowId": Int(windowId)])
            exit(0)
        }
    }
    app.run()
    exit(0)
}

// MARK: - agent cursor overlay

/// A persistent, click-through layer that shows where the agent is pointing:
/// a soft glowing arrow that glides between points, a click ripple, and an
/// ambient screen-edge aurora while a session is active. It never moves the
/// real pointer and never takes input (level .statusBar, ignoresMouseEvents).
/// Commands arrive as JSON lines on stdin so one process serves a whole session.
// MARK: - capture daemon

/// Persistent capture process. Holding one warm `SCShareableContent` keeps the
/// ScreenCaptureKit path to ~53 ms median (p90 58 ms, n=20 on this machine) when
/// it answers at all; when it does not, the same process falls back to
/// `screencapture`, which measured 111–118 ms warm here versus 146–177 ms for a
/// per-shot spawn plus refine. Protocol: one JSON object per stdin line, one
/// JSON reply per stdout line.
final class CaptureDaemon {
    private var cached: SCShareableContent?

    /// ScreenCaptureKit's async capture either works in this process or it does
    /// not; it is a property of the OS build and the process context, not of the
    /// moment. Remembering a stall across daemon restarts keeps the very first
    /// preview of a session at ~300 ms instead of paying the 1.5 s detection
    /// again. It expires, so an OS update that fixes the path is picked up.
    private static let stallMarker = NSString(string: "~/.cu/sck-stall.json").expandingTildeInPath
    private static let osBuild = ProcessInfo.processInfo.operatingSystemVersionString

    private static func stalledRecently() -> Bool {
        guard let data = FileManager.default.contents(atPath: stallMarker),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["os"] as? String == osBuild,
              let at = object["at"] as? Double else { return false }
        return Date().timeIntervalSince1970 - at < 24 * 60 * 60
    }

    private static func rememberStall(_ stalled: Bool) {
        if !stalled {
            try? FileManager.default.removeItem(atPath: stallMarker)
            return
        }
        let object: [String: Any] = ["at": Date().timeIntervalSince1970, "os": osBuild]
        let directory = (stallMarker as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: directory,
                                                 withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(withJSONObject: object) {
            try? data.write(to: URL(fileURLWithPath: stallMarker))
        }
    }

    private func fetchContent() -> SCShareableContent? {
        let sem = DispatchSemaphore(value: 0)
        var fresh: SCShareableContent?
        Task {
            fresh = try? await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)
            sem.signal()
        }
        // Bounded: an unresponsive window server must not wedge daemon startup,
        // which runs on the main thread and would block the ready banner forever.
        if sem.wait(timeout: .now() + 2) == .timedOut { return nil }
        return fresh
    }

    func refresh() { cached = fetchContent() }

    private func content() -> SCShareableContent? {
        if let cached { return cached }
        refresh()
        return cached
    }

    /// Runs one capture synchronously (SCK is async-only). Returns nil on failure.
    ///
    /// ScreenCaptureKit's async completions do not arrive in every process
    /// context, and when they do not, the old 8 s wait made every preview cost a
    /// full timeout and return nothing (the plugin then paid a second capture on
    /// the CLI path). A healthy SCK answers in 100–300 ms, so the wait is short
    /// and a stall falls through to `screencapture`, which keeps its own TCC
    /// identity and measured ~250–380 ms here.
    func capture(windowId: CGWindowID?, screen: Bool, displayIndex: Int,
                 maxDimension: Int = 0) -> Capture? {
        if !sckStalled, let shot = captureViaScreenCaptureKit(
            windowId: windowId, screen: screen, displayIndex: displayIndex,
            maxDimension: maxDimension) {
            return shot
        }
        return captureViaCLI(windowId: windowId, screen: screen,
                             displayIndex: displayIndex)
    }

    /// True once SCK stopped answering, so later requests skip its timeout.
    private var sckStalled = CaptureDaemon.stalledRecently()

    private func captureViaScreenCaptureKit(windowId: CGWindowID?, screen: Bool,
                                            displayIndex: Int,
                                            maxDimension: Int) -> Capture? {
        // The cached SCWindow.frame goes stale as soon as the window moves or
        // resizes, and it is what the caller's coordinates are computed from. One
        // cheap window-list sweep keeps the reported origin/size true; the cached
        // list is only used to find the capture filter.
        let liveBounds = windowId.flatMap { id in
            onScreenWindows().first(where: { $0.id == id })?.bounds
        }
        func attempt(_ list: SCShareableContent) -> Capture? {
            let sem = DispatchSemaphore(value: 0)
            var box: Capture?
            Task {
                box = await shoot(list, windowId: windowId, screen: screen,
                                  displayIndex: displayIndex, maxDimension: maxDimension,
                                  liveBounds: liveBounds)
                sem.signal()
            }
            if sem.wait(timeout: .now() + 1.5) == .timedOut {
                if !sckStalled { Self.rememberStall(true) }
                sckStalled = true
                return nil
            }
            if box == nil {
                // It answered, but with nothing: the window was in the list, so
                // this is a capture failure, not a missing window. Prefer the
                // CLI path for the rest of this OS build instead of paying the
                // 1.5 s detection on every new daemon.
                if !sckStalled { Self.rememberStall(true) }
                sckStalled = true
                return nil
            }
            if sckStalled {
                sckStalled = false
                Self.rememberStall(false)
            }
            return box
        }
        // A window opened after the daemon started is absent from the cached
        // list. On a window miss, refresh once and retry, so a long session does
        // not lose sight of new windows while still paying the cache cost only
        // on the cold path.
        if let list = content() {
            if screen || windowId == nil { return attempt(list) }
            if list.windows.contains(where: { $0.windowID == windowId }) {
                return attempt(list)
            }
        }
        refresh()
        guard let refreshed = content() else { return nil }
        return attempt(refreshed)
    }

    private func captureViaCLI(windowId: CGWindowID?, screen: Bool,
                               displayIndex: Int) -> Capture? {
        let bounds = windowId.flatMap { id in
            onScreenWindows().first(where: { $0.id == id })?.bounds
        }
        if !screen, windowId != nil, bounds == nil { return nil }
        return try? cliCapture(windowId: windowId, screen: screen,
                               displayIndex: displayIndex, bounds: bounds)
    }

    private func shoot(_ list: SCShareableContent, windowId: CGWindowID?,
                       screen: Bool, displayIndex: Int,
                       maxDimension: Int, liveBounds: CGRect? = nil) async -> Capture? {
        var filter: SCContentFilter
        var area: CGRect
        if screen || windowId == nil {
            let displays = list.displays.sorted { $0.displayID < $1.displayID }
            guard displayIndex >= 0, displayIndex < displays.count else { return nil }
            let display = displays[displayIndex]
            filter = SCContentFilter(display: display, excludingWindows: [])
            let sc = NSScreen.screens.first {
                ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?
                    .uint32Value == display.displayID
            }
            let frame = sc?.frame ?? CGRect(x: 0, y: 0, width: CGFloat(display.width),
                                            height: CGFloat(display.height))
            let screenHeight = NSScreen.screens.first?.frame.height ?? frame.height
            area = CGRect(x: frame.origin.x, y: screenHeight - frame.origin.y - frame.height,
                          width: frame.width, height: frame.height)
        } else {
            guard let window = list.windows.first(where: { $0.windowID == windowId }) else {
                return nil
            }
            filter = SCContentFilter(desktopIndependentWindow: window)
            area = liveBounds ?? window.frame
        }
        // Capture at the requested size rather than native-then-downscale. The
        // window server does the resampling in its own pipeline, which is much
        // cheaper than decoding a full Retina PNG here and re-encoding it.
        let nativeWidth = Int(max(1, area.width) * 2)
        let nativeHeight = Int(max(1, area.height) * 2)
        var width = nativeWidth
        var height = nativeHeight
        if maxDimension > 0 && nativeWidth > maxDimension {
            let ratio = Double(maxDimension) / Double(nativeWidth)
            width = maxDimension
            height = max(1, Int((Double(nativeHeight) * ratio).rounded()))
        }
        let cfg = SCStreamConfiguration()
        cfg.width = width
        cfg.height = height
        cfg.showsCursor = false
        cfg.captureResolution = .best
        guard let image = try? await SCScreenshotManager.captureImage(
            contentFilter: filter, configuration: cfg) else { return nil }
        guard let png = NSBitmapImageRep(cgImage: image).representation(
            using: .png, properties: [:]) else { return nil }
        let scale = area.width > 0 ? Double(image.width) / Double(area.width) : 2
        return Capture(png: png, origin: area.origin, size: area.size, scale: scale)
    }
}

let captureReplyLock = NSLock()

func captureDaemonReply(_ object: [String: Any]) {
    captureReplyLock.lock()
    defer { captureReplyLock.unlock() }
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}

/// Handles one request line and returns false when the daemon should exit.
func captureDaemonHandle(_ line: String, _ daemon: CaptureDaemon) -> Bool {
    guard let data = line.data(using: .utf8),
          let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let cmd = request["cmd"] as? String else { return true }
    switch cmd {
    case "quit":
        return false
    case "refresh":
        daemon.refresh()
        captureDaemonReply(["ok": true, "refreshed": true])
    case "shot":
        let wid = (request["windowId"] as? NSNumber)?.uint32Value
        let screen = request["screen"] as? Bool ?? false
        let display = request["display"] as? Int ?? 0
        let maxDim = (request["maxDim"] as? NSNumber)?.intValue ?? 0
        guard let raw = daemon.capture(windowId: wid.flatMap { CGWindowID($0) },
                                       screen: screen, displayIndex: display,
                                       maxDimension: maxDim) else {
            captureDaemonReply(["ok": false, "error": "capture_failed"])
            return true
        }
        let format = ((request["format"] as? String) ?? "jpeg").lowercased()
        let quality = (request["quality"] as? NSNumber)?.doubleValue ?? 0.76
        do {
            let shot = try refine(raw, region: nil,
                                  format: format == "png" ? "png" : "jpeg",
                                  quality: quality, maxDimension: maxDim)
            var payload: [String: Any] = [:]
            payload["ok"] = true
            payload["base64"] = shot.png.base64EncodedString()
            payload["mimeType"] = shot.encoding == "jpeg" ? "image/jpeg" : "image/png"
            payload["width"] = Int(shot.size.width * shot.scale)
            payload["height"] = Int(shot.size.height * shot.scale)
            payload["origin"] = ["x": shot.origin.x, "y": shot.origin.y] as [String: Any]
            payload["size"] = ["width": shot.size.width,
                               "height": shot.size.height] as [String: Any]
            payload["scale"] = shot.scale
            // Freshness matters more than any single field: a caller must be able
            // to tell an image of the window as it is now from one taken before it
            // moved.
            payload["capturedAt"] = Int(Date().timeIntervalSince1970 * 1000)
            if let display = displayId(containing: CGPoint(x: shot.origin.x + shot.size.width / 2,
                                                           y: shot.origin.y + shot.size.height / 2)) {
                payload["displayId"] = display
            }
            captureDaemonReply(payload)
        } catch {
            captureDaemonReply(["ok": false, "error": "encode_failed"])
        }
    default:
        captureDaemonReply(["ok": false, "error": "unknown_command"])
    }
    return true
}

func runCaptureDaemon() -> Never {
    _ = NSApplication.shared
    let daemon = CaptureDaemon()
    daemon.refresh()
    captureDaemonReply(["ok": true, "captureDaemon": "ready"])
    DispatchQueue(label: "cu.capture.stdin").async {
        while let line = readLine(strippingNewline: true) {
            if !captureDaemonHandle(line, daemon) { exit(0) }
        }
        exit(0)
    }
    RunLoop.main.run()
    exit(0)
}

/// Keeps a real ScreenCaptureKit display stream alive for the lifetime of a CU
/// session. Besides warming the capture path, this is what makes macOS show its
/// own "screen recording is active" indicator in the menu bar — the same system
/// reminder Codex's built-in computer use shows while it drives the desktop.
final class ScreenRecordingIndicator: NSObject, SCStreamOutput {
    private var stream: SCStream?
    private let sampleQueue = DispatchQueue(label: "cu.screen-indicator.samples")

    func start() -> String? {
        if stream != nil { return nil }
        let sem = DispatchSemaphore(value: 0)
        var displays: [SCDisplay] = []
        Task {
            if let content = try? await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true) {
                displays = content.displays
            }
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + 5)
        guard let display = displays.first else { return "no_display" }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let configuration = SCStreamConfiguration()
        // Deliberately tiny and slow: the goal is the system indicator and a
        // warm capture path, not frames. One frame per second costs almost
        // nothing while still qualifying as an active screen capture.
        configuration.width = 32
        configuration.height = 18
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        configuration.queueDepth = 1
        configuration.showsCursor = false
        do {
            let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
            try stream.startCapture()
            self.stream = stream
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    func stop() {
        try? stream?.stopCapture()
        stream = nil
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of outputType: SCStreamOutputType) {
        // Frames are intentionally ignored; the stream exists for its liveness.
    }
}

/// Ask the always-running menu-bar app to own the display stream. Owning it in
/// the app (a real bundle process with its own Screen Recording grant) is what
/// makes macOS raise its system indicator reliably, and it lets our menu-bar
/// item show the same "recording" state while a session is active.
func runScreenIndicator() -> Never {
    let on: Bool
    if let state = args["state"] {
        on = state != "off"
    } else {
        on = !args.flag("off")
    }
    DistributedNotificationCenter.default().post(
        name: NSNotification.Name("local.cu.screen-indicator"),
        object: nil, userInfo: ["active": on])
    emit(["ok": true, "screenIndicator": on ? "on" : "off"])
    exit(0)
}

func runCursorOverlay() -> Never {
    let previous = frontmostBeforeLaunch()
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    // One transparent panel PER DISPLAY (Task 5). Each panel maps the global
    // top-left point space into its own Cocoa frame, so screen gaps, negative
    // origins and mixed scales never collide the way one union overlay did.
    let screens = NSScreen.screens
    let specs = screens.map {
        ScreenSpec(originX: $0.frame.origin.x, originY: $0.frame.origin.y,
                   width: $0.frame.width, height: $0.frame.height)
    }
    let mainTop = screens.first?.frame.maxY ?? (specs.first.map { $0.originY + $0.height } ?? 900)
    var overlays: [(panel: HaloPanel, view: CursorLayerView)] = []
    for screen in screens {
        let panel = HaloPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel],
                              backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .statusBar
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .canJoinAllApplications,
                                    .fullScreenAuxiliary, .stationary]
        let view = CursorLayerView(frame: NSRect(origin: .zero, size: screen.frame.size))
        view.overlayOrigin = screen.frame.origin
        view.mainScreenTop = mainTop
        panel.contentView = view
        panel.orderFrontRegardless()
        overlays.append((panel, view))
    }
    // Follow the system accessibility setting live on every panel's view.
    let motionViews = overlays.map { $0.view }
    var motionObserver: NSObjectProtocol?
    motionObserver = NSWorkspace.shared.notificationCenter.addObserver(
        forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification,
        object: nil, queue: .main) { _ in
        for view in motionViews { view.refreshMotionPreference() }
    }
    _ = motionObserver
    stayInBackground(previous)

    // Dedicated reader thread: blocking stdin reads must not stall the main run
    // loop that drives Core Animation.
    DispatchQueue(label: "cu.cursor.stdin").async {
        while let line = readLine(strippingNewline: true) {
            guard let data = line.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let cmd = object["cmd"] as? String else { continue }
            DispatchQueue.main.async {
                for overlay in overlays { overlay.view.noteActivity() }
                func targetView(_ point: CGPoint) -> CursorLayerView {
                    if let index = screenIndex(forGlobal: point, screens: specs, mainTop: mainTop) {
                        return overlays[index].view
                    }
                    return overlays.first!.view
                }
                switch cmd {
                case "cursor":
                    let x = (object["x"] as? NSNumber)?.doubleValue ?? 0
                    let y = (object["y"] as? NSNumber)?.doubleValue ?? 0
                    let view = targetView(CGPoint(x: x, y: y))
                    view.pulseAura()
                    view.scheduleCursor(at: CGPoint(x: x, y: y),
                                        glide: object["glide"] as? Bool ?? true)
                case "click":
                    let x = (object["x"] as? NSNumber)?.doubleValue ?? 0
                    let y = (object["y"] as? NSNumber)?.doubleValue ?? 0
                    let view = targetView(CGPoint(x: x, y: y))
                    view.pulseAura()
                    view.clickRipple(at: CGPoint(x: x, y: y))
                case "label":
                    let x = (object["x"] as? NSNumber)?.doubleValue ?? 0
                    let y = (object["y"] as? NSNumber)?.doubleValue ?? 0
                    let view = targetView(CGPoint(x: x, y: y))
                    view.pulseAura()
                    view.showLabel(object["text"] as? String ?? "", at: CGPoint(x: x, y: y))
                case "aura":
                    for overlay in overlays { overlay.view.setAura(object["visible"] as? Bool ?? true) }
                case "hide":
                    for overlay in overlays { overlay.view.hide() }
                default:
                    break
                }
            }
        }
        // stdin closed: the plugin went away, so exit and leave no orphan.
        DispatchQueue.main.async { exit(0) }
    }

    // A session can end without a stop call (host reload, crashed client). Exit
    // after 2 idle hours so the overlay process never lives forever, without
    // pulling the cursor visuals out from under a long-but-alive session.
    let idleTimer = Timer(timeInterval: 30, repeats: true) { _ in
        let lastActivity = overlays.map { $0.view.lastActivityAt }.max() ?? Date(); if Date().timeIntervalSince(lastActivity) > 120 * 60 { exit(0) }
    }
    RunLoop.main.add(idleTimer, forMode: .common)
    emit(["ok": true, "cursor": "ready"])
    app.run()
    exit(0)
}

// MARK: - capsule

/// A Claude-style floating pill: it sits in a corner of the screen, names the app
/// being driven, shows what the agent is doing right now, and carries a stop
/// button. Unlike `halo` it is not tied to a window, so it never sits on top of
/// the app the user is trying to click, and it costs one small timer instead of a
/// full window sweep four times a second.
final class CapsuleView: NSView {
    var label: String = ""
    var activity: String = ""
    var onStop: (() -> Void)?
    var startedAt = Date()
    private let glass = NSVisualEffectView()
    private let border = CAShapeLayer()
    private let gradient = CAGradientLayer()
    private let dot = CAShapeLayer()
    private let dotGlow = CAShapeLayer()

    var stopRect: NSRect {
        NSRect(x: bounds.width - 34, y: (bounds.height - 20) / 2, width: 20, height: 20)
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        // Frosted glass body: real backdrop blur, not a flat translucent fill.
        glass.material = .hudWindow
        glass.blendingMode = .behindWindow
        glass.state = .active
        // Force dark vibrancy: over a bright document the default material
        // washes out and white text loses contrast.
        glass.appearance = NSAppearance(named: .darkAqua)
        glass.autoresizingMask = [.width, .height]
        glass.frame = bounds
        glass.wantsLayer = true
        glass.layer?.cornerRadius = bounds.height / 2
        glass.layer?.masksToBounds = true
        addSubview(glass)
        addSubview(overlay)

        let blue = NSColor(srgbRed: 0.24, green: 0.55, blue: 1, alpha: 1).cgColor
        let cyan = NSColor(srgbRed: 0.30, green: 0.88, blue: 0.98, alpha: 1).cgColor
        let violet = NSColor(srgbRed: 0.62, green: 0.44, blue: 1, alpha: 1).cgColor
        gradient.colors = [blue, cyan, violet, blue]
        gradient.locations = [0, 0.4, 0.75, 1]
        gradient.startPoint = CGPoint(x: 0, y: 0.5)
        gradient.endPoint = CGPoint(x: 1, y: 0.5)
        border.fillColor = nil
        border.strokeColor = NSColor.white.cgColor
        border.lineWidth = 1.2
        gradient.mask = border
        gradient.opacity = 0.9
        overlay.layer?.addSublayer(gradient)

        dot.fillColor = cyan
        dot.shadowColor = cyan
        dot.shadowRadius = 3
        dot.shadowOpacity = 0.9
        dot.shadowOffset = .zero
        dotGlow.fillColor = cyan
        dotGlow.opacity = 0.35
        overlay.layer?.addSublayer(dotGlow)
        overlay.layer?.addSublayer(dot)
        layoutLayers()
        startPulse()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func layoutLayers() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        glass.frame = bounds
        glass.layer?.cornerRadius = bounds.height / 2
        gradient.frame = bounds
        let radius = bounds.height / 2 - 1
        border.path = CGPath(roundedRect: bounds.insetBy(dx: 1, dy: 1),
                             cornerWidth: radius, cornerHeight: radius, transform: nil)
        let c = CGPoint(x: 17, y: bounds.midY)
        dot.path = CGPath(ellipseIn: CGRect(x: c.x - 3.5, y: c.y - 3.5,
                                            width: 7, height: 7), transform: nil)
        dotGlow.path = CGPath(ellipseIn: CGRect(x: c.x - 8, y: c.y - 8,
                                                width: 16, height: 16), transform: nil)
        CATransaction.commit()
    }

    private func startPulse() {
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
        let pulse = CABasicAnimation(keyPath: "opacity")
        pulse.fromValue = 0.12
        pulse.toValue = 0.55
        pulse.duration = 1.5
        pulse.autoreverses = true
        pulse.repeatCount = .infinity
        pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        dotGlow.add(pulse, forKey: "pulse")
        let breathe = CABasicAnimation(keyPath: "transform.scale")
        breathe.fromValue = 0.9
        breathe.toValue = 1.12
        breathe.duration = 1.5
        breathe.autoreverses = true
        breathe.repeatCount = .infinity
        breathe.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        dot.add(breathe, forKey: "breathe")
    }

    /// Text/stop-glyph overlay drawn above the glass (subviews render above the
    /// parent's own draw(), so this cannot live in CapsuleView.draw).
    final class Overlay: NSView {
        weak var owner: CapsuleView?
        override var isFlipped: Bool { false }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func draw(_ dirtyRect: NSRect) {
            guard let owner else { return }
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineBreakMode = .byTruncatingTail
            let titleAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
                .foregroundColor: NSColor.white.withAlphaComponent(0.96),
                .paragraphStyle: paragraph,
            ]
            let subAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 10.5, weight: .regular),
                .foregroundColor: NSColor.white.withAlphaComponent(0.62),
                .paragraphStyle: paragraph,
            ]
            let b = owner.bounds
            let elapsed = Int(Date().timeIntervalSince(owner.startedAt))
            let timer = String(format: "%d:%02d", elapsed / 60, elapsed % 60)
            let textX: CGFloat = 30
            let textW = b.width - textX - 74
            if owner.activity.isEmpty {
                (owner.label as NSString).draw(in: NSRect(x: textX, y: (b.height - 16) / 2,
                                                          width: textW, height: 16),
                                               withAttributes: titleAttrs)
            } else {
                (owner.label as NSString).draw(in: NSRect(x: textX, y: b.midY + 1,
                                                          width: textW, height: 14),
                                               withAttributes: titleAttrs)
                (owner.activity as NSString).draw(in: NSRect(x: textX, y: b.midY - 14,
                                                             width: textW, height: 13),
                                                  withAttributes: subAttrs)
            }
            let timerAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .medium),
                .foregroundColor: NSColor.white.withAlphaComponent(0.45),
            ]
            (timer as NSString).draw(at: NSPoint(x: b.width - 66, y: b.midY - 6),
                                     withAttributes: timerAttrs)
            NSColor.white.withAlphaComponent(0.7).setStroke()
            let cross = NSBezierPath()
            cross.lineWidth = 1.5
            let box = owner.stopRect.insetBy(dx: 6, dy: 6)
            cross.move(to: NSPoint(x: box.minX, y: box.minY))
            cross.line(to: NSPoint(x: box.maxX, y: box.maxY))
            cross.move(to: NSPoint(x: box.maxX, y: box.minY))
            cross.line(to: NSPoint(x: box.minX, y: box.maxY))
            cross.stroke()
        }
    }

    private lazy var overlay: Overlay = {
        let v = Overlay(frame: bounds)
        v.owner = self
        v.wantsLayer = true
        v.autoresizingMask = [.width, .height]
        return v
    }()

    override func layout() {
        super.layout()
        layoutLayers()
        overlay.frame = bounds
        overlay.needsDisplay = true
    }

    // Everything outside the stop button is click-through.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = superview.map { convert(point, from: $0) } ?? point
        return stopRect.insetBy(dx: -8, dy: -8).contains(local) ? self : nil
    }

    override func mouseDown(with event: NSEvent) { onStop?() }

    // Expose Stop to VoiceOver and automation without making the rest of the
    // pill focusable (it is decoration).
    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .button }
    override func accessibilityLabel() -> String? { "Stop computer use" }
    override func accessibilityHelp() -> String? { "Stops the running Computer Use session and pauses further actions." }
    override func accessibilityFrame() -> NSRect {
        guard let window = window else { return .zero }
        let inWindow = convert(stopRect, to: nil)
        return window.convertToScreen(inWindow)
    }
    override func accessibilityPerformPress() -> Bool { onStop?(); return true }
}

func runCapsule(label: String, seconds: Double) -> Never {
    let previous = frontmostBeforeLaunch()
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)

    // One capsule per session: a second one takes over from the first.
    let pidPath = NSString(string: "~/.cu/capsule.pid").expandingTildeInPath
    if let text = try? String(contentsOfFile: pidPath, encoding: .utf8),
       let previous = pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)),
       previous > 0, previous != getpid(),
       NSRunningApplication(processIdentifier: previous)?.executableURL?
        .lastPathComponent == "cu" {
        NSRunningApplication(processIdentifier: previous)?.terminate()
    }
    try? FileManager.default.createDirectory(atPath: NSString(string: "~/.cu").expandingTildeInPath,
                                            withIntermediateDirectories: true)
    try? "\(getpid())".write(toFile: pidPath, atomically: true, encoding: .utf8)

    let width: CGFloat = 340
    let height: CGFloat = 46
    let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let frame = NSRect(x: screen.maxX - width - 20, y: screen.maxY - height - 12,
                       width: width, height: height)
    let panel = HaloPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel],
                          backing: .buffered, defer: false)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.level = .statusBar
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    panel.ignoresMouseEvents = false

    let view = CapsuleView(frame: NSRect(origin: .zero, size: frame.size))
    view.label = label.isEmpty ? "Computer Use" : label
    view.onStop = {
        markPause()
        emit(["ok": true, "capsule": "stopped", "paused": true])
        exit(0)
    }
    panel.contentView = view
    panel.orderFrontRegardless()
    // Launching AppKit is what steals focus, not the panel: give it straight
    // back so the pill floats without ever owning the active app.
    stayInBackground(previous)

    let tick = Timer(timeInterval: 0.3, repeats: true) { _ in
        let text = currentActivity() ?? ""
        if view.activity != text {
            view.activity = text
            view.needsDisplay = true
        }
    }
    // Separate 1 Hz clock tick so the elapsed timer advances without forcing a
    // redraw on every activity poll.
    let clock = Timer(timeInterval: 1.0, repeats: true) { _ in
        view.needsDisplay = true
    }
    RunLoop.main.add(tick, forMode: .common)
    RunLoop.main.add(clock, forMode: .common)

    emit(["ok": true, "capsule": "shown", "label": view.label])
    if seconds > 0 {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
            try? FileManager.default.removeItem(atPath: pidPath)
            emit(["ok": true, "capsule": "timeout"])
            exit(0)
        }
    }
    app.run()
    exit(0)
}

// MARK: - element refs

// One fixed walk for both `snapshot` and every ref-based action, so the index
// a caller saw is the index we resolve. Changing these constants changes the
// numbering: bump SNAP_VERSION when you touch them.
// Chromium/Electron nest their web content under ~10 layers of anonymous AXGroup,
// so a shallower cap silently returns "window chrome only" for those apps.
let SNAP_DEPTH = 24
let SNAP_LIMIT = 800
let SNAP_VERSION = 2

/// Which route the last ref lookup took, reported in click/type/setvalue results.
/// "path" means the index walk answered; anything else means it fell back to a
/// full snapshot and says why.
var lastResolve = "path"

struct SnapNode {
    let element: AXUIElement   // valid for this process only; never serialised
    let index: Int
    let path: String        // child-index path from the app root, e.g. "0.3.2"
    let role: String
    let title: String
    let value: String
    let frame: CGRect?
    let enabled: Bool
    let focused: Bool
    let subrole: String
    let actions: [String]
    let secure: Bool
    var ref: String { "k" + path }
}

let WALK_ATTRIBUTES = [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
                       kAXValueAttribute, kAXEnabledAttribute, kAXPositionAttribute,
                       kAXSizeAttribute, kAXFocusedAttribute, kAXSubroleAttribute]

func multiAttributes(_ element: AXUIElement) -> [CFTypeRef] {
    var values: CFArray?
    let status = AXUIElementCopyMultipleAttributeValues(
        element, WALK_ATTRIBUTES as CFArray,
        AXCopyMultipleAttributeOptions(rawValue: 0), &values)
    guard status == .success, let list = values as? [CFTypeRef] else {
        return Array(repeating: kCFNull, count: WALK_ATTRIBUTES.count)
    }
    return list
}

func axValue(_ raw: CFTypeRef) -> AXValue? {
    guard CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    return (raw as! AXValue)
}

func actionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success,
          let list = names as? [String] else { return [] }
    return list
}

// The order of an app's top-level AX children is not stable — window ordering
// flips when one window comes forward, which would renumber every path below
// them. Sorting the root's children by a content key keeps refs meaningful
// across snapshots; deeper levels are already stable in practice.
func orderedChildren(_ element: AXUIElement, level: Int) -> [AXUIElement] {
    let kids = children(element)
    guard level == 0 else { return kids }
    func key(_ element: AXUIElement) -> String {
        let frame = frame(of: element).map {
            "\(Int($0.origin.x)),\(Int($0.origin.y)),\(Int($0.width)),\(Int($0.height))"
        } ?? ""
        // Document and identifier separate windows that share a title (Chrome's
        // many "about:blank" windows), which keeps path refs stable.
        return stringAttribute(element, kAXRoleAttribute) + "|"
            + stringAttribute(element, kAXTitleAttribute) + "|"
            + stringAttribute(element, kAXDocumentAttribute) + "|"
            + stringAttribute(element, "AXIdentifier") + "|" + frame
    }
    return kids.sorted { key($0) < key($1) }
}

// Chromium and Electron keep their accessibility tree switched off until a
// client asks for it; the shipped engine flips the same manual-accessibility
// flag ("setManualAccessibility", "AXManualAccessibility" in its helper).
func prepareAX(_ root: AXUIElement) {
    // Once an app has the flag the tree stays on, so the 120 ms settling sleep is
    // only paid the first time this process touches it.
    if let current = attribute(root, "AXManualAccessibility") as? Bool, current {
        return
    }
    // Native apps reject this attribute outright. Sleeping anyway cost every
    // snapshot and every ref action a flat 120 ms on every app that is not
    // Chromium/Electron — which is most of them. Only wait when it took.
    guard AXUIElementSetAttributeValue(
        root, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success,
          (attribute(root, "AXManualAccessibility") as? Bool) == true else { return }
    usleep(120_000)
}

/// The AX element that stands for a CGWindowID, plus its index among the app's
/// sorted top-level children. Both the snapshot walk and the ref resolver use
/// this, so an index path means the same element in both.
func windowRoot(pid: pid_t, root: AXUIElement,
                windowId: CGWindowID) -> (element: AXUIElement, index: Int)? {
    guard let target = onScreenWindows().first(where: { $0.id == windowId && $0.pid == pid }) else { return nil }
    let topLevel = orderedChildren(root, level: 0)
    let candidates = topLevel.indices.filter {
        stringAttribute(topLevel[$0], kAXRoleAttribute) == "AXWindow"
    }
    let frameMatches = candidates.filter { index in
        guard let frame = frame(of: topLevel[index]) else { return false }
        return abs(frame.origin.x - target.bounds.origin.x) <= 4
            && abs(frame.origin.y - target.bounds.origin.y) <= 4
            && abs(frame.width - target.bounds.width) <= 4
            && abs(frame.height - target.bounds.height) <= 4
    }
    if frameMatches.count == 1, let index = frameMatches.first {
        return (topLevel[index], index)
    }
    guard frameMatches.isEmpty, !target.title.isEmpty else { return nil }
    let titleMatches = candidates.filter { index in
        let axTitle = stringAttribute(topLevel[index], kAXTitleAttribute)
        return axTitle == target.title || axTitle.hasPrefix(target.title + " - ")
    }
    guard titleMatches.count == 1, let index = titleMatches.first else { return nil }
    return (topLevel[index], index)
}

func snapshotNodes(pid: pid_t, includeZeroSize: Bool = false,
                   windowId: CGWindowID? = nil,
                   includeActions: Bool = true,
                   limit: Int = SNAP_LIMIT,
                   maxDepth: Int = SNAP_DEPTH) -> (app: String, nodes: [SnapNode], truncated: Bool) {
    let root = AXUIElementCreateApplication(pid)
    prepareAX(root)
    var nodes: [SnapNode] = []
    var queue: [(AXUIElement, Int, String)] = [(root, 0, "")]
    // Window-scoped snapshots: walk only the AX subtree that matches the target
    // window, so several windows of the same app (Chrome!) cannot be confused.
    if let windowId {
        guard let window = windowRoot(pid: pid, root: root, windowId: windowId) else {
            fail("window_scope_unavailable", "the requested window could not be matched to this app", ["pid": Int(pid), "windowId": Int(windowId)])
        }
        queue = [(window.element, -1, "\(window.index)")]
    }
    var index = 0
    while !queue.isEmpty && nodes.count < limit {
        let (element, level, parentPath) = queue.removeFirst()
        if level >= maxDepth { continue }
        for (childIndex, child) in orderedChildren(element, level: level).enumerated() {
            let path = parentPath.isEmpty ? "\(childIndex)" : "\(parentPath).\(childIndex)"
            // One IPC round trip for the whole attribute set; asking for nine
            // attributes one by one is what made a 400-node walk take half a second.
            let batch = multiAttributes(child)
            func text(_ index: Int) -> String { batch[index] as? String ?? "" }
            let role = text(0)
            let title = text(1)
            let description = text(2)
            let label = title.isEmpty ? description : title
            let value = text(3)
            let enabled = (batch[4] as? Bool) ?? true
            var frame: CGRect?
            if let positionValue = axValue(batch[5]), let sizeValue = axValue(batch[6]) {
                var origin = CGPoint.zero
                var size = CGSize.zero
                if AXValueGetValue(positionValue, .cgPoint, &origin),
                   AXValueGetValue(sizeValue, .cgSize, &size) {
                    frame = CGRect(origin: origin, size: size)
                }
            }
            let focused = (batch[7] as? Bool) ?? false
            let subrole = text(8)
            // actionNames is one extra IPC per node; callers that only need
            // structure (post-action delta observes) can skip it.
            let actions = includeActions ? actionNames(child) : []
            index += 1
            if includeZeroSize || (frame?.width ?? 0) >= 1 && (frame?.height ?? 0) >= 1
                || !actions.isEmpty || (!label.isEmpty && frame != nil) {
                nodes.append(SnapNode(element: child, index: index, path: path, role: role, title: label,
                                      value: String(value.prefix(200)), frame: frame,
                                      enabled: enabled, focused: focused, subrole: subrole,
                                      actions: actions,
                                      secure: role == "AXSecureTextField" || subrole == "AXSecureTextField"))
            }
            queue.append((child, level + 1, path))
        }
    }
    let app = NSRunningApplication(processIdentifier: pid)?.localizedName ?? ""
    // The walk stops at SNAP_LIMIT; surface that so a caller never mistakes a
    // partial tree for the whole app (big editors can exceed 800 elements).
    let truncated = nodes.count >= limit || !queue.isEmpty
    return (app, nodes, truncated)
}

func element(pid: pid_t, path: String, windowId: CGWindowID? = nil) -> AXUIElement? {
    let root: AXUIElement = AXUIElementCreateApplication(pid)
    prepareAX(root)
    var element = root
    // The walk has to agree with snapshotNodes exactly, including the level it
    // numbers from: a window-scoped snapshot starts at the window element on
    // level -1, so the child after it is the one level 0 sorts.
    var level = 0
    var parts = path.split(separator: ".")
    if let windowId {
        guard !parts.isEmpty,
              let window = windowRoot(pid: pid, root: root, windowId: windowId),
              Int(parts[0]) == window.index else { return nil }
        element = window.element
        level = -1
        parts = Array(parts.dropFirst())
    }
    for part in parts {
        guard let index = Int(part), index >= 0 else { return nil }
        let kids = orderedChildren(element, level: level)
        guard index < kids.count else { return nil }
        element = kids[index]
        level += 1
    }
    return element
}

func resolveNode(pid: pid_t, ref: String, role: String?, title: String?,
                 windowId: CGWindowID? = nil) -> SnapNode {
    // Fast path: a k-ref *is* a child-index path, so walk that one path instead
    // of snapshotting the whole tree. This used to cost 100–300 ms on a 400-node
    // app, on every single ref-based click, type and set_value.
    lastResolve = "walk"
    if ref.hasPrefix("k") {
        let path = String(ref.dropFirst())
        if let target = element(pid: pid, path: path, windowId: windowId) {
            let targetRole = stringAttribute(target, kAXRoleAttribute)
            let rawTitle = stringAttribute(target, kAXTitleAttribute)
            let label = rawTitle.isEmpty
                ? stringAttribute(target, kAXDescriptionAttribute) : rawTitle
            // Same guard as the slow path: the tree may have shifted under the
            // ref, in which case fall through and re-derive it from a real walk.
            if ((role ?? "").isEmpty || role == targetRole),
               ((title ?? "").isEmpty || title == label) {
                lastResolve = "path"
                let subrole = stringAttribute(target, kAXSubroleAttribute)
                let node = SnapNode(element: target, index: 0, path: path, role: targetRole,
                                    title: label, value: "", frame: frame(of: target),
                                    enabled: (attribute(target, kAXEnabledAttribute) as? Bool) ?? false,
                                    focused: (attribute(target, kAXFocusedAttribute) as? Bool) ?? false, subrole: subrole,
                                    actions: actionNames(target),
                                    secure: targetRole == "AXSecureTextField"
                                        || subrole == "AXSecureTextField")
                if node.secure {
                    fail("secure_field", "\(ref) is a secure (password) field; refusing to act on it",
                         ["ref": ref, "role": node.role])
                }
                return node
            } else {
                lastResolve = ((role ?? "").isEmpty || role == targetRole)
                    ? "walk-title" : "walk-role"
            }
        } else {
            lastResolve = "walk-nil"
        }
    }
    let (_, nodes, _) = snapshotNodes(pid: pid, includeZeroSize: true, windowId: windowId)
    var wantedIndex: Int?
    if !ref.hasPrefix("k") {
        let digits = ref.hasPrefix("e") ? String(ref.dropFirst()) : ref
        guard let wanted = Int(digits) else { fail("bad_ref", "refs look like k0.3.2 or e12") }
        wantedIndex = wanted
    }
    func lookUp(_ node: SnapNode) -> Bool {
        if let wantedIndex { return node.index == wantedIndex }
        return node.path == String(ref.dropFirst())
    }
    guard let node = nodes.first(where: lookUp) else {
        fail("stale_ref", "\(ref) is not in the current tree; take a new snapshot")
    }
    if let role, !role.isEmpty, role != node.role {
        fail("stale_ref", "\(ref) was \(role), now \(node.role); take a new snapshot")
    }
    if let title, !title.isEmpty, title != node.title {
        fail("stale_ref", "\(ref) was \"\(title)\", now \"\(node.title)\"; take a new snapshot")
    }
    if node.secure {
        fail("secure_field", "\(ref) is a secure (password) field; refusing to act on it",
             ["ref": ref, "role": node.role])
    }
    return node
}

func element(for node: SnapNode, pid: pid_t) -> AXUIElement? {
    element(pid: pid, path: node.path)
}

func nodeLine(_ node: SnapNode) -> [String: Any] {
    var object: [String: Any] = ["ref": node.ref, "role": node.role,
                                 "enabled": node.enabled, "index": node.index]
    if node.focused { object["focused"] = true }
    if !node.subrole.isEmpty { object["subrole"] = node.subrole }
    if !node.title.isEmpty { object["title"] = node.title }
    if !node.value.isEmpty { object["value"] = node.value }
    if let frame = node.frame {
        object["x"] = frame.origin.x
        object["y"] = frame.origin.y
        object["w"] = frame.size.width
        object["h"] = frame.size.height
        object["cx"] = frame.midX
        object["cy"] = frame.midY
    }
    if !node.actions.isEmpty { object["actions"] = node.actions }
    return object
}

// MARK: - apps

func runningApps() -> [[String: Any]] {
    let front = frontmostPID()
    return NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular }
        .compactMap { app in
            guard let name = app.localizedName else { return nil }
            return ["pid": Int(app.processIdentifier), "name": name,
                    "bundleId": app.bundleIdentifier ?? "",
                    "active": app.processIdentifier == front]
        }
}

func appURL(for spec: String) -> URL? {
    if spec.contains("/") { return URL(fileURLWithPath: spec) }
    if spec.contains("."),
       let byBundle = NSWorkspace.shared.urlForApplication(withBundleIdentifier: spec) {
        return byBundle
    }
    if let running = NSWorkspace.shared.runningApplications.first(where: {
        ($0.localizedName ?? "").caseInsensitiveCompare(spec) == .orderedSame
    }), let url = running.bundleURL {
        return url
    }
    for directory in ["/Applications", "/System/Applications",
                      NSHomeDirectory() + "/Applications"] {
        let url = URL(fileURLWithPath: directory).appendingPathComponent(spec + ".app")
        if FileManager.default.fileExists(atPath: url.path) { return url }
    }
    return nil
}

func launchApp(_ spec: String) {
    guard let url = appURL(for: spec) else {
        fail("app_not_found", "no application matches \(spec)",
             ["hint": "pass a bundle id, an app name, or a full .app path"])
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    // This shell (and therefore the launchd service) can carry ELECTRON_RUN_AS_NODE,
    // which makes any Electron app launched from it exit immediately.
    var environment = ProcessInfo.processInfo.environment
    environment.removeValue(forKey: "ELECTRON_RUN_AS_NODE")
    configuration.environment = environment
    let semaphore = DispatchSemaphore(value: 0)
    var pid: pid_t = 0
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, _ in
        pid = app?.processIdentifier ?? 0
        semaphore.signal()
    }
    semaphore.wait()
    emit(["ok": pid != 0, "action": "launch", "pid": Int(pid),
          "path": url.path, "frontmost": frontmost().app])
}

// MARK: - paste

func pasteText(_ text: String, format: String = "text") {
    let board = NSPasteboard.general
    let previousString = board.string(forType: .string)
    let previousHTML = board.data(forType: .html)
    board.clearContents()
    board.setString(text, forType: .string)
    if format == "html" {
        board.setData(Data(text.utf8), forType: .html)
    }
    usleep(40_000)
    press(name: "v", modifiers: .maskCommand)
    usleep(120_000)
    // Put the user's clipboard back; pasting must not eat it.
    board.clearContents()
    if let previousString { board.setString(previousString, forType: .string) }
    if let previousHTML { board.setData(previousHTML, forType: .html) }
}

/// Electron composer fallback: React-controlled textareas often reject AX value
/// writes and ignore pid key events while the window is not key, but their own
/// context menu still pastes. AXShowMenu + the menu item's AXPress run entirely
/// in the background. The clipboard is restored afterwards.
func pasteViaContextMenu(pid: pid_t, text: String, element: AXUIElement?) -> Bool {
    guard let element else { return false }
    let board = NSPasteboard.general
    let previousString = board.string(forType: .string)
    let previousHTML = board.data(forType: .html)
    board.clearContents()
    board.setString(text, forType: .string)
    defer {
        board.clearContents()
        if let previousString { board.setString(previousString, forType: .string) }
        if let previousHTML { board.setData(previousHTML, forType: .html) }
    }
    _ = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    usleep(30_000)
    guard AXUIElementPerformAction(element, kAXShowMenuAction as CFString) == .success else {
        return false
    }
    usleep(150_000)
    let (_, nodes, _) = snapshotNodes(pid: pid, includeZeroSize: true)
    guard let item = nodes.first(where: {
        $0.role == "AXMenuItem" && $0.enabled && ($0.title == "粘贴" || $0.title == "Paste")
    }) else {
        _ = AXUIElementPerformAction(element, kAXCancelAction as CFString)
        return false
    }
    return AXUIElementPerformAction(item.element, kAXPressAction as CFString) == .success
}

final class ClickCounter: NSObject {
    var onClick: (() -> Void)?
    init(onClick: (() -> Void)? = nil) { self.onClick = onClick }
    @objc func fire() { onClick?() }
}


// MARK: - local service

struct ServiceConfig: Codable {
    var port: Int
    var token: String
    var screenshotMaxDimension: Int?
    var pauseOnUserActivity: Bool?
    var autoHalo: Bool?
}

let serviceConfigPath = NSString(string: "~/.cu/config.json").expandingTildeInPath

func loadServiceConfig(portOverride: Int?, tokenOverride: String?) -> ServiceConfig {
    var config = ServiceConfig(port: 47777, token: "", screenshotMaxDimension: 1600,
                               pauseOnUserActivity: true, autoHalo: true)
    if let data = FileManager.default.contents(atPath: serviceConfigPath),
       let decoded = try? JSONDecoder().decode(ServiceConfig.self, from: data) {
        config = decoded
    }
    if config.token.isEmpty {
        config.token = UUID().uuidString.replacingOccurrences(of: "-", with: "")
    }
    let explicit = portOverride != nil || tokenOverride != nil
    if let portOverride { config.port = portOverride }
    if let tokenOverride { config.token = tokenOverride }
    try? FileManager.default.createDirectory(
        atPath: NSString(string: "~/.cu").expandingTildeInPath,
        withIntermediateDirectories: true)
    if !explicit, let encoded = try? JSONEncoder().encode(config) {
        try? encoded.write(to: URL(fileURLWithPath: serviceConfigPath))
    }
    return config
}

func jsonData(_ object: Any) -> Data {
    (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
}

func readHTTP(_ fd: Int32) -> (method: String, path: String, headers: [String: String], body: Data)? {
    var buffer = Data()
    var chunk = [UInt8](repeating: 0, count: 16384)
    var headerEnd = -1
    let deadline = Date().addingTimeInterval(5)
    while Date() < deadline {
        let n = read(fd, &chunk, chunk.count)
        if n <= 0 { break }
        buffer.append(contentsOf: chunk[0..<n])
        if headerEnd < 0, let range = buffer.range(of: Data("\r\n\r\n".utf8)) {
            headerEnd = range.lowerBound
        }
        if headerEnd >= 0 {
            let headerData = buffer.prefix(headerEnd)
            let headerText = String(decoding: headerData, as: UTF8.self)
            let lengthLine = headerText.split(separator: "\r\n")
                .first { $0.lowercased().hasPrefix("content-length:") }
            let length = lengthLine.flatMap { Int($0.split(separator: ":")[1].trimmingCharacters(in: .whitespaces)) } ?? 0
            if buffer.count >= headerEnd + 4 + length { break }
        }
    }
    guard let range = buffer.range(of: Data("\r\n\r\n".utf8)) else { return nil }
    let headerText = String(decoding: buffer.prefix(range.lowerBound), as: UTF8.self)
    let lines = headerText.components(separatedBy: "\r\n")
    guard let requestLine = lines.first else { return nil }
    let parts = requestLine.split(separator: " ")
    guard parts.count >= 2 else { return nil }
    var headers: [String: String] = [:]
    for line in lines.dropFirst() {
        guard let colon = line.firstIndex(of: ":") else { continue }
        headers[line[..<colon].lowercased()] = line[line.index(after: colon)...]
            .trimmingCharacters(in: .whitespaces)
    }
    let bodyStart = range.upperBound
    let body = buffer.count > bodyStart ? buffer.subdata(in: bodyStart..<buffer.count) : Data()
    return (String(parts[0]), String(parts[1]), headers, body)
}

func writeHTTP(_ fd: Int32, status: Int, body: Data) {
    let reason: String
    switch status {
    case 200: reason = "OK"
    case 401: reason = "Unauthorized"
    case 404: reason = "Not Found"
    case 405: reason = "Method Not Allowed"
    default: reason = "Error"
    }
    let head = "HTTP/1.1 \(status) \(reason)\r\nContent-Type: application/json\r\n"
        + "Content-Length: \(body.count)\r\nConnection: close\r\n\r\n"
    var out = Data(head.utf8)
    out.append(body)
    out.withUnsafeBytes { raw in
        var sent = 0
        while sent < raw.count {
            let n = write(fd, raw.baseAddress!.advanced(by: sent), raw.count - sent)
            if n <= 0 { break }
            sent += n
        }
    }
}

func toolsJSON() -> Data {
    let candidates = [
        URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
            .appendingPathComponent("../mcp/tools.json").path,
        URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
            .appendingPathComponent("mcp/tools.json").path,
        URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
            .appendingPathComponent("tools.json").path,
        URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
            .appendingPathComponent("../Resources/tools.json").standardized.path,
    ]
    for path in candidates {
        if let data = FileManager.default.contents(atPath: path) { return data }
    }
    return Data("[]".utf8)
}

// These options are implemented by the Python MCP proxy, which uses /v1/exec.
// Reject them before any HTTP batch action rather than silently weakening checks.
func requiresMCPProxy(_ tool: String, _ arguments: [String: Any]) -> Bool {
    if tool == "expect" { return arguments["count"] != nil || arguments["role"] != nil }
    if tool == "batch" {
        if arguments["timeoutMs"] != nil { return true }
        return (arguments["steps"] as? [[String: Any]] ?? []).contains { step in
            requiresMCPProxy(step["tool"] as? String ?? "", step["arguments"] as? [String: Any] ?? [:])
        }
    }
    return false
}

func argumentValue(_ arguments: [String: Any], _ key: String) -> Any? { arguments[key] }

func stringList(_ value: Any?) -> [String]? { value as? [String] }

/// Maps a tool call to the engine's argv. Kept deliberately small: the MCP proxy
/// has the richer logic (diffing, ref scoping) and uses /v1/exec instead.
func toolArgv(_ tool: String, _ a: [String: Any], config: ServiceConfig? = nil) -> [String]? {
    func str(_ key: String) -> String? {
        if let s = a[key] as? String { return s }
        if let n = a[key] as? NSNumber { return n.stringValue }
        return nil
    }
    func num(_ key: String) -> String? { str(key) }
    switch tool {
    case "list_windows": return ["windows"]
    case "list_apps": return ["apps"]
    case "selfcheck": return ["selfcheck"]
    case "guards": return ["guards"]
    case "cursor_position": return ["cursor"]
    case "release_mouse": return ["release"]
    case "resume": return ["resume"]
    case "launch_app": return str("app").map { ["launch", "--app", $0] }
    case "activate_window":
        return str("windowId").map { ["activate", "--window", $0] }
    case "bring_on_stage":
        return str("windowId").map { ["stage", "--window", $0] }
    case "bring_to_current_space":
        return str("windowId").map { ["space", "--window", $0] }
    case "screenshot":
        var args = ["shot"]
        args += a["screen"] as? Bool == true ? ["--screen"] : ["--window", str("windowId") ?? "0"]
        args += ["--max-dim", str("maxDimension")
                 ?? String(config?.screenshotMaxDimension ?? 1600)]
        if let display = str("display") { args += ["--display", display] }
        if let region = a["region"] {
            if let rect = region as? [String: Any],
               let x = (rect["x"] as? NSNumber)?.doubleValue,
               let y = (rect["y"] as? NSNumber)?.doubleValue,
               let w = (rect["width"] as? NSNumber)?.doubleValue,
               let h = (rect["height"] as? NSNumber)?.doubleValue {
                args += ["--region", "\(x),\(y),\(w),\(h)"]
            } else if let text = region as? String {
                args += ["--region", text]
            }
        }
        if let format = str("format") { args += ["--format", format] }
        if let quality = str("quality") { args += ["--quality", quality] }
        return args
    case "click", "double_click":
        var args = ["click"]
        if let ref = str("ref") { args += ["--ref", ref] }
        if let pid = str("pid") { args += ["--pid", pid] }
        if let window = str("windowId") { args += ["--window", window] }
        if let x = str("x"), let y = str("y") { args += ["--x", x, "--y", y] }
        if let button = str("button") { args += ["--button", button] }
        let count = tool == "double_click" ? 2 : (a["count"] as? Int ?? 1)
        args += ["--count", String(count)]
        if a["foreground"] as? Bool == true { args += ["--force"]; args += ["--phantom"] }
        else { args += ["--background"] }
        if a["dryRun"] as? Bool == true { args.append("--dry-run") }
        return args
    case "type_text":
        var args = ["type", "--text", str("text") ?? ""]
        if let pid = str("pid") { args += ["--pid", pid] }
        if let ref = str("ref") { args += ["--ref", ref] }
        if a["foreground"] as? Bool == true { args += ["--pid", str("pid") ?? ""] }
        else if str("pid") != nil { args += ["--background"] }
        if a["tryOffstage"] as? Bool == true { args += ["--try-offstage"] }
        return args
    case "press_key":
        var args = ["key", "--name", str("name") ?? ""]
        if let mods = str("mods") { args += ["--mods", mods] }
        if let pid = str("pid") { args += ["--pid", pid, "--background"] }
        if a["tryOffstage"] as? Bool == true { args += ["--try-offstage"] }
        return args
    case "scroll":
        var args = ["scroll", "--dy", str("dy") ?? "0"]
        if let dx = str("dx") { args += ["--dx", dx] }
        if let x = str("x"), let y = str("y") { args += ["--x", x, "--y", y] }
        if let pid = str("pid") { args += ["--pid", pid, "--background"] }
        return args
    case "drag":
        guard let from = a["from"] as? [String: Any], let to = a["to"] as? [String: Any],
              let fx = from["x"], let fy = from["y"], let tx = to["x"], let ty = to["y"] else { return nil }
        var args = ["drag", "--from", "\(fx),\(fy)", "--to", "\(tx),\(ty)"]
        if let window = str("windowId") { args += ["--window", window] }
        return args
    case "menu":
        var args = ["menu", "--pid", str("pid") ?? ""]
        if let path = str("path") { args += ["--path", path] }
        if a["confirm"] as? Bool == true { args += ["--confirm"] }
        return args
    case "zoom_window":
        return str("windowId").map { ["zoom", "--window", $0] }
    case "move_window":
        guard let window = str("windowId") else { return nil }
        var args = ["movewindow", "--window", window]
        if let x = str("x") { args += ["--x", x] }
        if let y = str("y") { args += ["--y", y] }
        if let width = str("width") { args += ["--w", width] }
        if let height = str("height") { args += ["--h", height] }
        return args
    case "paste_text":
        var args = ["paste", "--text", str("text") ?? ""]
        if let format = str("format") { args += ["--format", format] }
        if let pid = str("pid") { args += ["--pid", pid] }
        if let ref = str("ref") { args += ["--ref", ref] }
        if a["tryOffstage"] as? Bool == true { args += ["--try-offstage"] }
        return args
    case "set_value":
        var args = ["setvalue", "--pid", str("pid") ?? "", "--ref", str("ref") ?? "", "--text", str("text") ?? ""]
        if let role = str("role") { args += ["--role", role] }
        return args
    case "perform_action":
        return ["action", "--pid", str("pid") ?? "", "--ref", str("ref") ?? "", "--name", str("name") ?? ""]
    case "expect":
        var args = ["expect", "--pid", str("pid") ?? ""]
        if let ref = str("ref") { args += ["--ref", ref] }
        if let query = str("query") { args += ["--find", query] }
        if let window = str("windowId") { args += ["--window", window] }
        if let enabled = a["enabled"] as? Bool { args += ["--enabled", enabled ? "true" : "false"] }
        if let value = str("value") { args += ["--value", value] }
        if let contains = str("contains") { args += ["--contains", contains] }
        if let ms = str("timeoutMs") { args += ["--timeout", ms] }
        return args
    case "select_text":
        var args = ["selecttext", "--pid", str("pid") ?? "", "--ref", str("ref") ?? "", "--text", str("text") ?? ""]
        if let prefix = str("prefix") { args += ["--prefix", prefix] }
        if let suffix = str("suffix") { args += ["--suffix", suffix] }
        if let selection = str("selection") { args += ["--selection", selection] }
        return args
    case "snapshot":
        var args = ["snapshot", "--pid", str("pid") ?? ""]
        if let window = str("windowId") { args += ["--window", window] }
        if let settle = str("settle") { args += ["--settle", settle] }
        if a["all"] as? Bool == true { args += ["--all"] }
        return args
    case "ax_find":
        guard let pid = str("pid") else { return nil }
        var args = ["ax", "--pid", pid, "--find", str("query") ?? ""]
        if let depth = str("depth") { args += ["--depth", depth] }
        if a["all"] as? Bool == true { args += ["--all"] }
        return args
    case "highlight_window":
        var args = ["halo", "--window", str("windowId") ?? ""]
        if let seconds = str("seconds") { args += ["--seconds", seconds] }
        if let label = str("label") { args += ["--label", label] }
        return args
    case "cover_window":
        var args = ["cover", "--window", str("windowId") ?? ""]
        if let seconds = str("seconds") { args += ["--seconds", seconds] }
        if let label = str("label") { args += ["--label", label] }
        return args
    default:
        return nil
    }
}

let serviceLogPath = NSString(string: "~/.cu/service.log").expandingTildeInPath

func serviceLog(_ line: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    let text = "[\(stamp)] \(line)\n"
    if let handle = FileHandle(forWritingAtPath: serviceLogPath) {
        handle.seekToEndOfFile()
        handle.write(Data(text.utf8))
        handle.closeFile()
    } else {
        try? text.write(toFile: serviceLogPath, atomically: true, encoding: .utf8)
    }
}

func frontmostPayload() -> [String: Any] {
    let front = frontmost()
    return ["ok": true, "pid": Int(front.pid), "app": front.app]
}

func cursorPayload() -> [String: Any] {
    let point = cursorPosition()
    return ["ok": true, "x": point.x, "y": point.y]
}

/// Window enumeration without argv globals, shared by the CLI and the
/// service's in-process dispatch. Bounded work only: CGWindowList, NSWorkspace,
/// and an AX scan limited by the 1s messaging timeout in axWindowInfos.
func windowsPayload(explicitPid: Int? = nil) -> [String: Any] {
    let raw = onScreenWindows()
    let offStage = offStageIds(raw)
    let front = frontmost()
    var windows = raw.map { window -> [String: Any] in
        var object = describe(window)
        if offStage.contains(window.id) { object["offStage"] = true }
        return object
    }
    // CGWindowList cannot see every sheet or progress dialog (剪映's import
    // progress is one). Add AX-only windows for the frontmost app, or for an
    // explicit --pid, without ever inventing a window id for them.
    var scanPids: [pid_t] = []
    if front.pid != 0 { scanPids.append(front.pid) }
    if let explicit = explicitPid, explicit > 0, pid_t(explicit) != front.pid {
        scanPids.append(pid_t(explicit))
    }
    windows.append(contentsOf: axOnlyWindows(scanPids: scanPids, known: raw))
    return ["ok": true, "count": windows.count, "frontmost": ["pid": Int(front.pid), "app": front.app],
            "windows": windows]
}

/// Which display holds this global top-left point? Captures and window bounds
/// are reported in that space, so a caller can tell which screen an image came
/// from without guessing from sizes.
func displayId(containing point: CGPoint) -> Int? {
    let mainTop = NSScreen.screens.first?.frame.maxY ?? 0
    for screen in NSScreen.screens {
        let frame = screen.frame
        let top = mainTop - frame.maxY
        if point.x >= frame.minX, point.x < frame.maxX,
           point.y >= top, point.y < top + frame.height {
            let number = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")]
                as? NSNumber)?.uint32Value ?? 0
            return Int(number)
        }
    }
    return nil
}

/// Real display geometry: frames in global points (top-left origin, matching
/// window bounds and screenshots), the usable area, and the backing scale.
/// Layout code used to infer the display from the widest window, which breaks on
/// a second monitor, a docked DSH panel, or a window that is not full-screen.
func screensPayload() -> [String: Any] {
    let mainHeight = NSScreen.screens.first?.frame.maxY ?? 0
    let screens = NSScreen.screens.enumerated().map { index, screen -> [String: Any] in
        let frame = screen.frame
        let visible = screen.visibleFrame
        // Cocoa is bottom-left; every other CU surface (window bounds, capture
        // origin, event points) is top-left, so convert once here.
        let top = mainHeight - frame.maxY
        let topVisible = mainHeight - visible.maxY
        let number = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")]
            as? NSNumber)?.uint32Value ?? 0
        return [
            "index": index,
            "displayId": Int(number),
            "name": screen.localizedName,
            "main": index == 0,
            "scale": Double(screen.backingScaleFactor),
            "frame": ["x": Double(frame.origin.x), "y": Double(top),
                      "width": Double(frame.width), "height": Double(frame.height)],
            "visible": ["x": Double(visible.origin.x), "y": Double(topVisible),
                        "width": Double(visible.width), "height": Double(visible.height)],
        ]
    }
    return ["ok": true, "count": screens.count, "screens": screens]
}

// --- service control state (F2): input gate, in-flight actions, cleanup -----
// One process, several queues -> guard shared state with a lock. The pause gate
// closes BEFORE cleanup is attempted; a status/pause answer never claims cleanup
// finished while an action is still in flight.
let serviceStateLock = NSLock()
var serviceInputGateClosed = false
var serviceActionsInFlight = 0
var serviceCleanupState = "complete"   // complete | pending | unknown
var serviceRunningChildren: Set<pid_t> = []

func serviceStateSnapshot() -> (gate: Bool, inFlight: Int, cleanup: String) {
    serviceStateLock.lock(); defer { serviceStateLock.unlock() }
    return (serviceInputGateClosed, serviceActionsInFlight, serviceCleanupState)
}
func serviceBeginAction() {
    serviceStateLock.lock()
    serviceActionsInFlight += 1
    serviceStateLock.unlock()
}
func serviceEndAction() {
    serviceStateLock.lock()
    serviceActionsInFlight = max(0, serviceActionsInFlight - 1)
    // After a pause-cancel we can confirm the direct child exited, but not that
    // every descendant / held input was released — never claim "complete" then.
    if serviceActionsInFlight == 0 && serviceCleanupState == "pending" {
        serviceCleanupState = "unknown"
    }
    serviceStateLock.unlock()
}
func serviceRegisterChild(_ pid: pid_t) {
    serviceStateLock.lock(); serviceRunningChildren.insert(pid); serviceStateLock.unlock()
}
func serviceUnregisterChild(_ pid: pid_t) {
    serviceStateLock.lock(); serviceRunningChildren.remove(pid); serviceStateLock.unlock()
}

func runEngine(_ argv: [String], config: ServiceConfig? = nil, noUserPause: Bool = false) -> [String: Any] {
    var direct: [String: Any]?
    if argv == ["frontmost"] { direct = frontmostPayload() }
    if argv == ["cursor"] { direct = cursorPayload() }
    if argv == ["windows"] { direct = windowsPayload() }
    if argv == ["screens"] { direct = screensPayload() }
    if var direct {
        direct["exitCode"] = 0
        serviceLog("\(argv[0]) -> ok=true exit=0")
        return direct
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    process.arguments = argv
    var environment = ProcessInfo.processInfo.environment
    if noUserPause || config?.pauseOnUserActivity == false { environment["CU_NO_USER_PAUSE"] = "1" }
    // Children of the daemon never receive SCK completion callbacks.
    environment["CU_SHOT_CLI"] = "1"
    process.environment = environment
    let out = Pipe()
    process.standardOutput = out
    process.standardError = Pipe()
    let waiter = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in waiter.signal() }
    do { try process.run() } catch {
        return ["ok": false, "error": "spawn_failed", "message": error.localizedDescription]
    }
    serviceRegisterChild(process.processIdentifier)
    defer { serviceUnregisterChild(process.processIdentifier) }
    // Drain the pipe while the child runs. Reading only after exit deadlocks as
    // soon as the payload passes the 64 KB pipe buffer — a 400-node snapshot is
    // bigger than that — and the call then burned the full 20 s timeout.
    var data = Data()
    let drained = DispatchSemaphore(value: 0)
    DispatchQueue(label: "cu.engine.reader").async {
        data = out.fileHandleForReading.readDataToEndOfFile()
        drained.signal()
    }
    if waiter.wait(timeout: .now() + 20) != .success {
        process.terminate()
        _ = waiter.wait(timeout: .now() + 0.5)
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        serviceLog("\(argv.first ?? "unknown") -> timeout")
        return ["ok": false, "error": "timeout",
                "message": "the action did not finish in 20 s"]
    }
    _ = drained.wait(timeout: .now() + 2)
    let text = String(decoding: data, as: UTF8.self)
    guard let last = text.split(separator: "\n").last,
          let parsed = try? JSONSerialization.jsonObject(with: Data(last.utf8)) as? [String: Any] else {
        return ["ok": false, "error": "bad_output", "message": String(text.suffix(400))]
    }
    var payload = parsed
    payload["exitCode"] = Int(process.terminationStatus)
    serviceLog("\(argv.first ?? "unknown") -> ok=\(payload["ok"] ?? "?") exit=\(process.terminationStatus)")
    return payload
}

let engineBuildID: String = {
    let fd = open(CommandLine.arguments[0], O_RDONLY)
    guard fd >= 0 else { return "unavailable" }
    defer { close(fd) }
    guard let data = try? FileHandle(fileDescriptor: fd, closeOnDealloc: false).readToEnd() else { return "unavailable" }
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}()

func serviceStatus(_ config: ServiceConfig) -> [String: Any] {
    let front = frontmost()
    let state = serviceStateSnapshot()
    var payload: [String: Any] = [
        "ok": true,
        "service": "cu",
        "pid": ProcessInfo.processInfo.processIdentifier,
        "version": "0.1.0",
        "buildId": engineBuildID,
        "controlProtocol": 0,
        "capabilities": ["scopedSnapshots", "batchFailurePropagation"],
        "port": config.port,
        "accessibility": AXIsProcessTrusted(),
        "screenRecording": CGPreflightScreenCaptureAccess(),
        "paused": pauseActive(),
        // Gate + cleanup progress are separate from `paused`: paused:true with a
        // still-pending cleanup is NOT "everything stopped".
        "inputGateClosed": state.gate,
        "cleanupState": state.cleanup,
        "secureInput": secureInputPID() != nil,
        "occluder": fullScreenOverlayExists(),
        "frontmost": ["pid": Int(front.pid), "app": front.app],
        "windows": onScreenWindows().count,
        "config": serviceConfigPath,
    ]
    let next: [String] = [
        AXIsProcessTrusted() ? nil : "grant Accessibility to cu",
        CGPreflightScreenCaptureAccess() ? nil : "grant Screen Recording to cu",
    ].compactMap { $0 }
    payload["nextSteps"] = next
    return payload
}

func serve(_ config: ServiceConfig) -> Never {
    _ = engineBuildID
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { fail("socket_failed", "socket() failed") }
    var yes: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = UInt16(config.port).bigEndian
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let bound = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    guard bound == 0 else { fail("bind_failed", "port \(config.port) is busy") }
    guard listen(fd, 16) == 0 else { fail("listen_failed", "listen() failed") }
    // Warm the OCR engine once at start-up (it can take ~30 s the first time on a
    // fresh system); doing it here keeps the first user-visible OCR fast.
    DispatchQueue.global(qos: .utility).async {
        let context = CGContext(data: nil, width: 8, height: 8, bitsPerComponent: 8,
                                bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue)
        guard let image = context?.makeImage() else { return }
        let rep = NSBitmapImageRep(cgImage: image)
        if let png = rep.representation(using: .png, properties: [:]) {
            _ = ocrPayload(png: png, find: nil, exact: false, level: "accurate")
            serviceLog("ocr warm-up done")
        }
    }
    emit(["ok": true, "service": "listening", "port": config.port,
          "base": "http://127.0.0.1:\(config.port)", "config": serviceConfigPath])
    // F2: reading and classifying a request must NOT happen on the action
    // queue. A 2.4 s expect used to block the read of the next status query,
    // which then queued behind the whole action.
    let actionQueue = DispatchQueue(label: "cu.service.action")                            // serial: input work only
    let controlQueue = DispatchQueue(label: "cu.service.control", attributes: .concurrent)  // status/pause/resume
    let readQueue = DispatchQueue(label: "cu.service.read", attributes: .concurrent)
    // Bound how many requests may be mid-read; the slot is released the moment a
    // request is classified, before it joins the action queue.
    let readGate = DispatchSemaphore(value: 8)
    while true {
        var client = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let clientFD = withUnsafeMutablePointer(to: &client) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                accept(fd, $0, &length)
            }
        }
        guard clientFD >= 0 else { continue }
        let peerPort = UInt16(bigEndian: client.sin_port)
        // A client that connects and sends nothing must not stall the queue.
        var timeout = timeval(tv_sec: 2, tv_usec: 0)
        setsockopt(clientFD, SOL_SOCKET, SO_RCVTIMEO, &timeout,
                   socklen_t(MemoryLayout<timeval>.size))
        readQueue.async {
            readGate.wait()
            guard let request = readHTTP(clientFD) else {
                writeHTTP(clientFD, status: 400, body: jsonData(["ok": false, "error": "bad_request"]))
                close(clientFD)
                readGate.signal()
                return
            }
            // Classification only needs method + path; the body is already read.
            readGate.signal()
            let handle: () -> Void = {
            defer { close(clientFD) }
            let authorized = request.headers["authorization"] == "Bearer \(config.token)"
            switch (request.method, request.path) {
            case ("GET", "/v1/status"):
                writeHTTP(clientFD, status: 200, body: jsonData(serviceStatus(config)))
            case ("GET", "/v1/tools"):
                writeHTTP(clientFD, status: 200, body: toolsJSON())
            case ("GET", "/v1/agents"):
                writeHTTP(clientFD, status: 200, body: jsonData(["ok": true, "agents": agentsCatalog()]))
            case ("POST", "/v1/agents/connect"):
                guard authorized else {
                    writeHTTP(clientFD, status: 401, body: jsonData(["ok": false, "error": "unauthorized"]))
                    return
                }
                let ids = (try? JSONSerialization.jsonObject(with: request.body) as? [String: Any])
                    .flatMap { $0["ids"] as? [String] }
                writeHTTP(clientFD, status: 200, body: jsonData(["ok": true, "results": agentsConnect(ids: ids)]))
            case ("POST", "/v1/exec"):
                guard authorized else {
                    writeHTTP(clientFD, status: 401, body: jsonData(["ok": false, "error": "unauthorized"]))
                    return
                }
                guard let object = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
                      let argv = object["argv"] as? [String] else {
                    writeHTTP(clientFD, status: 400, body: jsonData(["ok": false, "error": "bad_argv"]))
                    return
                }
                let execStarted = DispatchTime.now().uptimeNanoseconds
                let noUserPause = request.headers["x-cu-no-user-pause"] == "1"
                serviceBeginAction()
                let execResult = runEngine(argv, config: config, noUserPause: noUserPause)
                serviceEndAction()
                recordHTTPCall(peerPort: peerPort,
                               tool: argv.first ?? "exec",
                               ms: Int((DispatchTime.now().uptimeNanoseconds - execStarted) / 1_000_000),
                               ok: execResult["ok"] as? Bool ?? false,
                               declared: declaredCaller(request.headers))
                writeHTTP(clientFD, status: 200, body: jsonData(execResult))
            case ("POST", "/v1/call"):
                guard authorized else {
                    writeHTTP(clientFD, status: 401, body: jsonData(["ok": false, "error": "unauthorized"]))
                    return
                }
                guard let object = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
                      let tool = object["tool"] as? String,
                      let arguments = object["arguments"] as? [String: Any] ?? [:] as? [String: Any] else {
                    writeHTTP(clientFD, status: 400, body: jsonData(["ok": false, "error": "bad_call"]))
                    return
                }
                if requiresMCPProxy(tool, arguments) {
                    writeHTTP(clientFD, status: 400, body: jsonData([
                        "ok": false, "error": "requires_mcp_proxy",
                        "message": "count/role expectations and batch timeoutMs require the Python MCP server"]))
                    return
                }
                if tool == "batch" {
                    let steps = arguments["steps"] as? [[String: Any]] ?? []
                    var results: [[String: Any]] = []
                    let stopOnError = arguments["stopOnError"] as? Bool ?? true
                    var failed = false
                    serviceBeginAction()
                    for step in steps {
                        let result: [String: Any]
                        if let name = step["tool"] as? String,
                           let inner = step["arguments"] as? [String: Any],
                           let argv = toolArgv(name, inner, config: config) {
                            result = runEngine(argv, config: config)
                        } else {
                            result = ["ok": false, "error": "unknown_tool"]
                        }
                        results.append(result)
                        if result["ok"] as? Bool != true {
                            failed = true
                            if stopOnError { break }
                        }
                    }
                    serviceEndAction()
                    writeHTTP(clientFD, status: 200, body: jsonData(["ok": !failed, "results": results,
                              "completed": results.count, "requested": steps.count]))
                    return
                }
                guard let argv = toolArgv(tool, arguments, config: config) else {
                    writeHTTP(clientFD, status: 404, body: jsonData(["ok": false, "error": "unknown_tool", "tool": tool]))
                    return
                }
                let callStarted = DispatchTime.now().uptimeNanoseconds
                serviceBeginAction()
                let callResult = runEngine(argv, config: config)
                serviceEndAction()
                recordHTTPCall(peerPort: peerPort, tool: tool,
                               ms: Int((DispatchTime.now().uptimeNanoseconds - callStarted) / 1_000_000),
                               ok: callResult["ok"] as? Bool ?? false,
                               declared: declaredCaller(request.headers))
                writeHTTP(clientFD, status: 200, body: jsonData(callResult))
            case ("POST", "/v1/ocr"):
                guard authorized else {
                    writeHTTP(clientFD, status: 401, body: jsonData(["ok": false, "error": "unauthorized"]))
                    return
                }
                guard let object = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
                      let encoded = object["image"] as? String,
                      let png = Data(base64Encoded: encoded) else {
                    writeHTTP(clientFD, status: 400, body: jsonData(["ok": false, "error": "bad_image"]))
                    return
                }
                serviceBeginAction()
                let payload = ocrPayload(png: png,
                                         find: object["find"] as? String,
                                         exact: object["exact"] as? Bool ?? false,
                                         level: object["level"] as? String)
                serviceEndAction()
                writeHTTP(clientFD, status: 200, body: jsonData(payload))
            case ("POST", "/v1/pause"):
                guard authorized else {
                    writeHTTP(clientFD, status: 401, body: jsonData(["ok": false, "error": "unauthorized"]))
                    return
                }
                // Close the gate first, then cancel in-flight work this service
                // owns. Report cleanup honestly: pending while an action is still
                // running, complete only when nothing is in flight.
                serviceStateLock.lock()
                serviceInputGateClosed = true
                let pauseInFlight = serviceActionsInFlight
                serviceCleanupState = pauseInFlight > 0 ? "pending" : "complete"
                let cancelChildren = Array(serviceRunningChildren)
                serviceStateLock.unlock()
                markPause()
                for childPid in cancelChildren { kill(childPid, SIGTERM) }
                writeHTTP(clientFD, status: 200, body: jsonData([
                    "ok": true, "paused": true,
                    "inputGateClosed": true,
                    "cleanupState": pauseInFlight > 0 ? "pending" : "complete",
                    "cancelled": cancelChildren.count,
                ]))
            case ("POST", "/v1/resume"):
                guard authorized else {
                    writeHTTP(clientFD, status: 401, body: jsonData(["ok": false, "error": "unauthorized"]))
                    return
                }
                clearPause()
                serviceStateLock.lock()
                serviceInputGateClosed = false
                serviceCleanupState = "complete"
                serviceStateLock.unlock()
                writeHTTP(clientFD, status: 200, body: jsonData([
                    "ok": true, "paused": false, "inputGateClosed": false, "cleanupState": "complete",
                ]))
            default:
                writeHTTP(clientFD, status: 404, body: jsonData(["ok": false, "error": "not_found"]))
            }
            }
            // Health and catalogue reads answer on their own concurrent queue: a
            // Only input work is serialised. Status / pause / resume and
            // catalogue reads run on the concurrent control queue so they never
            // wait behind a slow action (F2).
            let isWork = request.method == "POST" &&
                ["/v1/exec", "/v1/call", "/v1/ocr", "/v1/agents/connect"].contains(request.path)
            if isWork {
                actionQueue.async(execute: handle)
            } else {
                controlQueue.async(execute: handle)
            }
        }
    }
}



/// Fallback capture through /usr/sbin/screencapture. ScreenCaptureKit's async
/// completion never fires when this binary runs as a launchd agent, so the
/// service would otherwise hang on every screenshot.
func captureViaCLI(windowId: CGWindowID?, screen: Bool, displayIndex: Int,
                   format: String = "png") throws -> Data {
    let jpeg = format == "jpeg"
    let path = NSTemporaryDirectory() + "cu-shot-\(UUID().uuidString)." + (jpeg ? "jpg" : "png")
    defer { try? FileManager.default.removeItem(atPath: path) }
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    // screencapture encodes in its own process. Asking it for the format the
    // caller wants avoids a pointless PNG encode here plus a PNG decode there.
    var arguments = ["-x", "-t", jpeg ? "jpg" : "png"]
    if let windowId {
        arguments += ["-o", "-l", String(windowId)]
    } else {
        arguments += ["-D", String(displayIndex + 1)]
    }
    arguments.append(path)
    task.arguments = arguments
    try task.run()
    let deadline = Date().addingTimeInterval(6)
    while task.isRunning && Date() < deadline { usleep(50_000) }
    if task.isRunning {
        task.terminate()
        usleep(150_000)
        if task.isRunning { kill(task.processIdentifier, SIGKILL) }
        throw NSError(domain: "cu", code: 7,
                      userInfo: [NSLocalizedDescriptionKey: "screencapture did not finish in 6 s"])
    }
    guard task.terminationStatus == 0,
          let data = FileManager.default.contents(atPath: path) else {
        throw NSError(domain: "cu", code: 6,
                      userInfo: [NSLocalizedDescriptionKey:
                        "screencapture failed (status \(task.terminationStatus)); Screen Recording is required"])
    }
    return data
}

/// "x,y,w,h" or "x,yxw,h" in global points. A region is what turns a screenshot
/// into a zoom: the same window at a tenth of the pixels, but sharper per pixel.
func parseRegion(_ text: String) -> CGRect? {
    let parts = text
        .replacingOccurrences(of: "x", with: ",")
        .split(whereSeparator: { $0 == "," || $0 == " " })
        .compactMap { Double($0) }
    guard parts.count == 4 else { return nil }
    return CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
}

/// Crop / rescale / re-encode a finished capture. Applied after whichever
/// capture path produced the image, so all three keep one origin/scale contract.
func refine(_ capture: Capture, region: CGRect?, format: String, quality: Double,
            maxDimension: Int) throws -> Capture {
    // The common shot — no crop, no resize, no re-encode — used to pay a full
    // PNG decode plus a PNG encode (100–300 ms on a Retina window) to produce
    // bytes identical to the ones the capture already returned.
    let pixelWidth = capture.size.width * capture.scale
    if region == nil, format == capture.encoding,
       maxDimension <= 0 || pixelWidth <= Double(maxDimension) {
        return capture
    }
    guard let rep = NSBitmapImageRep(data: capture.png), var output = rep.cgImage else {
        throw NSError(domain: "cu", code: 6,
                      userInfo: [NSLocalizedDescriptionKey: "captured image could not be decoded"])
    }
    var area = CGRect(origin: capture.origin, size: capture.size)
    var scale = capture.scale
    if let region, region.width > 0, region.height > 0 {
        let pixels = CGRect(x: (region.minX - area.minX) * scale,
                            y: (region.minY - area.minY) * scale,
                            width: region.width * scale,
                            height: region.height * scale).integral
        let inside = pixels.intersection(CGRect(x: 0, y: 0,
                                                width: output.width, height: output.height))
        guard inside.width >= 1, inside.height >= 1 else {
            throw NSError(domain: "cu", code: 7, userInfo: [NSLocalizedDescriptionKey:
                "region \(Int(region.width))×\(Int(region.height)) at (\(Int(region.minX)),\(Int(region.minY))) is outside the capture \(Int(area.width))×\(Int(area.height)) at (\(Int(area.minX)),\(Int(area.minY)))"])
        }
        guard let cropped = output.cropping(to: inside) else {
            throw NSError(domain: "cu", code: 8,
                          userInfo: [NSLocalizedDescriptionKey: "crop failed"])
        }
        output = cropped
        area = CGRect(x: area.minX + inside.minX / scale,
                      y: area.minY + inside.minY / scale,
                      width: inside.width / scale, height: inside.height / scale)
    }
    if maxDimension > 0 && output.width > maxDimension {
        let ratio = Double(maxDimension) / Double(output.width)
        let width = maxDimension
        let height = max(1, Int((Double(output.height) * ratio).rounded()))
        if let context = CGContext(data: nil, width: width, height: height,
                                   bitsPerComponent: 8, bytesPerRow: 0,
                                   space: CGColorSpaceCreateDeviceRGB(),
                                   bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue) {
            context.interpolationQuality = .high
            context.draw(output, in: CGRect(x: 0, y: 0, width: width, height: height))
            if let scaled = context.makeImage() { output = scaled }
        }
    }
    if area.width > 0 { scale = Double(output.width) / area.width }
    let kind: NSBitmapImageRep.FileType = format == "jpeg" ? .jpeg : .png
    var options: [NSBitmapImageRep.PropertyKey: Any] = [:]
    if kind == .jpeg { options[.compressionFactor] = min(max(quality, 0.1), 1.0) }
    guard let data = NSBitmapImageRep(cgImage: output)
        .representation(using: kind, properties: options) else {
        throw NSError(domain: "cu", code: 3,
                      userInfo: [NSLocalizedDescriptionKey: "\(format) encoding failed"])
    }
    return Capture(png: data, origin: area.origin, size: area.size, scale: scale,
                   encoding: format)
}

func cliCapture(windowId: CGWindowID?, screen: Bool, displayIndex: Int,
                format: String = "png", bounds: CGRect? = nil) throws -> Capture {
    let data = try captureViaCLI(windowId: windowId, screen: screen,
                                 displayIndex: displayIndex, format: format)
    let area: CGRect
    if let bounds {
        // The caller already swept the window list; a second sweep here cost
        // another 100–200 ms on a busy desktop.
        area = bounds
    } else if let windowId, let window = onScreenWindows().first(where: { $0.id == windowId }) {
        area = window.bounds
    } else {
        let screens = NSScreen.screens
        let frame = screens.indices.contains(displayIndex) ? screens[displayIndex].frame : (screens.first?.frame ?? .zero)
        let screenHeight = screens.first?.frame.height ?? frame.height
        area = CGRect(x: frame.origin.x, y: screenHeight - frame.origin.y - frame.height,
                      width: frame.width, height: frame.height)
    }
    // No rescale here: refine() does that once, in the format the caller asked
    // for. Doing it twice meant decode → encode → decode → encode per shot.
    let pixels = NSBitmapImageRep(data: data)?.pixelsWide ?? 0
    let scale = area.width > 0 && pixels > 0 ? Double(pixels) / Double(area.width) : 2
    return Capture(png: data, origin: area.origin, size: area.size, scale: scale,
                   encoding: format)
}


// MARK: - OCR (Apple Vision)

struct OCRLine {
    let text: String
    let confidence: Float
    let rect: CGRect          // global, top-left origin, points
}

/// Text plus on-screen rectangles straight from the system OCR. This is the fast
/// path for "find the button labelled X": no model round trip, ~50-150 ms.
func recognizeText(in png: Data, origin: CGPoint, size: CGSize,
                   level: VNRequestTextRecognitionLevel = .accurate,
                   languages: [String] = ["zh-Hans", "en-US"],
                   correction: Bool = true) -> [OCRLine] {
    guard let source = CGImageSourceCreateWithData(png as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return [] }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = level
    request.usesLanguageCorrection = correction
    request.recognitionLanguages = languages
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do { try handler.perform([request]) } catch { return [] }
    guard let observations = request.results else { return [] }
    let width = CGFloat(image.width), height = CGFloat(image.height)
    var lines: [OCRLine] = []
    for observation in observations {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let box = observation.boundingBox                 // normalized, bottom-left
        let rect = CGRect(x: origin.x + box.minX * size.width,
                          y: origin.y + (1 - box.maxY) * size.height,
                          width: box.width * size.width,
                          height: box.height * size.height)
        _ = width; _ = height
        lines.append(OCRLine(text: candidate.string, confidence: candidate.confidence, rect: rect))
    }
    return lines
}

func captureForOCR(windowId: CGWindowID?, screen: Bool, maxDimension: Int = 0) throws -> Capture {
    _ = NSApplication.shared
    // cliCapture hands back the raw screencapture bytes now; OCR still wants the
    // size cap applied, so it is folded in here.
    let cli = { () throws -> Capture in
        let raw = try cliCapture(windowId: windowId, screen: screen, displayIndex: 0)
        return try refine(raw, region: nil, format: raw.encoding, quality: 1,
                          maxDimension: maxDimension)
    }
    if ProcessInfo.processInfo.environment["CU_SHOT_CLI"] == "1" {
        do {
            return try cli()
        } catch {
            return try captureViaMenuBarApp(windowId: windowId, screen: screen,
                                            maxDimension: maxDimension)
        }
    }
    do {
        return try capture(windowId: windowId, screen: screen, displayIndex: 0,
                           maxDimension: maxDimension)
    } catch {
        do {
            return try cli()
        } catch {
            return try captureViaMenuBarApp(windowId: windowId, screen: screen,
                                            maxDimension: maxDimension)
        }
    }
}

// MARK: - capture delegation

/// ScreenCaptureKit completions never fire inside a launchd agent, and the
/// screencapture CLI keeps its own TCC identity. The menu bar app is a real UI
/// process with its own Screen Recording grant, so a capture that fails here is
/// delegated to it over DistributedNotificationCenter: request → PNG in tmp →
/// reply. Everything stays local to the login session.
func captureViaMenuBarApp(windowId: CGWindowID?, screen: Bool, maxDimension: Int,
                          timeout: TimeInterval = 20) throws -> Capture {
    if ProcessInfo.processInfo.environment["CU_NO_APP_SHOT"] == "1" {
        throw NSError(domain: "cu", code: 12,
                      userInfo: [NSLocalizedDescriptionKey: "app capture delegation disabled"])
    }
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: "local.cu.app")
    guard !running.isEmpty else {
        throw NSError(domain: "cu", code: 11,
                      userInfo: [NSLocalizedDescriptionKey:
                                 "no capture permission here and the menu bar app (Computer Use.app) is not running"])
    }
    let requestId = UUID().uuidString
    let path = (NSTemporaryDirectory() as NSString).appendingPathComponent("cu-shot-\(requestId).png")
    var info: [String: Any] = ["id": requestId, "path": path, "maxDimension": maxDimension]
    if let windowId { info["windowId"] = Int(windowId) }
    if screen { info["screen"] = true }
    let center = DistributedNotificationCenter.default()
    var reply: [String: Any] = [:]
    let observer = center.addObserver(forName: NSNotification.Name("local.cu.capture-reply"),
                                      object: nil, queue: nil) { note in
        guard let payload = note.userInfo,
              (payload["id"] as? String) == requestId else { return }
        reply = Dictionary(uniqueKeysWithValues: payload.compactMap { entry in
            (entry.key as? String).map { ($0, entry.value) }
        })
    }
    defer { center.removeObserver(observer) }
    center.postNotificationName(NSNotification.Name("local.cu.capture-request"),
                                object: nil, userInfo: info, deliverImmediately: true)
    let deadline = Date().addingTimeInterval(timeout)
    while reply.isEmpty && Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
    guard !reply.isEmpty else {
        throw NSError(domain: "cu", code: 13,
                      userInfo: [NSLocalizedDescriptionKey:
                                 "the menu bar app did not answer the capture request within \(Int(timeout))s"])
    }
    guard reply["ok"] as? Bool == true else {
        let message = (reply["message"] as? String) ?? "unknown error"
        throw NSError(domain: "cu", code: 14,
                      userInfo: [NSLocalizedDescriptionKey:
                                 "the menu bar app could not capture: \(message)"])
    }
    guard let png = try? Data(contentsOf: URL(fileURLWithPath: path)) else {
        throw NSError(domain: "cu", code: 15,
                      userInfo: [NSLocalizedDescriptionKey: "the menu bar app reported success but wrote no file"])
    }
    try? FileManager.default.removeItem(atPath: path)
    let origin = reply["origin"] as? [String: Double] ?? [:]
    let size = reply["size"] as? [String: Double] ?? [:]
    return Capture(png: png,
                   origin: CGPoint(x: origin["x"] ?? 0, y: origin["y"] ?? 0),
                   size: CGSize(width: size["width"] ?? 0, height: size["height"] ?? 0),
                   scale: reply["scale"] as? Double ?? 1)
}



func imagePixelSize(_ png: Data) -> CGSize? {
    guard let source = CGImageSourceCreateWithData(png as CFData, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? Int,
          let height = properties[kCGImagePropertyPixelHeight] as? Int else { return nil }
    return CGSize(width: width, height: height)
}

/// OCR in-process for the service: warm Vision, returns pixel-space boxes.
func ocrPayload(png: Data, find: String?, exact: Bool, level: String?) -> [String: Any] {
    guard let pixels = imagePixelSize(png) else {
        return ["ok": false, "error": "bad_image"]
    }
    let recognitionLevel: VNRequestTextRecognitionLevel = level == "fast" ? .fast : .accurate
    let started = Date()
    let lines = recognizeText(in: png, origin: .zero, size: pixels, level: recognitionLevel)
    let elapsed = (Date().timeIntervalSince(started) * 1000 * 10).rounded() / 10
    var rows: [[String: Any]] = lines.map { line in
        ["text": line.text,
         "x": line.rect.origin.x, "y": line.rect.origin.y,
         "w": line.rect.width, "h": line.rect.height,
         "cx": line.rect.midX, "cy": line.rect.midY,
         "confidence": (Double(line.confidence) * 100).rounded() / 100]
    }
    var payload: [String: Any] = ["ok": true, "ms": elapsed, "count": rows.count,
                                  "width": pixels.width, "height": pixels.height]
    if let find, !find.isEmpty {
        let needle = find.lowercased()
        rows = rows.filter { row in
            let text = ((row["text"] as? String) ?? "").lowercased()
            return exact ? text == needle : text.contains(needle)
        }
        payload["matches"] = rows
        payload["query"] = find
    } else {
        payload["lines"] = rows
    }
    return payload
}

// MARK: - menu bar app



/// ATS blocks plain http from URLSession in a bundle-less binary, so the status
/// probe uses a socket directly.
func httpGetJSON(port: Int, path: String, timeout: TimeInterval = 1.0) -> [String: Any]? {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var tv = timeval(tv_sec: Int(timeout), tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = UInt16(port).bigEndian
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let connected = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    guard connected == 0 else { return nil }
    let request = "GET \(path) HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    _ = request.withCString { write(fd, $0, strlen($0)) }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while true {
        let n = read(fd, &buffer, buffer.count)
        if n <= 0 { break }
        data.append(contentsOf: buffer[0..<n])
    }
    guard let range = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
    let body = data.subdata(in: range.upperBound..<data.count)
    return (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
}

func openSystemSettings(_ pane: String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = ["x-apple.systempreferences:com.apple.preference.security?\(pane)"]
    try? process.run()
}

func revealServiceBinary() {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = ["-R", NSString(string: "~/Library/Application Support/cu/bin/cu").expandingTildeInPath]
    try? process.run()
}

func restartService() {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    process.arguments = ["kickstart", "-k", "gui/\(getuid())/local.cu.service"]
    try? process.run()
    process.waitUntilExit()
}

func readAllowedAppsFile() -> String {
    let path = NSString(string: "~/.cu/allowed-apps.json").expandingTildeInPath
    guard let data = FileManager.default.contents(atPath: path),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let apps = object["apps"] as? [String] else { return "" }
    return apps.joined(separator: "\n")
}

func writeAllowedAppsFile(_ text: String) {
    let apps = text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
    let path = NSString(string: "~/.cu/allowed-apps.json").expandingTildeInPath
    try? FileManager.default.createDirectory(atPath: NSString(string: "~/.cu").expandingTildeInPath,
                                            withIntermediateDirectories: true)
    if let data = try? JSONSerialization.data(withJSONObject: ["apps": apps],
                                              options: [.prettyPrinted, .sortedKeys]) {
        try? data.write(to: URL(fileURLWithPath: path))
    }
}

func tailLines(_ path: String, _ count: Int) -> [String] {
    guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return [] }
    let lines = text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
    return Array(lines.suffix(count))
}

// HTTP callers are registered in the same client table the MCP proxy writes, so the
// console shows one list regardless of the channel an agent came through.
private var httpCallerCache: [UInt16: (pid: pid_t, name: String, expires: Date)] = [:]

func httpCallerName(peerPort: UInt16) -> (pid: pid_t, name: String) {
    if let hit = httpCallerCache[peerPort], hit.expires > Date() {
        return (hit.pid, hit.name)
    }
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
    task.arguments = ["-nP", "-t", "-iTCP:\(peerPort)", "-sTCP:ESTABLISHED"]
    let out = Pipe()
    task.standardOutput = out
    task.standardError = Pipe()
    var resolved: (pid: pid_t, name: String) = (0, "http")
    if (try? task.run()) != nil {
        task.waitUntilExit()
        let text = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let own = ProcessInfo.processInfo.processIdentifier
        for line in text.split(separator: "\n") {
            let candidate = pid_t(line.trimmingCharacters(in: .whitespaces)) ?? 0
            if candidate != 0 && candidate != own {
                resolved = hostApp(of: candidate)
                break
            }
        }
    }
    httpCallerCache[peerPort] = (resolved.pid, resolved.name, Date().addingTimeInterval(20))
    return resolved
}

func hostApp(of startPid: pid_t) -> (pid: pid_t, name: String) {
    // The socket is usually owned by a child (curl, python, a shell). Climb the
    // parent chain until a process that LaunchServices knows as an app shows up,
    // so the console names WorkBuddy rather than curl.
    var pid = startPid
    for _ in 0..<8 {
        if let app = NSRunningApplication(processIdentifier: pid),
           let name = app.localizedName, !name.isEmpty {
            return (pid, name)
        }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/ps")
        task.arguments = ["-o", "ppid=", "-p", String(pid)]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = Pipe()
        guard (try? task.run()) != nil else { break }
        task.waitUntilExit()
        let text = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard let parent = pid_t(text), parent > 1, parent != pid else { break }
        pid = parent
    }
    return (startPid, NSRunningApplication(processIdentifier: startPid)?.bundleIdentifier
            ?? "pid \(startPid)")
}

/// A token-authenticated caller may declare who it is, which keeps attribution
/// off the `lsof` + `ps` scans (~90 ms per fresh ephemeral port). Untrusted or
/// undeclared callers fall back to scanning.
func declaredCaller(_ headers: [String: String]) -> (pid: pid_t, name: String)? {
    guard let text = headers["x-cu-caller-pid"], let pid = Int32(text), pid > 0 else { return nil }
    let raw = headers["x-cu-caller-name"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return (pid, raw.isEmpty ? "pid \(pid)" : String(raw.prefix(64)))
}

func recordHTTPCall(peerPort: UInt16, tool: String, ms: Int, ok: Bool,
                    declared: (pid: pid_t, name: String)? = nil) {
    let caller = declared ?? httpCallerName(peerPort: peerPort)
    let dir = NSString(string: "~/.cu/clients").expandingTildeInPath
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let key = caller.pid != 0 ? "http-\(caller.pid)" : "http-port-\(peerPort)"
    let path = dir + "/" + key + ".json"
    var object: [String: Any] = [:]
    if let data = FileManager.default.contents(atPath: path),
       let existing = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        object = existing
    }
    var tools = (object["tools"] as? [String: Any]) ?? [:]
    var entry = (tools[tool] as? [String: Any]) ?? ["calls": 0, "ms": 0]
    entry["calls"] = (entry["calls"] as? Int ?? 0) + 1
    entry["ms"] = (entry["ms"] as? Int ?? 0) + ms
    tools[tool] = entry
    let now = Date().timeIntervalSince1970
    object["mcpPid"] = caller.pid
    object["client"] = caller.name
    object["clientPid"] = caller.pid
    object["via"] = "http"
    object["startedAt"] = object["startedAt"] as? Double ?? now
    object["lastSeen"] = now
    object["calls"] = (object["calls"] as? Int ?? 0) + 1
    object["lastTool"] = tool
    object["lastMs"] = ms
    object["lastOk"] = ok
    object["totalMs"] = (object["totalMs"] as? Int ?? 0) + ms
    object["tools"] = tools
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
        try? data.write(to: URL(fileURLWithPath: path))
    }
}

func clientsReport() -> [String: Any] {
    // Each MCP proxy session publishes a record of the app that spawned it, so
    // the console can show who is connected and what they last did. Dead pids are
    // pruned here — a client that quit without cleanup leaves no ghost behind.
    let dir = NSString(string: "~/.cu/clients").expandingTildeInPath
    let manager = FileManager.default
    let now = Date().timeIntervalSince1970
    var rows: [[String: Any]] = []
    var usage: [String: [String: Any]] = [:]
    for name in (try? manager.contentsOfDirectory(atPath: dir)) ?? [] where name.hasSuffix(".json") {
        let path = dir + "/" + name
        guard let data = manager.contents(atPath: path),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let pid = object["mcpPid"] as? Int else { continue }
        var row = object
        let alive = kill(pid_t(pid), 0) == 0
        let idle = now - (object["lastSeen"] as? Double ?? now)
        // A session that ended is still worth showing for a while: the user wants to
        // see that WorkBuddy *was* connected, not watch the row vanish.
        if !alive && idle > 6 * 3600 {
            try? manager.removeItem(atPath: path)
            continue
        }
        row["alive"] = alive
        row["idleSeconds"] = Int(idle)
        rows.append(row)
        if let tools = object["tools"] as? [String: Any] {
            for (tool, value) in tools {
                guard let entry = value as? [String: Any] else { continue }
                var total = usage[tool] ?? ["calls": 0, "ms": 0]
                total["calls"] = (total["calls"] as? Int ?? 0) + (entry["calls"] as? Int ?? 0)
                total["ms"] = (total["ms"] as? Int ?? 0) + (entry["ms"] as? Int ?? 0)
                usage[tool] = total
            }
        }
    }
    rows.sort { ($0["lastSeen"] as? Double ?? 0) > ($1["lastSeen"] as? Double ?? 0) }
    let usageRows = usage.map { tool, value in
        ["tool": tool, "calls": value["calls"] ?? 0, "ms": value["ms"] ?? 0] as [String: Any]
    }.sorted { ($0["calls"] as? Int ?? 0) > ($1["calls"] as? Int ?? 0) }
    var report: [String: Any] = ["ok": true, "count": rows.count,
                                 "clients": rows, "usage": usageRows]
    if let text = try? String(contentsOfFile: NSString(string: "~/.cu/activity.json").expandingTildeInPath,
                              encoding: .utf8),
       let activity = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] {
        report["activity"] = activity
        report["activityAge"] = Int(now - (activity["ts"] as? Double ?? now))
    }
    return report
}

// MARK: - agent catalog (magpie-style)

struct AgentSpec {
    let id: String
    let name: String
    let processes: [String]
    let configPath: String?      // nil = the agent manages its connectors in its own UI
    let managedNote: String?
    // Claude Code refuses a server called "computer-use" (reserved name), so it
    // gets its own key; the other clients keep the name their UIs already show.
    var serverName: String = "computer-use"
}

func agentSpecs() -> [AgentSpec] {
    let home = NSHomeDirectory()
    return [
        AgentSpec(id: "dsh", name: "DeepSeek Harness", processes: ["DeepSeek Harness"],
                  configPath: nil, managedNote: "由 DSH desktop profile 管理"),
        AgentSpec(id: "qoder", name: "Qoder CN", processes: ["Qoder"],
                  configPath: nil, managedNote: "由 Qoder 设置 → 连接器 管理；需握手和调用记录确认"),
        AgentSpec(id: "workbuddy", name: "WorkBuddy", processes: ["WorkBuddy"],
                  configPath: home + "/.workbuddy/mcp.json", managedNote: nil),
        AgentSpec(id: "claude-code", name: "Claude Code", processes: ["claude"],
                  configPath: home + "/.claude.json", managedNote: nil,
                  serverName: "cu"),
        AgentSpec(id: "claude-desktop", name: "Claude Desktop", processes: ["Claude"],
                  configPath: home + "/Library/Application Support/Claude/claude_desktop_config.json",
                  managedNote: nil),
    ]
}

// Stable home for the MCP proxy script so agent configs survive repo moves.
func agentProxyScriptPath() -> String {
    NSString(string: "~/Library/Application Support/cu/mcp/server.py").expandingTildeInPath
}

func installedEnginePath() -> String {
    let candidates = [
        "/Applications/Computer Use.app/Contents/MacOS/Computer Use",
        NSHomeDirectory() + "/Applications/Computer Use.app/Contents/MacOS/Computer Use",
    ]
    if let found = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
        return found
    }
    return URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().path
}

func runningProcessNames() -> Set<String> {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/ps")
    process.arguments = ["-axo", "comm="]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    do { try process.run() } catch { return [] }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard let text = String(data: data, encoding: .utf8) else { return [] }
    return Set(text.split(separator: "\n").map { line in
        line.split(separator: "/").last.map { String($0).trimmingCharacters(in: .whitespaces) } ?? ""
    })
}

func dshProfileState() -> String {
    let path = NSHomeDirectory() + "/.dsh/profiles/desktop/package.json"
    guard let data = FileManager.default.contents(atPath: path),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          object["dependencies"] == nil || object["dependencies"] is [String: Any],
          object["dsh"] == nil || object["dsh"] is [String: Any] else { return "unknown" }
    let dsh = object["dsh"] as? [String: Any] ?? [:]
    guard dsh["profile"] == nil || dsh["profile"] is [String: Any] else { return "unknown" }
    let profile = dsh["profile"] as? [String: Any] ?? [:]
    guard profile["bundles"] == nil || profile["bundles"] is [String] else { return "unknown" }
    let dependencies = object["dependencies"] as? [String: Any] ?? [:]
    let dependency = dependencies["dsh-super-computer-use"] is String
    let bundle = (profile["bundles"] as? [String] ?? []).contains("dsh-super-computer-use")
    return dependency && bundle ? "configured" : dependency || bundle ? "partial" : "absent"
}

func agentsCatalog() -> [[String: Any]] {
    let rows = (clientsReport()["clients"] as? [[String: Any]]) ?? []
    let names = runningProcessNames()
    return agentSpecs().filter { spec in
        guard spec.id == "qoder" else { return true }
        let running = names.contains { name in spec.processes.contains { name.hasPrefix($0) } }
        let roots = ["/Applications", NSHomeDirectory() + "/Applications"]
        let installed = roots.contains { root in
            ["Qoder.app", "Qoder CN.app"].contains { app in
                FileManager.default.fileExists(atPath: root + "/" + app)
            }
        }
        return running || installed
    }.map { spec in
        var wired = false
        if let path = spec.configPath,
           let data = FileManager.default.contents(atPath: path),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let servers = object["mcpServers"] as? [String: Any] {
            wired = servers[spec.serverName] != nil
        }
        let running = names.contains { name in
            spec.processes.contains { name.hasPrefix($0) }
        }
        let matched = rows.filter { row -> Bool in
            let client = (row["client"] as? String ?? "").lowercased()
            let info = row["clientInfo"] as? [String: Any] ?? [:]
            let reported = (info["name"] as? String ?? "").lowercased()
            let isCode = client.contains("claude-code") || client == "claude" && (row["appPath"] as? String ?? "").contains(".app") == false || reported.contains("claude-code")
            if spec.id == "dsh" { return client == "dsh-computer-use" && (row["via"] as? String) == "http" }
            if spec.id == "claude-code" { return isCode }
            if spec.id == "claude-desktop" { return client.contains("claude") && !isCode }
            return spec.processes.contains { client.contains($0.lowercased()) }
        }
        var entry: [String: Any] = [
            "id": spec.id, "name": spec.name,
            "running": running, "wired": wired,
            // Managed agents keep their connectors in their own UI; only the
            // config-file agents get a connect switch in the console.
            "configurable": spec.configPath != nil,
            "connected": matched.contains { ($0["alive"] as? Bool ?? false) && $0["initializedAt"] != nil },
        ]
        if let best = matched.first {
            entry["lastTool"] = (best["lastTool"] as? String) ?? ""
            entry["idleSeconds"] = best["idleSeconds"] ?? 0
            entry["calls"] = best["calls"] ?? 0
        }
        let live = matched.filter { $0["alive"] as? Bool ?? false }
        if spec.id == "dsh" {
            let config = dshProfileState()
            let verified = live.contains { ($0["lastOk"] as? Bool ?? false) && ($0["calls"] as? Int ?? 0) > 0 }
            entry["configState"] = config
            entry["wired"] = config == "configured"
            entry["connected"] = verified
            entry["state"] = verified ? "● 调用已验证" : "○ 未验证接入"
            let details = ["configured": "插件依赖和 bundle 已配置", "partial": "插件配置不完整", "absent": "插件未配置", "unknown": "无法读取插件配置"]
            entry["note"] = verified ? "最近调用成功；\(details[config] ?? "")" : "\(details[config] ?? "无法读取插件配置") · 尚无成功调用验证"
            return entry
        }
        let verified = live.contains { $0["lastSuccessfulCallAt"] != nil }
        let listed = live.contains { $0["toolsListedAt"] != nil }
        let initialized = live.contains { $0["initializedAt"] != nil }
        entry["state"] = verified ? "● 调用已验证" : listed ? "● 已请求工具清单" : initialized ? "◐ 已握手" : wired ? "◐ 已配置·待连接" : "○ 未验证接入"
        entry["note"] = verified ? "本客户端已有成功调用；不代表其他会话可用"
            : listed ? "客户端已请求工具清单，请在新会话调用 list_windows 验证"
            : initialized ? "握手完成，尚未收到工具清单请求"
            : wired ? "配置存在不代表当前会话已加载；重连 MCP 或重启客户端并新建会话"
            : spec.managedNote ?? "请先写入 MCP 配置"
        return entry
    }
}

func agentMCPEntry(name: String) -> [String: Any] {
    ["command": "/usr/bin/python3",
     "args": [agentProxyScriptPath()],
     "env": ["CU_BIN": installedEnginePath()]]
}

func agentsConnect(ids: [String]?) -> [[String: Any]] {
    var results: [[String: Any]] = []
    for spec in agentSpecs() {
        if let ids, !ids.isEmpty, !ids.contains(spec.id) { continue }
        guard let path = spec.configPath else {
            results.append(["id": spec.id, "name": spec.name, "status": "managed",
                            "note": spec.managedNote ?? ""])
            continue
        }
        let manager = FileManager.default
        var object: [String: Any] = [:]
        if manager.fileExists(atPath: path) {
            guard let data = manager.contents(atPath: path),
                  let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  parsed["mcpServers"] == nil || parsed["mcpServers"] is [String: Any] else {
                results.append(["id": spec.id, "name": spec.name, "status": "error",
                                "error": "现有配置不可读或格式无效，已保留原文件，请先修复配置"])
                continue
            }
            object = parsed
        }
        var servers = object["mcpServers"] as? [String: Any] ?? [:]
        let desired = agentMCPEntry(name: spec.serverName)
        func canonical(_ value: [String: Any]) -> String {
            guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
                  let text = String(data: data, encoding: .utf8) else { return "" }
            return text
        }
        if let existing = servers[spec.serverName] {
            if let entry = existing as? [String: Any], canonical(entry) == canonical(desired) {
                results.append(["id": spec.id, "name": spec.name, "status": "already"])
            } else {
                results.append(["id": spec.id, "name": spec.name, "status": "error",
                                "error": "同名 MCP 配置与本程序配置不一致，已保留原配置：\(spec.serverName)"])
            }
            continue
        }
        servers[spec.serverName] = desired
        object["mcpServers"] = servers
        let backup = path + ".bak-cu"
        try? manager.removeItem(atPath: backup)
        if manager.fileExists(atPath: path) { try? manager.copyItem(atPath: path, toPath: backup) }
        do {
            let data = try JSONSerialization.data(withJSONObject: object,
                                                  options: [.prettyPrinted, .sortedKeys])
            try manager.createDirectory(at: URL(fileURLWithPath: path).deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: URL(fileURLWithPath: path), options: .atomic)
            results.append(["id": spec.id, "name": spec.name, "status": "wired", "backup": backup])
        } catch {
            results.append(["id": spec.id, "name": spec.name, "status": "error", "error": "\(error)"])
        }
    }
    return results
}

func agentsDisconnect(ids: [String]?) -> [[String: Any]] {
    var results: [[String: Any]] = []
    for spec in agentSpecs() {
        if let ids, !ids.isEmpty, !ids.contains(spec.id) { continue }
        guard let path = spec.configPath else {
            results.append(["id": spec.id, "name": spec.name, "status": "managed",
                            "note": spec.managedNote ?? ""])
            continue
        }
        let manager = FileManager.default
        guard manager.fileExists(atPath: path),
              let data = manager.contents(atPath: path),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["mcpServers"] is [String: Any] else {
            results.append(["id": spec.id, "name": spec.name, "status": "absent"])
            continue
        }
        var servers = object["mcpServers"] as? [String: Any] ?? [:]
        guard let existing = servers[spec.serverName] else {
            results.append(["id": spec.id, "name": spec.name, "status": "absent"])
            continue
        }
        let desired = agentMCPEntry(name: spec.serverName)
        let desiredData = try? JSONSerialization.data(withJSONObject: desired, options: [.sortedKeys])
        let existingData = (existing as? [String: Any]).flatMap {
            try? JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys])
        }
        guard let desiredData, let existingData, existingData == desiredData else {
            results.append(["id": spec.id, "name": spec.name, "status": "error",
                            "error": "同名 MCP 配置与本程序配置不一致，已保留原配置：\(spec.serverName)"])
            continue
        }
        servers.removeValue(forKey: spec.serverName)
        var updated = object
        if servers.isEmpty { updated.removeValue(forKey: "mcpServers") }
        else { updated["mcpServers"] = servers }
        let backup = path + ".bak-cu"
        try? manager.removeItem(atPath: backup)
        try? manager.copyItem(atPath: path, toPath: backup)
        do {
            let data = try JSONSerialization.data(withJSONObject: updated,
                                                  options: [.prettyPrinted, .sortedKeys])
            try data.write(to: URL(fileURLWithPath: path), options: .atomic)
            results.append(["id": spec.id, "name": spec.name, "status": "removed", "backup": backup])
        } catch {
            results.append(["id": spec.id, "name": spec.name, "status": "error", "error": "\(error)"])
        }
    }
    return results
}

func releaseMenuBarLock() {
    let path = NSString(string: "~/.cu/menubar.pid").expandingTildeInPath
    guard let text = try? String(contentsOfFile: path, encoding: .utf8),
          pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)) == getpid() else { return }
    try? FileManager.default.removeItem(atPath: path)
}

/// Held for the lifetime of the menu-bar process. flock is atomic across
/// processes, unlike the old "read pid file, check liveness, then write" dance,
/// which let two simultaneous launches both become the menu bar.
private var menuBarLockHandle: Int32 = -1

func acquireMenuBarLock() -> Bool {
    let lockPath = NSString(string: "~/.cu/menubar.lock").expandingTildeInPath
    let fd = open(lockPath, O_CREAT | O_RDWR, 0o600)
    guard fd >= 0 else { return true }        // never block startup on a lock failure
    if flock(fd, LOCK_EX | LOCK_NB) != 0 {
        close(fd)
        return false
    }
    _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
    menuBarLockHandle = fd
    // Keep the pid file for diagnostics and for older copies' takeover detection.
    let pidPath = NSString(string: "~/.cu/menubar.pid").expandingTildeInPath
    try? String(ProcessInfo.processInfo.processIdentifier).write(toFile: pidPath, atomically: true,
                                                                 encoding: .utf8)
    return true
}

func runMenuBar(openSettings: Bool, openMenu: Bool = false, openConsole: Bool = false,
                snapshotConsole: String? = nil, snapshotPage: String? = nil,
                snapshotGuide: String? = nil, selftest: Bool = false) -> Never {
    // Snapshot/selftest processes are one-shot helpers: they must not take over
    // the menu-bar instance, so they skip the single-instance lock.
    let oneShot = snapshotConsole != nil || snapshotGuide != nil || selftest
    if !oneShot {
        // A takeover can race: the previous instance may still be exiting when the
        // new copy asks for the lock. Retry before giving up so a double launch
        // cannot leave zero menu-bar instances behind.
        var acquired = acquireMenuBarLock()
        var attempt = 0
        while !acquired && attempt < 40 {
            usleep(150_000)
            acquired = acquireMenuBarLock()
            attempt += 1
        }
        guard acquired else { exit(0) }
    }
    let previous = frontmostBeforeLaunch()
    let app = NSApplication.shared
    let controller = MenuBarController()
    controller.launchFrontPid = previous
    controller.openSettingsAtLaunch = openSettings
    controller.openMenuAtLaunch = openMenu && !oneShot
    controller.openConsoleAtLaunch = openConsole && !oneShot
    controller.snapshotPath = snapshotConsole
    controller.snapshotPage = snapshotPage
    controller.guideSnapshotPath = snapshotGuide
    controller.selftestMode = selftest
    app.delegate = controller
    app.run()
    exit(0)
}

// MARK: - dispatch



let args = Args(Array(CommandLine.arguments.dropFirst()))

// `--events-v1` opts this command into NDJSON phase events before its result.
eventsV1 = args.flag("events-v1")
if let sid = args["session-id"], !sid.isEmpty { eventsSessionId = sid }
if let aid = args["action-id"], !aid.isEmpty { eventsActionId = aid } else { eventsActionId = "cli-\(args.command)" }

// LaunchServices starts the bundle with no arguments; treat that as "open the app"
// instead of printing an unknown-command error and exiting.
switch args.command.isEmpty ? "app" : args.command {
case "perms":
    emit(permissions())

case "windows":
    emit(windowsPayload(explicitPid: args.int("pid")))

case "screens", "displays":
    emit(screensPayload())

case "frontmost":
    emit(frontmostPayload())

case "activate":
    let pid: pid_t
    if let windowId = args.int("window") {
        guard let window = onScreenWindows().first(where: { $0.id == CGWindowID(windowId) }) else {
            fail("window_gone", "window \(windowId) is not on screen")
        }
        pid = window.pid
    } else if let explicit = args.int("pid") {
        pid = pid_t(explicit)
    } else {
        fail("missing_target", "pass --window <id> or --pid <pid>")
    }
    let ok = activate(pid: pid)
    emit(["ok": ok, "action": "activate", "pid": Int(pid),
          "frontmost": frontmost().app])

case "shot":
    guard #available(macOS 14.0, *) else { fail("unsupported", "ScreenCaptureKit needs macOS 14") }
    let screen = args.flag("screen")
    let id = args.int("window")
    if !screen && id == nil { fail("missing_target", "pass --window <id> or --screen") }
    // One window-list sweep, reused for the Stage Manager check and for the
    // capture's origin/scale bookkeeping.
    var knownBounds: CGRect?
    if let id {
        let windows = onScreenWindows()
        if offStageIds(windows).contains(CGWindowID(id)) {
            fail("off_stage_window", "that window is a Stage Manager thumbnail; bring it on stage first")
        }
        knownBounds = windows.first(where: { $0.id == CGWindowID(id) })?.bounds
    }
    // ScreenCaptureKit talks to the window server; a bare CLI has no CGS session
    // until AppKit is initialized once.
    _ = NSApplication.shared
    do {
        let maxDimension = args.int("max-dim") ?? 0
        let jpeg = (args["format"] ?? "png").lowercased() == "jpeg"
        let format = jpeg ? "jpeg" : "png"
        // A crop re-encodes anyway, so crop from the lossless capture rather than
        // from an already-compressed JPEG.
        let captureFormat = jpeg && args["region"] == nil ? "jpeg" : "png"
        let raw: Capture
        let idCG = id.map(CGWindowID.init)
        if args.flag("via-app") {
            // Diagnostic path: prove the menu bar app can capture on our behalf,
            // whatever this process's own grants are.
            raw = try captureViaMenuBarApp(windowId: idCG, screen: screen,
                                           maxDimension: maxDimension)
        } else if ProcessInfo.processInfo.environment["CU_SHOT_CLI"] == "1" {
            // Measured both routes on this machine: screencapture answers in
            // ~250–380 ms (JPEG/PNG), delegating to the menu bar app in
            // ~600–700 ms. The CLI stays first; the app is the fallback, as
            // when Screen Recording is only granted to the app.
            do {
                raw = try cliCapture(windowId: idCG, screen: screen,
                                     displayIndex: args.int("display") ?? 0,
                                     format: captureFormat, bounds: knownBounds)
            } catch {
                raw = try captureViaMenuBarApp(windowId: idCG, screen: screen,
                                               maxDimension: maxDimension)
            }
        } else {
            do {
                raw = try capture(windowId: idCG, screen: screen,
                                  displayIndex: args.int("display") ?? 0,
                                  maxDimension: maxDimension)
            } catch {
                // The async SCK path needs an app that gets completion callbacks;
                // a launchd agent does not, so fall back to the synchronous CLI,
                // then to the menu bar app and its own Screen Recording grant.
                do {
                    raw = try cliCapture(windowId: idCG, screen: screen,
                                         displayIndex: args.int("display") ?? 0,
                                         format: captureFormat, bounds: knownBounds)
                } catch {
                    raw = try captureViaMenuBarApp(windowId: idCG, screen: screen,
                                                   maxDimension: maxDimension)
                }
            }
        }
        // Cropping happens on the already-captured pixels, so asking for a region
        // costs nothing extra; raise --max-dim when the region needs more detail.
        let shot = try refine(raw, region: args["region"].flatMap(parseRegion),
                              format: format,
                              quality: args.double("quality") ?? 0.82,
                              maxDimension: maxDimension)
        let mime = shot.encoding == "jpeg" ? "image/jpeg" : "image/png"
        var payload: [String: Any] = [
            "ok": true, "mimeType": mime, "bytes": shot.png.count,
            // the image is scale× the size below; global = origin + pixel/scale
            "origin": ["x": shot.origin.x, "y": shot.origin.y],
            "size": ["width": shot.size.width, "height": shot.size.height],
            "scale": shot.scale,
        ]
        payload["capturedAt"] = Int(Date().timeIntervalSince1970 * 1000)
        if let display = displayId(containing: CGPoint(x: shot.origin.x + shot.size.width / 2,
                                                       y: shot.origin.y + shot.size.height / 2)) {
            payload["displayId"] = display
        }
        if let id { payload["windowId"] = id }
        if screen { payload["screen"] = true }
        if let out = args["out"] {
            try shot.png.write(to: URL(fileURLWithPath: out))
            payload["path"] = out
        } else {
            payload["base64"] = shot.png.base64EncodedString()
        }
        emit(payload)
    } catch {
        // Every capture API on macOS (ScreenCaptureKit, CGWindowListCreateImage
        // and the screencapture CLI) is gated by the same Screen Recording
        // grant, and it belongs to the app that launched this process — the
        // editor (Claude, Cursor, …), not to `cu`, when it runs under one.
        // Nothing here can grant it; say exactly which toggle to flip.
        let host = hostAppName() ?? "this app"
        fail("capture_failed", error.localizedDescription,
             ["hint": "grant Screen Recording to \(host) in System Settings → 隐私与安全性 → 屏幕录制, then restart \(host)",
              "hostApp": host,
              "screenRecording": CGPreflightScreenCaptureAccess()])
    }

case "ax":
    guard let pid = args.int("pid") else { fail("missing_pid", "pass --pid <pid>") }
    if !requireAccessibility() {
        fail("accessibility_denied", "grant Accessibility to this binary", ["pid": pid])
    }
    let root = AXUIElementCreateApplication(pid_t(pid))
    let depth = args.int("depth") ?? 8
    let limit = args.int("limit") ?? 600
    let needle = args["find"]?.lowercased()
    // Menu bar items report a zero-size frame until their menu is open: clicking
    // their coordinates does nothing. They are noise for a "find a button" call,
    // so they are dropped unless --all asks for the raw tree.
    let keepZeroSize = args.flag("all")
    var rows: [[String: Any]] = []
    var dropped = 0
    if let needle {
        // Search the same tree snapshot returns: the shallow generic walk stops at
        // depth 8 and only reads title/value, so Chromium/Electron web content
        // (~20 levels deep, labels often in AXDescription) was invisible to find.
        let windowScope = args.int("window").map(CGWindowID.init)
        let (_, nodes, _) = snapshotNodes(pid: pid_t(pid), includeZeroSize: keepZeroSize,
                                       windowId: windowScope)
        for node in nodes {
            let haystack = (node.title + " " + node.value).lowercased()
            guard haystack.contains(needle) else { continue }
            if !keepZeroSize, (node.frame?.width ?? 0) < 1 || (node.frame?.height ?? 0) < 1 {
                dropped += 1
                continue
            }
            var row: [String: Any] = ["role": node.role, "title": node.title,
                                      "value": node.value,
                                      "depth": node.path.split(separator: ".").count,
                                      "enabled": node.enabled, "ref": node.ref,
                                      "actions": node.actions]
            if let frame = node.frame {
                row["x"] = frame.origin.x
                row["y"] = frame.origin.y
                row["w"] = frame.size.width
                row["h"] = frame.size.height
                row["cx"] = frame.midX
                row["cy"] = frame.midY
            }
            rows.append(row)
            if rows.count >= 25 { break }
        }
        rows.sort { (($0["w"] as? Double ?? 0) * ($0["h"] as? Double ?? 0))
                  > (($1["w"] as? Double ?? 0) * ($1["h"] as? Double ?? 0)) }
        emit(["ok": true, "pid": pid, "matches": rows, "droppedZeroSize": dropped,
              "note": dropped > 0 ? "menu items without a frame were skipped; pass --all to see them" : ""])
    } else {
        _ = walk(from: root, depth: depth, limit: limit) { node in
            if !keepZeroSize, (node.frame?.width ?? 0) < 1 || (node.frame?.height ?? 0) < 1 {
                dropped += 1
                return false
            }
            rows.append(nodeJSON(node))
            return false
        }
        emit(["ok": true, "pid": pid, "count": rows.count, "nodes": rows, "droppedZeroSize": dropped])
    }

case "expect":
    // Assert what actually happened, so a caller never has to trust an "ok".
    // Polls the accessibility tree (no screenshot) until the control matches,
    // the timeout runs out, or the control disappears.
    let expectPair = resolveTargetPair(pid: args.int("pid"), window: args.int("window"), action: "expect")
    guard let pid = expectPair.pid.map({ Int($0) }) else { fail("missing_pid", "pass --pid <pid>") }
    if !requireAccessibility() {
        fail("accessibility_denied", "grant Accessibility to this binary", ["pid": pid])
    }
    let expectTarget = actionTargetDict(pid: pid_t(pid), windowId: args.int("window"))
    emitActionEventLine("targetReady", kind: "expect", target: expectTarget)
    let wantRef = args["ref"]
    let wantQuery = args["find"]?.lowercased()
    if wantRef == nil && wantQuery == nil {
        fail("missing_target", "pass --ref k… or --find <text>")
    }
    let wantEnabled: Bool? = args["enabled"].flatMap {
        ["true", "1", "yes"].contains($0.lowercased()) ? true
            : (["false", "0", "no"].contains($0.lowercased()) ? false : nil)
    }
    let wantValue = args["value"]
    let wantContains = args["contains"]?.lowercased()
    let windowScope = args.int("window").map(CGWindowID.init)
    let timeout = Double(args.int("timeout") ?? 2000) / 1000
    let started = Date()
    var reason = "never sampled"
    while Date() < started.addingTimeInterval(timeout) {
        let (_, nodes, _) = snapshotNodes(pid: pid_t(pid), includeZeroSize: true,
                                       windowId: windowScope)
        let node: SnapNode?
        if let ref = wantRef {
            let path = ref.hasPrefix("k") ? String(ref.dropFirst()) : ref
            node = nodes.first { $0.path == path }
        } else {
            node = nodes.first {
                $0.title.lowercased().contains(wantQuery!) || $0.value.lowercased().contains(wantQuery!)
            }
        }
        guard let node else {
            reason = "the control is no longer in the tree"
            usleep(200_000)
            continue
        }
        var problems: [String] = []
        if let wantEnabled, node.enabled != wantEnabled {
            problems.append("enabled is \(node.enabled)")
        }
        if let wantValue, node.value != wantValue {
            problems.append("value is \"\(node.value.prefix(60))\"")
        }
        if let wantContains,
           !node.value.lowercased().contains(wantContains),
           !node.title.lowercased().contains(wantContains) {
            problems.append("text does not contain \"\(wantContains)\"")
        }
        if problems.isEmpty {
            emitActionEventLine("verified", kind: "expect", target: expectTarget,
                                verification: ["matched": true, "evidenceRef": "expect"])
            emit(["ok": true, "action": "expect", "ref": node.ref, "role": node.role,
                  "title": node.title, "enabled": node.enabled,
                  "ms": Int(Date().timeIntervalSince(started) * 1000)])
            exit(0)
        }
        reason = problems.joined(separator: "; ")
        usleep(200_000)
    }
    emitActionEventLine("unverified", kind: "expect", target: expectTarget, reason: reason)
    emit(["ok": false, "action": "expect", "error": "expect_failed", "message": reason,
          "pid": pid, "ms": Int(Date().timeIntervalSince(started) * 1000),
          "hint": "the app did not reach that state; the action had no visible effect"])
    exit(1)

case "apps":
    emit(["ok": true, "apps": runningApps()])

case "launch":
    guard let spec = args["app"] else { fail("missing_app", "pass --app <bundle id | path>") }
    launchApp(spec)

case "snapshot":
    let snapshotPair = resolveTargetPair(pid: args.int("pid"), window: args.int("window"), action: "snapshot")
    guard let pid = snapshotPair.pid.map({ Int($0) }) else { fail("missing_pid", "pass --pid <pid>") }
    if !requireAccessibility() {
        fail("accessibility_denied", "grant Accessibility to this binary", ["pid": pid])
    }
    // The tree of an app that is still animating in is a moving target. Sample
    // until two consecutive walks agree, the way the shipped engine waits before
    // it reports state, so refs are resolved against a settled tree.
    func fingerprint(_ nodes: [SnapNode]) -> Int {
        var hasher = Hasher()
        for node in nodes {
            hasher.combine(node.path)
            hasher.combine(node.role)
            hasher.combine(node.title)
            hasher.combine(node.value)
            hasher.combine(node.enabled)
            if let frame = node.frame {
                hasher.combine(Int(frame.origin.x))
                hasher.combine(Int(frame.origin.y))
                hasher.combine(Int(frame.width))
                hasher.combine(Int(frame.height))
            }
        }
        return hasher.finalize()
    }
    let settle = args.int("settle") ?? 600
    let windowScope = args.int("window").map(CGWindowID.init)
    let withActions = !args.flag("no-actions")
    // Large editors legitimately exceed the default 800-node budget; allow a
    // bounded override so a caller can page deeper instead of silently losing
    // elements. Capped to keep one call from stalling the queue.
    let limit = max(50, min(args.int("max-nodes") ?? SNAP_LIMIT, 3000))
    let maxDepth = max(4, min(args.int("depth") ?? SNAP_DEPTH, 48))
    var (app, nodes, truncated) = snapshotNodes(pid: pid_t(pid), includeZeroSize: args.flag("all"),
                                     windowId: windowScope, includeActions: withActions,
                                     limit: limit, maxDepth: maxDepth)
    var previous = fingerprint(nodes)
    // Settling compares consecutive walks and stops when two agree. A tree that
    // never agrees (live clock, spinner, transfer counter) used to burn the whole
    // wall-clock deadline in 120 ms sleeps — 600 ms+ of pure wait on Finder. Cap
    // the extra re-walks instead so the worst case is bounded and the caller
    // (the plugin's post-action observe) can re-read while the tree is unchanged.
    let maxExtraWalks = max(0, args.int("max-settle-walks") ?? 2)
    var extraWalks = 0
    let deadline = Date().addingTimeInterval(Double(settle) / 1000)
    var first = true
    while Date() < deadline && extraWalks < maxExtraWalks {
        // Compare immediately first: a quiet tree settles in two back-to-back
        // walks, and most calls are on a quiet tree.
        if !first { usleep(120_000) }
        first = false
        extraWalks += 1
        let next = snapshotNodes(pid: pid_t(pid), includeZeroSize: args.flag("all"),
                                 windowId: windowScope, includeActions: withActions,
                                 limit: limit, maxDepth: maxDepth)
        truncated = next.truncated
        let current = fingerprint(next.nodes)
        app = next.app
        nodes = next.nodes
        if current == previous { break }
        previous = current
    }
    emit(["ok": true, "pid": pid, "app": app, "version": SNAP_VERSION,
          "count": nodes.count, "settleWalks": extraWalks,
          "truncated": truncated, "limit": limit,
          "nodes": nodes.map(nodeLine)])

case "setvalue", "set-value":
    guard let pid = args.int("pid") else { fail("missing_pid", "pass --pid <pid>") }
    guard let ref = args["ref"] else { fail("missing_ref", "pass --ref e12") }
    guard let text = args["text"] else { fail("missing_text", "pass --text \"…\"") }
    let node = resolveNode(pid: pid_t(pid), ref: ref, role: args["role"], title: args["title"],
                           windowId: args.int("window").map(CGWindowID.init))
    let element = node.element
    let status = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFTypeRef)
    guard status == .success else {
        fail("setvalue_failed", "AXUIElementSetAttributeValue returned \(status.rawValue)",
             ["ref": ref, "role": node.role])
    }
    let readBack = stringAttribute(element, kAXValueAttribute)
    emit(["ok": readBack == text, "action": "setvalue", "pid": pid, "ref": ref,
          "role": node.role, "value": readBack])

case "action":
    guard let pid = args.int("pid") else { fail("missing_pid", "pass --pid <pid>") }
    guard let ref = args["ref"] else { fail("missing_ref", "pass --ref e12") }
    guard let name = args["name"] else { fail("missing_name", "pass --name AXPress") }
    let node = resolveNode(pid: pid_t(pid), ref: ref, role: args["role"], title: args["title"],
                           windowId: args.int("window").map(CGWindowID.init))
    let element = node.element
    let available = actionNames(element)
    guard available.contains(name) else {
        fail("no_such_action", "\(ref) does not expose \(name)", ["actions": available])
    }
    if name == "AXPress", !node.enabled, !args.flag("force") {
        fail("control_disabled", "\(ref) is disabled — its AXPress would be a no-op",
             ["ref": ref, "role": node.role,
              "hint": "enable the control first, or pass force: true"])
    }
    let status = AXUIElementPerformAction(element, name as CFString)
    emit(["ok": status == .success, "action": name, "pid": pid, "ref": ref, "role": node.role,
          "status": Int(status.rawValue)])

case "paste":
    guard let text = args["text"] else { fail("missing_text", "pass --text \"…\"") }
    if args.flag("background") {
        // No clipboard, no Cmd+V, no focus change: insert through the target
        // element's AXSelectedText (the same path an insertion point uses).
        let pid = backgroundTarget(args, "paste", allowOffStage: args.flag("try-offstage"))
        // A background app exposes no focused element at all (Chromium only
        // reports focus for its key window), so a ref from the snapshot is the
        // way to name the control the caller is looking at.
        let target: AXUIElement
        var targetRef = ""
        if let ref = args["ref"] {
            let node = resolveNode(pid: pid, ref: ref, role: args["role"], title: args["title"])
            target = node.element
            targetRef = ref
        } else if let focused = focusedElement(pid: pid) {
            target = focused
        } else {
            fail("no_focused_element",
                 "this app has no focused element to paste into; pass ref from a snapshot",
                 ["pid": Int(pid), "hint": "snapshot --pid \(Int(pid)), then paste --ref k…"])
        }
        _ = AXUIElementSetAttributeValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        pump(0.04)
        let before = stringAttribute(target, kAXValueAttribute)
        let status = AXUIElementSetAttributeValue(target, kAXSelectedTextAttribute as CFString,
                                                  text as CFTypeRef)
        pump(0.08)
        var value = stringAttribute(target, kAXValueAttribute)
        var via = "ax-selectedtext"
        if status != .success || value == before {
            let status = AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString,
                                                      (before + text) as CFTypeRef)
            pump(0.05)
            value = stringAttribute(target, kAXValueAttribute)
            via = "ax-setvalue"
            if status != .success || value == before {
                // Electron/React composers refuse both AX paths; their own
                // context-menu paste still works while the app stays in the
                // background. Verified by reading the element back.
                if pasteViaContextMenu(pid: pid, text: text, element: target) {
                    pump(0.15)
                    value = stringAttribute(target, kAXValueAttribute)
                    via = "context-menu-paste"
                }
                if value == before {
                    fail("paste_needs_focus",
                         "this control does not accept AX text insertion or menu paste; use type_text, set_value, or foreground: true",
                         ["pid": Int(pid), "ref": targetRef,
                          "role": stringAttribute(target, kAXRoleAttribute)])
                }
            }
        }
        markAction()
        emit(["ok": true, "action": "paste", "characters": text.count,
              "via": via, "pid": Int(pid), "ref": targetRef,
              "frontmostAfter": frontmost().app])
        exit(0)
    }
    guardedFocus(args, action: "paste")
    pasteText(text, format: args["format"] ?? "text")
    emit(["ok": true, "action": "paste", "characters": text.count,
          "format": args["format"] ?? "text"])

case "selecttext", "select-text":
    guard let pid = args.int("pid") else { fail("missing_pid", "pass --pid <pid>") }
    guard let ref = args["ref"] else { fail("missing_ref", "pass --ref k0.3.2") }
    guard let needle = args["text"], !needle.isEmpty else { fail("missing_text", "pass --text \"…\"") }
    let node = resolveNode(pid: pid_t(pid), ref: ref, role: args["role"], title: args["title"],
                           windowId: args.int("window").map(CGWindowID.init))
    let element = node.element
    let value = stringAttribute(element, kAXValueAttribute)
    guard !value.isEmpty else {
        fail("no_text", "\(ref) has no value to select in", ["role": node.role])
    }
    var matches: [Range<String.Index>] = []
    var cursor = value.startIndex
    while let found = value.range(of: needle, range: cursor..<value.endIndex) {
        matches.append(found)
        cursor = found.upperBound
    }
    let prefix = args["prefix"] ?? ""
    let suffix = args["suffix"] ?? ""
    let filtered = matches.filter { range in
        (prefix.isEmpty || value[..<range.lowerBound].hasSuffix(prefix))
            && (suffix.isEmpty || value[range.upperBound...].hasPrefix(suffix))
    }
    guard filtered.count == 1 else {
        fail("ambiguous_text", "found \(matches.count) matches, \(filtered.count) after prefix/suffix",
             ["hint": "pass --prefix/--suffix to disambiguate"])
    }
    let found = filtered[0]
    let kind = args["selection"] ?? "text"
    let startIndex = kind == "cursor_after" ? found.upperBound : found.lowerBound
    let endIndex = kind == "text" ? found.upperBound : startIndex
    guard let start16 = startIndex.samePosition(in: value.utf16),
          let end16 = endIndex.samePosition(in: value.utf16) else {
        fail("bad_range", "could not map the match to UTF-16 offsets")
    }
    var range = CFRange(location: value.utf16.distance(from: value.utf16.startIndex, to: start16),
                        length: value.utf16.distance(from: start16, to: end16))
    AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    guard let axRange = withUnsafePointer(to: &range, { AXValueCreate(.cfRange, $0) }) else {
        fail("bad_range", "AXValueCreate failed")
    }
    let status = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, axRange)
    var check = CFRange(location: -1, length: -1)
    if let readBack = attribute(element, kAXSelectedTextRangeAttribute),
       CFGetTypeID(readBack) == AXValueGetTypeID() {
        AXValueGetValue(readBack as! AXValue, .cfRange, &check)
    }
    emit(["ok": status == .success, "action": "selecttext", "ref": ref,
          "selection": kind, "text": needle,
          "range": ["location": check.location, "length": check.length]])

case "clicktext", "click-text":
    // One walk, one press: the caller names a control, so there is no reason to
    // pay for a separate snapshot process and a second resolve walk.
    if pauseActive(), !args.flag("force") {
        emit(["ok": false, "error": "paused_by_user",
              "message": "the user stopped computer use from the controller; call resume first"])
        exit(1)
    }
    guard let query = args["text"], !query.isEmpty else { fail("missing_text", "pass --text \"…\"") }
    guard let windowId = args.int("window") else { fail("missing_window", "pass --window <id>") }
    guard requireAccessibility() else {
        fail("accessibility_denied", "grant Accessibility to this binary", ["window": windowId])
    }
    guard let window = onScreenWindows().first(where: { $0.id == CGWindowID(windowId) }) else {
        fail("window_gone", "window \(windowId) is not on screen")
    }
    let pid = args.int("pid").map { pid_t($0) } ?? window.pid
    if !args.flag("force"), !args.flag("no-preflight") {
        if let refusal = preflight(action: "clicktext", point: nil, pid: pid, requireFocus: false,
                                   secureAllowed: false, ignoreSheet: args.flag("ignore-sheet")) {
            emit(refusal)
            exit(1)
        }
    }
    let started = Date()
    let nodes = snapshotNodes(pid: pid, windowId: CGWindowID(windowId)).nodes
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let exactOnly = args.flag("exact")
    func rank(_ node: SnapNode) -> Int? {
        if node.secure { return nil }
        let title = node.title.lowercased()
        let value = node.value.lowercased()
        let pressable = node.actions.contains("AXPress")
        let exact = title == needle || value == needle
        guard exact || (!exactOnly && (title.contains(needle) || value.contains(needle))) else {
            return nil
        }
        // Controls before labels: a static-text caption is often an exact match
        // that sits next to, not on, the thing the caller wants to press.
        return (pressable ? 0 : 2) + (exact ? 0 : 1)
    }
    var matches: [(rank: Int, offset: Int, node: SnapNode)] = []
    for (offset, node) in nodes.enumerated() {
        if let score = rank(node) { matches.append((score, offset, node)) }
    }
    matches.sort { $0.rank == $1.rank ? $0.offset < $1.offset : $0.rank < $1.rank }
    guard !matches.isEmpty else {
        let visible = nodes.filter { !$0.title.isEmpty }.prefix(20).map { $0.title }
        fail("text_not_found", "no element matched \(query)",
             ["visible": Array(visible), "nodes": nodes.count,
              "ms": Int(Date().timeIntervalSince(started) * 1000)])
    }
    let pickIndex = max(0, args.int("index") ?? 0)
    guard pickIndex < matches.count else {
        fail("index_out_of_range", "only \(matches.count) match(es)", ["matches": matches.count])
    }
    let pick = matches[pickIndex].node
    let elapsed = { Int(Date().timeIntervalSince(started) * 1000) }
    if pick.actions.contains("AXPress") {
        if !pick.enabled, !args.flag("force") {
            fail("control_disabled", "\(pick.ref) is disabled — its AXPress would be a no-op",
                 ["ref": pick.ref, "role": pick.role, "title": pick.title])
        }
        let status = AXUIElementPerformAction(pick.element, kAXPressAction as CFString)
        if status == .success {
            markAction()
            emit(["ok": true, "action": "clicktext", "via": "AXPress-background",
                  "ref": pick.ref, "role": pick.role, "title": pick.title,
                  "matches": matches.count, "ms": elapsed(),
                  "frontmostAfter": frontmost().app])
            exit(0)
        }
    }
    guard let frame = pick.frame else {
        fail("no_frame", "\(pick.ref) has no frame and no AXPress", ["ref": pick.ref, "role": pick.role])
    }
    if frameLooksStale(pick, pid: pid) {
        fail("ref_outside_window", "the element frame is outside every window of that app",
             ["ref": pick.ref, "role": pick.role])
    }
    clickToPid(pid, x: frame.midX, y: frame.midY,
               button: args["button"] ?? "left", count: args.int("count") ?? 1)
    markAction()
    emit(["ok": true, "action": "clicktext", "via": "pid-events", "pid": Int(pid),
          "ref": pick.ref, "role": pick.role, "title": pick.title,
          "matches": matches.count, "x": frame.midX, "y": frame.midY, "ms": elapsed(),
          "frontmostAfter": frontmost().app])

case "findtext", "find-text":
    // Text lookup straight from the accessibility tree: no screenshot, no OCR.
    // Covers native controls and document text; callers fall back to OCR when
    // the tree has nothing to match (canvas apps, Chromium web contents).
    guard let windowId = args.int("window") else { fail("missing_window", "pass --window <id>") }
    guard let query = args["text"], !query.isEmpty else { fail("missing_text", "pass --text \"…\"") }
    guard requireAccessibility() else {
        fail("accessibility_denied", "grant Accessibility to this binary", ["window": windowId])
    }
    guard let window = onScreenWindows().first(where: { $0.id == CGWindowID(windowId) }) else {
        fail("window_gone", "window \(windowId) is not on screen")
    }
    let pid = args.int("pid").map { pid_t($0) } ?? window.pid
    let started = Date()
    let nodes = snapshotNodes(pid: pid, windowId: CGWindowID(windowId)).nodes
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let limit = max(1, args.int("limit") ?? 20)
    var hits: [(score: Int, node: SnapNode, text: String)] = []
    for node in nodes {
        if node.secure { continue }
        let title = node.title
        let value = node.value
        let exact = title.lowercased() == needle || value.lowercased() == needle
        let contains = title.lowercased().contains(needle) || value.lowercased().contains(needle)
        guard exact || contains else { continue }
        let text = title.isEmpty ? value : title
        hits.append((exact ? 0 : 1, node, String(text.prefix(200))))
    }
    hits.sort { $0.score == $1.score ? $0.node.index < $1.node.index : $0.score < $1.score }
    let matches: [[String: Any]] = hits.prefix(limit).map { hit in
        let node = hit.node
        var entry: [String: Any] = ["ref": node.ref, "role": node.role, "text": hit.text,
                                    "pressable": node.actions.contains("AXPress"),
                                    "actions": node.actions]
        if let frame = node.frame {
            entry["x"] = frame.origin.x
            entry["y"] = frame.origin.y
            entry["w"] = frame.size.width
            entry["h"] = frame.size.height
        }
        return entry
    }
    emit(["ok": true, "action": "findtext", "pid": Int(pid), "query": query,
          "count": matches.count, "matches": matches, "nodes": nodes.count,
          "ms": Int(Date().timeIntervalSince(started) * 1000)])

case "readtext", "read-text":
    // Whole-window text from the accessibility tree; callers fall back to OCR
    // when the app renders its content itself (canvas, some web views).
    guard let windowId = args.int("window") else { fail("missing_window", "pass --window <id>") }
    guard let window = onScreenWindows().first(where: { $0.id == CGWindowID(windowId) }) else {
        fail("window_gone", "window \(windowId) is not on screen")
    }
    let pid = args.int("pid").map { pid_t($0) } ?? window.pid
    let started = Date()
    let nodes = snapshotNodes(pid: pid, windowId: CGWindowID(windowId)).nodes
    let limit = max(1, args.int("limit") ?? 200)
    var lines: [[String: Any]] = []
    for node in nodes {
        if node.secure { continue }
        let text = node.title.isEmpty ? node.value : node.title
        guard !text.isEmpty else { continue }
        var row: [String: Any] = ["text": String(text.prefix(2000)), "role": node.role,
                                  "ref": node.ref]
        if let frame = node.frame {
            row["cx"] = frame.midX
            row["cy"] = frame.midY
        }
        lines.append(row)
        if lines.count >= limit { break }
    }
    emit(["ok": true, "action": "readtext", "pid": Int(pid), "count": lines.count,
          "lines": lines, "nodes": nodes.count,
          "ms": Int(Date().timeIntervalSince(started) * 1000)])

case "click":
    if pauseActive(), !args.flag("force") {
        emit(["ok": false, "error": "paused_by_user",
              "message": "the user stopped computer use from the controller; call resume first"])
        exit(1)
    }
    // Two ways in: a coordinate, or an element ref from `snapshot`. An element
    // ref is preferred — it survives layout shifts and can use the control's own
    // AXPress instead of synthesising a mouse event at a guessed point.
    var x = 0.0
    var y = 0.0
    var refNode: SnapNode?
    var refPid: pid_t = 0
    if let ref = args["ref"] {
        guard let pid = args.int("pid") else { fail("missing_pid", "--ref needs --pid") }
        refPid = pid_t(pid)
        let scope = args.int("window").map(CGWindowID.init)
        let node = resolveNode(pid: refPid, ref: ref, role: args["role"], title: args["title"],
                               windowId: scope)
        refNode = node
        if let frame = node.frame {
            x = frame.midX
            y = frame.midY
        } else if !node.actions.contains("AXPress") {
            fail("no_frame", "\(ref) has no frame and no AXPress; nothing to click",
                 ["ref": ref, "role": node.role])
        }
    } else {
        x = args.number("x") { fail("missing_x", $0) }
        y = args.number("y") { fail("missing_y", $0) }
    }
    let point = CGPoint(x: x, y: y)
    let background = args.flag("background")
    var activated: Bool?
    var frontBefore = frontmost().app
    // --pid names the app the caller means, for a coordinate click too. Without
    // it, a foreground click means whatever window is under the point — the
    // same rule a person follows when they click at a spot on screen. (It used
    // to ignore --pid entirely here and fall through to the window under the
    // point, which is how a click meant for 剪映 landed in Chrome.)
    var targetPid: pid_t? = resolveTargetPair(pid: refPid != 0 ? Int(refPid) : args.int("pid"),
                                             window: args.int("window"), action: "click").pid
    if targetPid == nil, !background {
        targetPid = windowAt(point)?.pid
    }
    if !background, let pid = targetPid, pid != 0 {
        // macOS delivers the first click of an inactive app to the window frame,
        // not to the control underneath, so bring the app forward and confirm it
        // actually holds focus before clicking. Clicking blind is how a "click
        // returned ok" turns into "nothing happened" — or into a click in a
        // different app that stole focus in between.
        frontBefore = frontmost().app
        _ = activate(pid: pid)
        let deadline = Date().addingTimeInterval(1.2)
        while Date() < deadline && frontmostPID() != pid {
            usleep(50_000)
        }
        activated = frontmostPID() == pid
        if activated == false && !args.flag("force") {
            fail("not_frontmost", "the target app did not come to the front; not clicking",
                 ["frontmost": frontmost().app, "pid": Int(pid),
                  "hint": "retry, or pass --force to click anyway"])
        }
    }
    // An AXPress does not need a trustworthy frame, so the hit test only applies
    // to the coordinate path.
    let willPress = refNode?.actions.contains("AXPress") == true && !args.flag("coords") && !background
    var guardPid = targetPid
    if !args.flag("force"), !args.flag("no-preflight") {
        if guardPid == nil, !background, !willPress { guardPid = windowAt(point)?.pid }
        if let refusal = preflight(action: "click", point: (background || willPress) ? nil : point,
                                   pid: guardPid,
                                   requireFocus: !background && !willPress && guardPid != nil,
                                   secureAllowed: false,
                                   ignoreSheet: args.flag("ignore-sheet")) {
            emit(refusal)
            exit(1)
        }
    }
    if let tp = targetPid, tp != 0 {
        emitActionEventLine("targetReady", kind: "click",
                            target: actionTargetDict(pid: tp, windowId: args.int("window")), point: point)
    }
    if background {
        // No pid given: target whatever window is under the point, without
        // activating it or moving the system cursor.
        var resolvedPid = guardPid ?? targetPid
        if (resolvedPid ?? 0) == 0 {
            resolvedPid = windowAt(point)?.pid
        }
        guard let pid = resolvedPid, pid != 0 else {
            fail("missing_pid", "background clicks need --pid, --window, --ref or a point over a window")
        }
        // Dry-run must answer before anything is posted — including on this branch,
        // which used to ignore the flag and send a real click.
        if args.flag("dry-run") {
            emit(["ok": true, "action": "click", "dryRun": true, "x": x, "y": y,
                  "wouldClick": true, "via": "pid-events", "pid": Int(pid),
                  "ref": args["ref"] ?? "", "resolved": lastResolve])
            exit(0)
        }
        // A control's own action works on an inactive app and on an off-stage
        // window, and it never brings anything to the front.
        if let node = refNode, node.actions.contains("AXPress") {
            if !node.enabled, !args.flag("force") {
                // A disabled control's AXPress silently does nothing; reporting ok
                // here is how a click "succeeds" without any visible effect.
                fail("control_disabled",
                     "\(args["ref"] ?? "") is disabled — its AXPress would be a no-op",
                     ["ref": args["ref"] ?? "", "role": node.role,
                      "hint": "enable the control first, or pass force: true"])
            }
            let status = AXUIElementPerformAction(node.element, kAXPressAction as CFString)
            if status == .success {
                markAction()
                emitActionEventLine("dispatched", kind: "click",
                                    target: actionTargetDict(pid: pid, windowId: args.int("window")), point: point)
                emit(["ok": true, "action": "click", "via": "AXPress-background",
                      "ref": args["ref"] ?? "", "x": x, "y": y, "frontmostAfter": frontmost().app])
                exit(0)
            }
        }
        if let node = refNode, frameLooksStale(node, pid: pid) {
            fail("ref_outside_window",
                 "the element frame is outside every window of that app; the tree is stale",
                 ["ref": args["ref"] ?? "", "x": x, "y": y, "pid": Int(pid),
                  "hint": "take a new snapshot, or use the element's AXPress"])
        }
        // Coordinates are the one thing pid events cannot do off-stage: the window
        // is not composited, so the click lands nowhere. Refuse instead of
        // reporting a click that never happened.
        if let under = windowAt(point), offStageIds(onScreenWindows()).contains(under.id) {
            fail("off_stage_window",
                 "that window is a Stage Manager thumbnail; bring it on stage first",
                 ["pid": Int(pid), "windowId": Int(under.id),
                  "hint": "cu stage --window <id>, or click a control that exposes AXPress"])
        }
        clickToPid(pid, x: x, y: y, button: args["button"] ?? "left", count: args.int("count") ?? 1)
        markAction()
        emitActionEventLine("dispatched", kind: "click",
                            target: actionTargetDict(pid: pid, windowId: args.int("window")), point: point)
        emit(["ok": true, "action": "click", "via": "pid-events", "pid": Int(pid),
              "x": x, "y": y, "resolved": lastResolve, "frontmostAfter": frontmost().app])
        exit(0)
    }
    let settle = args.int("settle") ?? 90
    if settle > 0 { usleep(useconds_t(settle) * 1000) }
    if !args.flag("force"), let guardPid, frontmostPID() != guardPid {
        // Focus can move during the settle wait; the whole point of the preflight
        // is to catch it right before the event is posted.
        emit(["ok": false, "error": "focused_window_mismatch",
              "message": "focus moved to another app just before the click",
              "frontmost": frontmost().app, "pid": Int(guardPid)])
        exit(1)
    }
    if args.flag("phantom") { showPhantomCursor(at: point); pump(0.12) }
    markAction()

    if args.flag("dry-run") {
        emit(["ok": true, "action": "click", "dryRun": true, "x": x, "y": y,
              "wouldClick": true, "ref": args["ref"] ?? "", "resolved": lastResolve])
        exit(0)
    }
    var via = "coordinates"
    if let node = refNode, node.actions.contains("AXPress"), !args.flag("coords") {
        if !node.enabled, !args.flag("force") {
            fail("control_disabled", "\(args["ref"] ?? "") is disabled — its AXPress would be a no-op",
                 ["ref": args["ref"] ?? "", "role": node.role])
        }
        let status = AXUIElementPerformAction(node.element, kAXPressAction as CFString)
        if status == .success {
            via = "AXPress"
        } else {
            via = "AXPress-failed(\(status.rawValue))-fell-back-to-coordinates"
            click(x: x, y: y, button: args["button"] ?? "left", count: args.int("count") ?? 1)
        }
    } else {
        if let node = refNode, let pid = guardPid ?? targetPid, frameLooksStale(node, pid: pid) {
            fail("ref_outside_window",
                 "the element frame is outside every window of that app; the tree is stale",
                 ["ref": args["ref"] ?? "", "x": x, "y": y, "pid": Int(pid),
                  "hint": "take a new snapshot, or use the element's AXPress"])
        }
        click(x: x, y: y, button: args["button"] ?? "left", count: args.int("count") ?? 1)
    }
    if let tp = targetPid, tp != 0 {
        emitActionEventLine("dispatched", kind: "click",
                            target: actionTargetDict(pid: tp, windowId: args.int("window")), point: point)
    }
    var payload: [String: Any] = [
        "ok": true, "action": "click", "x": x, "y": y, "via": via,
        "button": args["button"] ?? "left", "count": args.int("count") ?? 1,
        "frontmostBefore": frontBefore, "frontmostAfter": frontmost().app,
    ]
    if let ref = args["ref"] { payload["ref"] = ref }
    if let activated { payload["activated"] = activated }
    emit(payload)

case "move":
    let x = args.number("x") { fail("missing_x", $0) }
    let y = args.number("y") { fail("missing_y", $0) }
    CGEvent(mouseEventSource: eventSource, mouseType: .mouseMoved,
            mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)?
        .post(tap: .cghidEventTap)
    emit(["ok": true, "action": "move", "x": x, "y": y])

case "drag":
    guard let from = args["from"], let to = args["to"] else {
        fail("missing_points", "pass --from x,y --to x,y")
    }
    let fromParts = from.split(separator: ",").compactMap { Double($0) }
    let toParts = to.split(separator: ",").compactMap { Double($0) }
    guard fromParts.count == 2, toParts.count == 2 else {
        fail("bad_points", "points look like 100,200")
    }
    let dragFrom = CGPoint(x: fromParts[0], y: fromParts[1])
    let dragTo = CGPoint(x: toParts[0], y: toParts[1])
    if args.flag("background") {
        // pid-targeted events: the window moves without coming forward and
        // without warping the system cursor.
        let pid = backgroundTarget(args, "drag")
        dragToPid(pid, from: dragFrom, to: dragTo, button: args["button"] ?? "left")
        markAction()
        emit(["ok": true, "action": "drag", "from": from, "to": to,
              "via": "pid-events", "pid": Int(pid), "frontmostAfter": frontmost().app])
        exit(0)
    }
    if let windowId = args.int("window") {
        guard let window = onScreenWindows().first(where: { $0.id == CGWindowID(windowId) }) else {
            fail("window_gone", "window \(windowId) is not on screen")
        }
        _ = activate(pid: window.pid)
        pump(0.2)
        if !args.flag("force"), let refusal = preflight(action: "drag", point: nil, pid: window.pid,
                                                        requireFocus: false, secureAllowed: false,
                                                        ignoreSheet: false) {
            refuse(refusal)
        }
    }
    drag(from: dragFrom, to: dragTo)
    emit(["ok": true, "action": "drag", "from": from, "to": to])

case "scroll":
    let dy = args.double("dy") ?? 0
    let dx = args.double("dx") ?? 0
    if dy == 0 && dx == 0 { fail("missing_delta", "pass --dy <n> (negative scrolls down)") }
    var point: CGPoint?
    if let x = args.double("x"), let y = args.double("y") { point = CGPoint(x: x, y: y) }
    if args.flag("background") {
        let pid = backgroundTarget(args, "scroll")
        scrollToPid(pid, dx: dx, dy: dy)
        markAction()
        emit(["ok": true, "action": "scroll", "dx": dx, "dy": dy, "via": "pid-events", "pid": Int(pid)])
        exit(0)
    }
    guardedFocus(args, action: "scroll", point: point)
    scroll(dx: dx, dy: dy, at: point)
    markAction()
    emit(["ok": true, "action": "scroll", "dx": dx, "dy": dy])

case "type":
    guard let text = args["text"] else { fail("missing_text", "pass --text \"…\"") }
    if args.flag("background") {
        let tryOffStage = args.flag("try-offstage")
        let pid = backgroundTarget(args, "type", allowOffStage: tryOffStage)
        // Same reasoning as `paste`: a background app reports no focused element,
        // so let the caller name the control from the snapshot.
        var target: AXUIElement?
        if let ref = args["ref"] {
            target = resolveNode(pid: pid, ref: ref, role: args["role"], title: args["title"]).element
        } else {
            target = focusedElement(pid: pid)
        }
        if let element = target {
            _ = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            pump(0.04)
        }
        func read() -> String? {
            if let element = target { return stringAttribute(element, kAXValueAttribute) }
            return focusedValue(pid: pid)
        }
        let before = read()
        typeToPid(pid, text)
        pump(0.08)
        var landed: Bool? = before == nil ? nil : read() != before
        var via = "pid-events"
        if landed == false, let element = target {
            let base = before ?? ""
            let status = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString,
                                                      (base + text) as CFTypeRef)
            if status == .success {
                pump(0.05)
                landed = read() != before
                via = "ax-setvalue"
            }
        }
        markAction()
        var payload: [String: Any] = ["ok": landed ?? true, "action": "type",
                                      "characters": text.count, "via": via, "pid": Int(pid)]
        if tryOffStage, landed == false {
            payload["error"] = "off_stage_window"
            payload["message"] = "pid events did not reach the off-stage window's field"
            emit(payload)
            exit(1)
        }
        if let landed { payload["landed"] = landed }
        if landed == false {
            payload["error"] = "type_not_landed"
            payload["message"] = "background typing did not reach the app's focused field"
            emit(payload)
            exit(1)
        }
        emit(payload)
        exit(0)
    }
    let pid = guardedFocus(args, action: "type")
    let before = pid.flatMap { focusedValue(pid: $0) }
    // Paste first: measured on macOS 26 the unicode key-event path is dropped by
    // both TextEdit and Chromium, so it costs a round trip and usually falls back
    // anyway. Clipboard insertion is what the shipped engine prefers too.
    pasteText(text)
    var via = "paste"
    var landed: Bool?
    if let pid, let before {
        pump(0.06)
        landed = focusedValue(pid: pid) != before
        if landed == false {
            typeText(text)
            via = "unicode-fallback"
            pump(0.10)
            landed = focusedValue(pid: pid) != before
        }
    }
    var payload: [String: Any] = ["ok": landed ?? true, "action": "type",
                                  "characters": text.count, "via": via]
    if let landed { payload["landed"] = landed }
    if landed == false {
        payload["error"] = "type_not_landed"
        payload["message"] = "neither unicode nor paste changed the focused field"
        emit(payload)
        exit(1)
    }
    markAction()
    emit(payload)

case "key":
    guard let name = args["name"] else { fail("missing_key", "pass --name enter") }
    if args.flag("background") {
        let tryOffStage = args.flag("try-offstage")
        let pid = backgroundTarget(args, "key", allowOffStage: tryOffStage)
        let before = tryOffStage ? inputFingerprint(pid: pid) : ""
        pressToPid(pid, name: name, modifiers: flags(args["mods"] ?? ""))
        markAction()
        var payload: [String: Any] = ["ok": true, "action": "key", "name": name,
                                      "mods": args["mods"] ?? "", "via": "pid-events",
                                      "pid": Int(pid)]
        if tryOffStage {
            // Off-stage key events are not composited; prove delivery through the
            // app's own focused state instead of trusting the post.
            pump(0.12)
            let after = inputFingerprint(pid: pid)
            payload["verified"] = before != after
            if before == after {
                payload["ok"] = false
                payload["error"] = "off_stage_window"
                payload["message"] = "nothing observable changed after the key post"
                emit(payload)
                exit(1)
            }
        }
        emit(payload)
        exit(0)
    }
    guardedFocus(args, action: "key")
    press(name: name, modifiers: flags(args["mods"] ?? ""))
    markAction()
    emit(["ok": true, "action": "key", "name": name, "mods": args["mods"] ?? ""])

case "menu":
    guard let pid = args.int("pid") else { fail("missing_pid", "pass --pid <pid>") }
    if !requireAccessibility() {
        fail("accessibility_denied", "grant Accessibility to this binary", ["pid": pid])
    }
    if let path = args["path"] {
        let steps = path.split(separator: "/").map(String.init)
        let result = pressMenuItem(pid: pid_t(pid), path: steps, confirm: args.flag("confirm"))
        emit(result)
        if result["ok"] as? Bool == false { exit(1) }
    } else {
        emit(["ok": true, "pid": pid, "menus": menuTreeJSON(pid_t(pid))])
    }

case "stage":
    guard let windowId = args.int("window") else { fail("missing_window", "pass --window <id>") }
    let targetId = CGWindowID(windowId)
    guard let window = onScreenWindows().first(where: { $0.id == targetId }) else {
        fail("window_gone", "window \(windowId) is not listed")
    }
    if !args.flag("no-stage-switch") {
        _ = activate(pid: window.pid)
    }
    let visible = bringOnStage(pid: window.pid, target: targetId)
    emit(["ok": visible, "action": "stage", "windowId": windowId,
          "onScreen": visible, "frontmost": frontmost().app])

case "ocr":
    let screen = args.flag("screen")
    let id = args.int("window")
    if !screen && id == nil { fail("missing_target", "pass --window <id> or --screen") }
    if let id, offStageIds(onScreenWindows()).contains(CGWindowID(id)) {
        fail("off_stage_window", "that window is a Stage Manager thumbnail; bring it on stage first")
    }
    do {
        let shot = try captureForOCR(windowId: id.map(CGWindowID.init), screen: screen,
                                     maxDimension: args.int("max-dim") ?? 1600)
        var lines: [OCRLine] = []
        let iterations = max(1, args.int("repeat") ?? 1)
        var timings: [Double] = []
        for _ in 0..<iterations {
            let started = Date()
            let level: VNRequestTextRecognitionLevel = args["level"] == "fast" ? .fast : .accurate
            let languages = args["langs"]?.split(separator: ",").map(String.init) ?? ["zh-Hans", "en-US"]
            lines = recognizeText(in: shot.png, origin: shot.origin, size: shot.size,
                                  level: level, languages: languages,
                                  correction: !args.flag("no-correct"))
            timings.append((Date().timeIntervalSince(started) * 1000 * 10).rounded() / 10)
        }
        let elapsed = timings.last ?? 0
        let needle = args["find"]?.lowercased()
        var payload: [String: Any] = [
            "ok": true,
            "count": lines.count,
            "ms": elapsed,
            "msRuns": timings,
            "origin": ["x": shot.origin.x, "y": shot.origin.y],
            "size": ["width": shot.size.width, "height": shot.size.height],
        ]
        if let id { payload["windowId"] = id }
        if screen { payload["screen"] = true }
        let rows = lines.map { line -> [String: Any] in
            ["text": line.text,
             "x": line.rect.origin.x, "y": line.rect.origin.y,
             "w": line.rect.width, "h": line.rect.height,
             "cx": line.rect.midX, "cy": line.rect.midY,
             "confidence": (Double(line.confidence) * 100).rounded() / 100]
        }
        if let needle {
            let matches = rows.filter { (($0["text"] as? String) ?? "").lowercased().contains(needle) }
            payload["matches"] = matches
            payload["query"] = needle
        } else {
            payload["lines"] = rows
        }
        emit(payload)
    } catch {
        fail("ocr_failed", error.localizedDescription,
             ["hint": "Screen Recording is required for OCR"])
    }

case "cursor":
    emit(cursorPayload())

case "cursor-overlay":
    runCursorOverlay()

case "capture-daemon":
    runCaptureDaemon()

case "screen-indicator":
    runScreenIndicator()

case "release":
    releaseMouse()
    let point = cursorPosition()
    emit(["ok": true, "action": "release", "x": point.x, "y": point.y])

case "zoom":
    guard let windowId = args.int("window") else { fail("missing_window", "pass --window <id>") }
    emit(zoomWindow(CGWindowID(windowId)))

case "movewindow", "move-window":
    guard let windowId = args.int("window") else { fail("missing_window", "pass --window <id>") }
    let x = args.double("x")
    let y = args.double("y")
    if (x == nil) != (y == nil) { fail("missing_point", "pass both --x and --y (or neither)") }
    if x == nil && args.double("w") == nil && args.double("h") == nil {
        fail("missing_target", "pass --x/--y and/or --w/--h")
    }
    let result = moveWindow(CGWindowID(windowId), x: x, y: y,
                            width: args.double("w"), height: args.double("h"))
    if result["ok"] as? Bool == true { markAction() }
    emit(result)

case "preview-probe":
    runPreviewProbe(windowId: args.int("window").map(CGWindowID.init), seconds: args.int("seconds") ?? 5)

case "demo":
    // A window that belongs to us: used to verify window dragging and zooming
    // without touching anything the user is working in.
    let app = NSApplication.shared
    // Accessory, never regular: the demo window must appear without taking the
    // user's focus, otherwise testing would itself break the background promise.
    app.setActivationPolicy(.accessory)
    let rect = NSRect(x: 420, y: 380, width: 520, height: 470)
    let window = NSWindow(contentRect: rect,
                          styleMask: [.titled, .closable, .resizable, .miniaturizable],
                          backing: .buffered, defer: false)
    window.title = "cu demo window"
    window.isReleasedWhenClosed = false

    // A tiny self-contained testbed: an editable field, a counter button and a
    // scrollable text view, so set_value / select_text / click / scroll can be
    // exercised without touching any other application.
    let field = NSTextField(frame: NSRect(x: 20, y: 360, width: 480, height: 24))
    field.placeholderString = "demo-field"
    field.stringValue = ""
    window.contentView?.addSubview(field)

    let button = NSButton(frame: NSRect(x: 20, y: 320, width: 200, height: 28))
    button.title = "Demo Button 0"
    button.bezelStyle = .rounded
    var clicks = 0
    let handler = ClickCounter {
        clicks += 1
        button.title = "Demo Button \(clicks)"
    }
    button.target = handler
    button.action = #selector(ClickCounter.fire)
    window.contentView?.addSubview(button)
    objc_setAssociatedObject(button, "cu.demo.handler", handler, .OBJC_ASSOCIATION_RETAIN)

    // A sheet button: lets the safety layer's "a modal is open" refusal be tested
    // without involving any other application.
    let sheetButton = NSButton(frame: NSRect(x: 240, y: 320, width: 140, height: 28))
    sheetButton.title = "Demo Sheet"
    sheetButton.bezelStyle = .rounded
    let sheetHandler = ClickCounter {
        let alert = NSAlert()
        alert.messageText = "demo sheet"
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window, completionHandler: nil)
    }
    sheetButton.target = sheetHandler
    sheetButton.action = #selector(ClickCounter.fire)
    window.contentView?.addSubview(sheetButton)
    objc_setAssociatedObject(sheetButton, "cu.demo.handler", sheetHandler, .OBJC_ASSOCIATION_RETAIN)

    let secret = NSSecureTextField(frame: NSRect(x: 400, y: 360, width: 100, height: 24))
    secret.placeholderString = "demo-secret"
    window.contentView?.addSubview(secret)

    let scroll = NSScrollView(frame: NSRect(x: 20, y: 20, width: 480, height: 280))
    scroll.hasVerticalScroller = true
    let textView = NSTextView(frame: scroll.bounds)
    textView.string = (0..<120).map { "demo line \($0)" }.joined(separator: "\n")
    scroll.documentView = textView
    window.contentView?.addSubview(scroll)

    // Chromium/Electron bury controls ~20 levels down; this chain gives the tree
    // a deep branch so `ax --find` can prove it searches as deep as snapshot.
    final class DeepGroup: NSView {
        override func isAccessibilityElement() -> Bool { true }
        override func accessibilityRole() -> NSAccessibility.Role? { .group }
    }
    var host: NSView = window.contentView!
    var chainTop: NSView?
    for _ in 1...16 {
        let child = DeepGroup(frame: NSRect(x: 0, y: 0, width: 480, height: 40))
        host.addSubview(child)
        if chainTop == nil { chainTop = child }
        host = child
    }
    let deepButton = NSButton(frame: NSRect(x: 4, y: 8, width: 180, height: 24))
    deepButton.title = "深层按钮 甲"
    deepButton.bezelStyle = .rounded
    host.addSubview(deepButton)
    chainTop?.setFrameOrigin(NSPoint(x: 20, y: 400))
    // orderFrontRegardless, not makeKeyAndOrderFront: showing a key window would
    // activate this process and pull focus away from whatever the user is doing.
    let priorFront = NSWorkspace.shared.frontmostApplication
    window.orderFrontRegardless()
    func restoreFocus() {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid(),
              let prior = priorFront, prior.processIdentifier != getpid() else { return }
        // An unbundled AppKit process can still come forward just by showing a
        // window; hand the focus straight back to whoever had it.
        _ = activate(pid: prior.processIdentifier)
        window.orderFrontRegardless()
    }
    restoreFocus()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { restoreFocus() }
    emit(["ok": true, "demo": "shown"])
    let seconds = args.double("seconds") ?? 20
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
        emit(["ok": true, "demo": "timeout"])
        exit(0)
    }
    app.run()
    exit(0)

case "phantom":
    let x = args.number("x") { fail("missing_x", $0) }
    let y = args.number("y") { fail("missing_y", $0) }
    showPhantomCursor(at: CGPoint(x: x, y: y), seconds: args.double("seconds") ?? 0.6)
    pump(args.double("seconds") ?? 0.6)
    emit(["ok": true, "action": "phantom", "x": x, "y": y])

case "allow":
    guard let spec = args["app"] else { fail("missing_app", "pass --app <bundle id | name>") }
    var apps = allowlist()
    if args.flag("remove") {
        apps.removeAll { $0.caseInsensitiveCompare(spec) == .orderedSame }
    } else if !apps.contains(where: { $0.caseInsensitiveCompare(spec) == .orderedSame }) {
        apps.append(spec)
    }
    try? FileManager.default.createDirectory(atPath: NSString(string: "~/.cu").expandingTildeInPath,
                                            withIntermediateDirectories: true)
    let payload = try? JSONSerialization.data(withJSONObject: ["apps": apps], options: [.prettyPrinted, .sortedKeys])
    try? payload?.write(to: URL(fileURLWithPath: allowlistPath))
    emit(["ok": true, "action": "allow", "apps": apps, "path": allowlistPath])

case "allowed":
    emit(["ok": true, "apps": allowlist(), "path": allowlistPath])

case "clients":
    emit(clientsReport())

case "cover":
    guard let windowId = args.int("window") else { fail("missing_window", "pass --window <id>") }
    runCover(windowId: CGWindowID(windowId), seconds: args.double("seconds") ?? 0,
             label: args["label"] ?? "")

case "space":
    guard let windowId = args.int("window") else { fail("missing_window", "pass --window <id>") }
    guard let window = onScreenWindows().first(where: { $0.id == CGWindowID(windowId) }) else {
        fail("window_gone", "window \(windowId) is on another Space or minimised; open it first")
    }
    _ = activate(pid: window.pid)
    if let windows = attribute(AXUIElementCreateApplication(window.pid), kAXWindowsAttribute) as? [AXUIElement] {
        for windowElement in windows {
            if let candidate = frame(of: windowElement),
               abs(candidate.origin.x - window.bounds.origin.x) < 2,
               abs(candidate.origin.y - window.bounds.origin.y) < 2 {
                _ = AXUIElementPerformAction(windowElement, kAXRaiseAction as CFString)
                break
            }
        }
    }
    pump(0.25)
    emit(["ok": true, "action": "space", "windowId": windowId,
          "onScreen": onScreenWindows().contains(where: { $0.id == CGWindowID(windowId) }),
          "frontmost": frontmost().app])

case "pause":
    markPause()
    emit(["ok": true, "action": "pause"])

case "resume":
    clearPause()
    emit(["ok": true, "action": "resume"])

case "agents":
    emit(["ok": true, "agents": agentsCatalog()])

case "agents-connect":
    let ids = args["id"]?.split(separator: ",").map(String.init)
    emit(["ok": true, "results": agentsConnect(ids: ids)])

case "agents-disconnect":
    let ids = args["id"]?.split(separator: ",").map(String.init)
    emit(["ok": true, "results": agentsDisconnect(ids: ids)])

case "service":
    let config = loadServiceConfig(portOverride: args.int("port"), tokenOverride: args["token"])
    // The service runs the engine hardlink outside the .app bundle; macOS 27
    // attributes TCC per process, so the app's grants do not cover it. Raise the
    // consent dialogs under the service's own identity until it is granted.
    DispatchQueue.global().asyncAfter(deadline: .now() + 2) { requestPermissionsIfMissing() }
    serve(config)

case "app":
    // Snapshot/selftest runs are one-shot helpers launched from the same bundle;
    // they must not retire the running menu-bar instance.
    let oneShot = args.flag("selftest-ui") || args["snapshot-console"] != nil
        || args["snapshot-guide"] != nil
    if !oneShot {
        // Launched from the .app bundle: keep a single menu-bar instance. A second
        // launch does NOT exit immediately — LaunchServices would report "not open
        // anymore" for the process it just started. Instead it asks the running copy
        // to retire (clean exit, so the LaunchAgent stays dead) and takes over.
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: "local.cu.app")
            .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
        var previous: pid_t? = others.first?.processIdentifier
        // The login agent may run a copy without a bundle id; the pid file catches it.
        if previous == nil,
           let text = try? String(contentsOfFile: NSString(string: "~/.cu/menubar.pid").expandingTildeInPath,
                                  encoding: .utf8),
           let pid = pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)),
           pid > 0, pid != getpid(), kill(pid, 0) == 0 {
            previous = pid
        }
        if let old = previous {
            DistributedNotificationCenter.default().postNotificationName(
                NSNotification.Name("local.cu.handover"), object: nil, userInfo: nil,
                deliverImmediately: true)
            for _ in 0..<30 {
                if kill(old, 0) != 0 { break }
                usleep(100_000)
            }
        }
        if httpGetJSON(port: loadServiceConfig(portOverride: nil, tokenOverride: nil).port,
                       path: "/v1/status", timeout: 0.6) == nil {
            restartService()
            usleep(900_000)
        }
    }
    runMenuBar(openSettings: args.flag("open-settings"), openMenu: args.flag("open-menu"),
               openConsole: !args.flag("quiet"),
               snapshotConsole: args["snapshot-console"],
               snapshotPage: args["snapshot-page"],
               snapshotGuide: args["snapshot-guide"],
               selftest: args.flag("selftest-ui"))

case "menubar":
    runMenuBar(openSettings: args.flag("open-settings"), openMenu: args.flag("open-menu"),
               openConsole: !args.flag("quiet"),
               snapshotConsole: args["snapshot-console"],
               snapshotPage: args["snapshot-page"],
               snapshotGuide: args["snapshot-guide"],
               selftest: args.flag("selftest-ui"))

case "selfcheck":
    let front = frontmost()
    var report: [String: Any] = [
        "ok": true,
        "accessibility": AXIsProcessTrusted(),
        "screenRecording": CGPreflightScreenCaptureAccess(),
        "secureInput": secureInputPID() != nil,
        "paused": pauseActive(),
        "occluder": fullScreenOverlayExists(),
        "frontmost": ["pid": Int(front.pid), "app": front.app],
        "userIdleSeconds": (userIdleSeconds() * 1000).rounded() / 1000,
        "allowedApps": allowlist(),
        "chromiumAccess": attribute(AXUIElementCreateApplication(front.pid),
                                    "AXManualAccessibility") as? Bool ?? false,
    ]
    let windows = onScreenWindows()
    report["windows"] = windows.count
    report["offStageWindows"] = offStageIds(windows).count
    let suggestions: [String] = [
        AXIsProcessTrusted() ? nil : "grant Accessibility",
        CGPreflightScreenCaptureAccess() ? nil : "grant Screen Recording",
        pauseActive() ? "resume (paused by the stop control)" : nil,
        fullScreenOverlayExists() ? "dismiss the full-screen system overlay" : nil,
    ].compactMap { $0 }
    report["nextSteps"] = suggestions
    emit(report)

case "guards":
    // Test seam: the decision is a pure function of (last action age, idle time),
    // and a test cannot fabricate real HID input to exercise it otherwise.
    if let last = args.double("simulate-last"), let idle = args.double("simulate-idle") {
        let since = Date().timeIntervalSince1970 - last
        let intervened = since > 1.0 && since < 5.0 && idle < 1.0 && idle + 0.35 < since
        emit(["ok": true, "sinceLastAction": (since * 1000).rounded() / 1000,
              "idle": idle, "userIntervened": intervened])
        exit(0)
    }
    let secure = secureInputPID()
    var payload: [String: Any] = ["ok": true,
                                  "userIdleSeconds": (userIdleSeconds() * 1000).rounded() / 1000,
                                  "secureInput": secure != nil,
                                  "paused": pauseActive(),
                                  "userIntervened": userIntervened(),
                                  "occluder": fullScreenOverlayExists()]
    if let secure { payload["secureInputPid"] = Int(secure) }
    emit(payload)

case "capsule":
    runCapsule(label: args["label"] ?? args["app"] ?? "",
               seconds: args.double("seconds") ?? 0)

case "halo":
    guard let id = args.int("window") else { fail("missing_window", "pass --window <id>") }
    runHalo(windowId: CGWindowID(id), seconds: args.double("seconds") ?? 0,
            label: args["label"] ?? "")

case "help", "--help", "-h", "":
    // LaunchServices starts the bundle with no arguments; from inside the app
    // bundle, no arguments means "run the menu bar".
    if args.command.isEmpty, Bundle.main.bundleIdentifier == "local.cu.app" {
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: "local.cu.app")
            .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
        if !others.isEmpty { exit(0) }
        if httpGetJSON(port: loadServiceConfig(portOverride: nil, tokenOverride: nil).port,
                       path: "/v1/status", timeout: 0.6) == nil {
            restartService()
            usleep(900_000)
        }
        runMenuBar(openSettings: false, openMenu: false)
    }
    print("""
    cu — standalone computer-use engine for macOS

      cu perms
      cu apps                         (running apps, with bundle ids)
      cu launch --app <bundle id | /path/to.app>
      cu windows                      (includes which app is frontmost)
      cu frontmost
      cu activate --window <id> | --pid <pid>
      cu snapshot --pid <pid> [--window <id>] [--all]   (numbered elements; --window scopes to one window)
      cu click --ref e12 --pid <pid> [--coords]   (AXPress, else its centre)
      cu click --x <n> --y <n> [--window <id>] [--force] [--button left|right] [--count 2]
      cu setvalue --pid <pid> --ref e12 --text "…" [--role AXTextField --title "…"]
      cu action --pid <pid> --ref e12 --name AXPress
      cu paste --text "…"             (clipboard is restored afterwards)
      cu shot --window <id> [--out file.png | --base64]   (origin/size/scale included)
      cu shot --screen [--display 0] [--max-dim 1600] [--out file.png]
      cu ax --pid <pid> [--depth 8] [--find text] [--all]
      cu move --x <n> --y <n>
      cu drag --from x,y --to x,y
      cu scroll --dy <n> [--x <n> --y <n>]
      cu type --text "hello"
      cu key --name enter [--mods cmd,shift]
      cu menu --pid <pid> [--path "文件/新建"] [--confirm]   (list or click a menu item)
      cu demo [--seconds 20]          (our own test window, safe to drag/zoom)
      cu stage --window <id>          (bring an off-stage window onto the current stage)
      cu ocr --window <id> | --screen [--find "文字"]   (system OCR with on-screen boxes)
      cu cursor                       (current pointer position)
      cu release                      (release a held mouse button)
      cu zoom --window <id>           (press the window's zoom / full-screen button)
      cu guards                       (secure input + user idle, for debugging)
      cu service [--port 47777] [--token <t>]   (local HTTP service; see README)
      cu agents                       (per-agent MCP wiring state)
      cu agents-connect [--id a,b]    (write our MCP entry into agent configs)
      cu agents-disconnect [--id a,b] (remove our MCP entry again)
      cu menubar [--open-settings]    (menu bar app: status, pause, settings)
      cu menubar --snapshot-console <png> [--snapshot-page overview|connections|settings|diagnostics|agent-setup]
      cu menubar --snapshot-guide <png>   (render the permission guide panel)
      cu menubar --selftest-ui        (machine-checkable console UI report)
      cu selfcheck                    (permissions, pause, overlay, allowlist in one report)
      cu cover --window <id> [--seconds 0] [--label "…"]   (occluder over the window)
      cu space --window <id>          (bring the window to the current Space)
      cu pause / cu resume            (user stop gesture: pause / clear)
      cu allow --app <bundle|name> [--remove]   (restrict which apps may be controlled)
      cu allowed
      cu halo --window <id> [--seconds 8] [--label "Safari — scrolling"]
    """)

default:
    fail("unknown_command", "no such command: \(args.command)")
}
