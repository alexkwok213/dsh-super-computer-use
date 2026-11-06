import Foundation
import AppKit
import AVFoundation
import QuartzCore
import CoreMedia
import ScreenCaptureKit

// Task 7 native preview capture: a real SCStream on a target window (or a
// display), reporting first-frame latency, update count and a clean degrade —
// without the AVSampleBufferDisplayLayer panel (that visible layer is the next
// piece). `cu preview-probe --window <id> --seconds N` is how it is exercised.

final class PreviewCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    let queue = DispatchQueue(label: "cu.preview.capture")
    /// When set, each frame is presented in this layer (visible preview card).
    var displayLayer: AVSampleBufferDisplayLayer?
    /// Called (on main) exactly once, when the first frame arrives — used to fade
    /// the card in over 120 ms instead of popping.
    var onFirstFrame: (() -> Void)?
    var onFrame: ((CGSize, CGRect?, CGRect?, CGFloat) -> Void)?
    var onIdle: (() -> Void)?
    private(set) var frames = 0
    private(set) var firstFrameAt: Date?
    private var lastFrameAt: Date?
    private(set) var maxGapMs: Int = 0

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .screen,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
                as? [[SCStreamFrameInfo: Any]],
              let metadata = attachments.first,
              let status = metadata[.status] as? Int else { return }
        if status == SCFrameStatus.idle.rawValue {
            DispatchQueue.main.async { self.onIdle?() }
            return
        }
        guard status == SCFrameStatus.complete.rawValue,
              CMSampleBufferDataIsReady(sampleBuffer),
              let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let size = CGSize(width: CVPixelBufferGetWidth(pixels), height: CVPixelBufferGetHeight(pixels))
        guard size.width > 1, size.height > 1 else { return }
        func rect(_ key: SCStreamFrameInfo) -> CGRect? {
            guard let raw = metadata[key] as? NSDictionary else { return nil }
            return CGRect(dictionaryRepresentation: raw)
        }
        let screenRect = rect(.screenRect)
        let contentRect = rect(.contentRect)
        let scale = (metadata[.scaleFactor] as? NSNumber)?.doubleValue ?? 1
        let now = Date()
        if let last = lastFrameAt {
            maxGapMs = max(maxGapMs, Int(now.timeIntervalSince(last) * 1000))
        }
        lastFrameAt = now
        let isFirst = firstFrameAt == nil
        frames += 1
        if isFirst {
            firstFrameAt = now
            if let hook = onFirstFrame { DispatchQueue.main.async(execute: hook) }
        }
        if let layer = displayLayer {
            DispatchQueue.main.async {
                if layer.status == .failed { layer.flush() }
                layer.enqueue(sampleBuffer)
                self.onFrame?(size, screenRect, contentRect, CGFloat(scale))
            }
        }
    }
}

/// Start an SCStream on `windowId` (or the main display), enforce the 1500 ms
/// first-frame budget, capture for `seconds`, then stop. Emits one JSON object:
///   { ok, firstFrameMs, frames, degraded, maxGapMs, contentRect }
/// A window that cannot be found is a clean degrade (`window_not_capturable`) —
/// it never spins a stream that will never show anything.
func runPreviewProbe(windowId: CGWindowID?, seconds: Int) -> Never {
    // SCK/CGS requires an initialised application (else CGS_REQUIRE_INIT aborts).
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let sem = DispatchSemaphore(value: 0)
    var result: [String: Any] = ["ok": false, "error": "unstarted"]
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            let filter: SCContentFilter
            var contentRect = CGRect.zero
            if let windowId {
                guard let win = content.windows.first(where: { $0.windowID == windowId }) else {
                    result = ["ok": false, "error": "window_not_capturable"]
                    sem.signal(); return
                }
                filter = SCContentFilter(desktopIndependentWindow: win)
                contentRect = win.frame
            } else if let display = content.displays.first {
                filter = SCContentFilter(display: display, excludingWindows: [])
                contentRect = CGRect(x: 0, y: 0, width: display.width, height: display.height)
            } else {
                result = ["ok": false, "error": "no_target"]
                sem.signal(); return
            }

            let config = SCStreamConfiguration()
            // Longest edge <= 1280 px, 15 fps cap, queueDepth 3 (Spec §6.1).
            let longest = max(contentRect.width, contentRect.height, 1)
            let shrink = min(1.0, 1280.0 / longest)
            config.width = Int(contentRect.width * shrink)
            config.height = Int(contentRect.height * shrink)
            config.minimumFrameInterval = CMTime(value: 1, timescale: 15)
            config.queueDepth = 3
            config.showsCursor = false

            let capture = PreviewCapture()
            let stream = SCStream(filter: filter, configuration: config, delegate: capture)
            try stream.addStreamOutput(capture, type: .screen, sampleHandlerQueue: capture.queue)

            let start = Date()
            try await stream.startCapture()
            // First-frame deadline: degrade instead of waiting forever.
            while Date().timeIntervalSince(start) < 1.5 && capture.frames == 0 {
                try await Task.sleep(nanoseconds: 30_000_000)
            }
            let firstFrameMs = capture.firstFrameAt.map { Int($0.timeIntervalSince(start) * 1000) }
            let deadline = Date().addingTimeInterval(Double(max(0, seconds)) - min(1.5, Date().timeIntervalSince(start)))
            while Date() < deadline {
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            try? await stream.stopCapture()

            let degraded = capture.frames == 0
            result = [
                "ok": !degraded,
                "frames": capture.frames,
                "firstFrameMs": firstFrameMs ?? NSNull(),
                "degraded": degraded,
                "maxGapMs": capture.maxGapMs,
                "contentRect": ["x": contentRect.minX, "y": contentRect.minY,
                                "width": contentRect.width, "height": contentRect.height],
            ]
            sem.signal()
        } catch {
            result = ["ok": false, "error": "scstream_failed", "message": String(describing: error)]
            sem.signal()
        }
    }
    _ = sem.wait(timeout: .now() + Double(seconds + 8))
    if result["error"] as? String == "unstarted" {
        result = ["ok": false, "error": "preview_timeout"]
    }
    emit(result)
    exit((result["ok"] as? Bool) == true ? 0 : 1)
}


// MARK: - visible preview card (Task 7)

/// Picture-only native preview. The whole image is a drag surface.
final class PreviewCardView: NSView {
    let displayLayer = AVSampleBufferDisplayLayer()
    let staticLayer = CALayer()   // static-frame fallback when no live first frame
    private let border = CALayer()
    private let controls = NSView()
    private var hoverArea: NSTrackingArea?
    private let statusText = CATextLayer()
    private let pointer = CAShapeLayer()
    private let clickRing = CAShapeLayer()
    private var hideFeedback: DispatchWorkItem?
    var onMoved: ((NSRect) -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        staticLayer.contentsGravity = .resizeAspect
        layer?.addSublayer(staticLayer)
        displayLayer.videoGravity = .resizeAspect
        displayLayer.backgroundColor = NSColor.black.cgColor
        layer?.addSublayer(displayLayer)
        layer?.cornerRadius = 10
        layer?.masksToBounds = true
        border.cornerRadius = 10
        border.borderColor = NSColor.white.withAlphaComponent(0.18).cgColor
        border.borderWidth = 0.5
        border.backgroundColor = NSColor.clear.cgColor
        layer?.addSublayer(border)
        statusText.fontSize = 11
        statusText.alignmentMode = .center
        statusText.foregroundColor = NSColor.white.cgColor
        statusText.backgroundColor = NSColor.black.withAlphaComponent(0.75).cgColor
        statusText.contentsScale = 2
        statusText.isHidden = true
        layer?.addSublayer(statusText)
        pointer.fillColor = NSColor.white.cgColor
        pointer.strokeColor = NSColor.black.cgColor
        pointer.lineWidth = 1
        pointer.opacity = 0
        clickRing.fillColor = nil
        clickRing.strokeColor = NSColor.systemCyan.cgColor
        clickRing.lineWidth = 2
        clickRing.opacity = 0
        layer?.addSublayer(clickRing)
        layer?.addSublayer(pointer)
        for (index, title) in ["Stop", "×"].enumerated() {
            let button = NSButton(title: title, target: self,
                                  action: index == 0 ? #selector(stopTarget) : #selector(closePreview))
            button.frame = NSRect(x: index == 0 ? 0 : 56, y: 0,
                                  width: index == 0 ? 54 : 26, height: 26)
            button.bezelStyle = .rounded
            button.setAccessibilityLabel(index == 0 ? "Stop this target" : "Close preview")
            controls.addSubview(button)
        }
        controls.isHidden = true
        addSubview(controls)
    }
    @objc private func stopTarget() {
        emit(["event": "stop-target"])
        window?.orderOut(nil)
        exit(0)
    }
    @objc private func closePreview() {
        emit(["event": "close-preview"])
        window?.orderOut(nil)
        exit(0)
    }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let hoverArea { removeTrackingArea(hoverArea) }
        let area = NSTrackingArea(rect: .zero,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area)
        hoverArea = area
    }
    override func mouseEntered(with event: NSEvent) { controls.isHidden = false }
    override func mouseExited(with event: NSEvent) { controls.isHidden = true }

    func showStatus(_ message: String?) {
        statusText.string = message
        statusText.isHidden = message == nil
    }

    func feedback(at point: CGPoint, click: Bool) {
        hideFeedback?.cancel()
        let path = CGMutablePath()
        path.addLines(between: [point, CGPoint(x: point.x + 2, y: point.y - 14),
            CGPoint(x: point.x + 5, y: point.y - 10), CGPoint(x: point.x + 10, y: point.y - 9)])
        path.closeSubpath()
        CATransaction.begin(); CATransaction.setDisableActions(true)
        pointer.path = path
        pointer.opacity = 1
        CATransaction.commit()
        if click {
            let reduced = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
            clickRing.path = CGPath(ellipseIn: CGRect(x: point.x - 14, y: point.y - 14,
                                                     width: 28, height: 28), transform: nil)
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 1; fade.toValue = 0
            fade.duration = reduced ? 0.1 : 0.24
            clickRing.add(fade, forKey: "click")
        }
        let hide = DispatchWorkItem { [weak self] in self?.pointer.opacity = 0 }
        hideFeedback = hide
        DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: hide)
    }

    required init?(coder: NSCoder) { fatalError() }

    override var mouseDownCanMoveWindow: Bool { false }
    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        window.performDrag(with: event)
        let screen = NSScreen.screens.max { a, b in
            let aa = a.visibleFrame.intersection(window.frame)
            let bb = b.visibleFrame.intersection(window.frame)
            return aa.width * aa.height < bb.width * bb.height
        }
        if let screen {
            window.setFrame(PreviewGeometry.constrainCard(window.frame, to: screen.visibleFrame), display: true)
        }
        onMoved?(window.frame)
    }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// 120 ms fade-in when the first frame appears (Spec §6.1 card fade).
    func fadeIn(duration: CFTimeInterval = 0.12) {
        layer?.removeAnimation(forKey: "fadeIn")
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.0
        fade.toValue = 1.0
        fade.duration = duration
        fade.timingFunction = CAMediaTimingFunction(name: .easeOut)
        layer?.add(fade, forKey: "fadeIn")
    }
    func hasFadeInAnimationForTesting() -> Bool { layer?.animation(forKey: "fadeIn") != nil }

    override func layout() {
        super.layout()
        CATransaction.begin(); CATransaction.setDisableActions(true)
        staticLayer.frame = bounds
        displayLayer.frame = bounds
        border.frame = bounds
        controls.frame = NSRect(x: max(0, bounds.width - 90), y: bounds.height - 34, width: 82, height: 26)
        statusText.frame = NSRect(x: 0, y: 0, width: bounds.width, height: 22)
        CATransaction.commit()
    }
}

/// Show a floating preview card for `windowId` (or the main display) for
/// `seconds`, presenting live SCStream frames. Emits an early ack, then a final
/// `{ok, preview:"shown", frames, firstFrameMs}`. A non-capturable window exits
/// immediately with `window_not_capturable` (no empty card).
final class PreviewPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

func runPreviewWindow(windowId: CGWindowID?, seconds: Int, staticOnly: Bool = false) -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)

    var scWindow: SCWindow?
    var scDisplay: SCDisplay?
    var resolveError: String?
    let resolved = DispatchSemaphore(value: 0)
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            if let windowId {
                if let win = content.windows.first(where: { $0.windowID == windowId }) { scWindow = win }
                else { resolveError = "window_not_capturable" }
            } else if let display = content.displays.first { scDisplay = display }
            else { resolveError = "no_target" }
        } catch { resolveError = "scshareable_failed" }
        resolved.signal()
    }
    if resolved.wait(timeout: .now() + 5) == .timedOut {
        emit(["ok": false, "error": "target_resolve_timeout"]); exit(1)
    }
    if let resolveError { emit(["ok": false, "error": resolveError]); exit(1) }

    let sourceSize = scWindow?.frame.size ?? CGSize(width: scDisplay?.width ?? 320,
                                                    height: scDisplay?.height ?? 200)
    let ratio = min(320 / max(1, sourceSize.width), 240 / max(1, sourceSize.height))
    let cardRect = NSRect(x: 0, y: 0, width: max(1, sourceSize.width * ratio),
                          height: max(1, sourceSize.height * ratio))
    let card = PreviewCardView(frame: cardRect)
    let panel = PreviewPanel(contentRect: cardRect,
                        styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
    panel.title = "cu preview"
    panel.level = .floating
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.hidesOnDeactivate = false
    panel.isMovableByWindowBackground = false
    panel.contentView = card
    if let screen = NSScreen.main {
        let v = screen.visibleFrame
        let slot = max(0, Int(ProcessInfo.processInfo.environment["CU_PREVIEW_SLOT"] ?? "0") ?? 0)
        let proposed = NSRect(x: v.maxX - cardRect.width - 24 - CGFloat(slot % 2) * 344,
                              y: v.maxY - cardRect.height - 24 - CGFloat(slot / 2) * 264,
                              width: cardRect.width, height: cardRect.height)
        panel.setFrame(PreviewGeometry.constrainCard(proposed, to: v), display: true)
    }
    panel.orderFrontRegardless()
    let previewWindowId = panel.windowNumber
    card.onMoved = { frame in
        let top = NSScreen.screens.first?.frame.maxY ?? 0
        emit(["event": "preview-geometry", "previewWindowId": previewWindowId,
              "frame": ["x": frame.minX, "y": top - frame.maxY,
                        "width": frame.width, "height": frame.height]])
    }
    card.onMoved?(panel.frame)

    if staticOnly {
        // Deterministic fallback path: one still frame via SCScreenshotManager,
        // shown statically (never a per-frame JPEG loop). Used when a live stream
        // cannot produce a first frame, and straightforward to verify.
        let filter = windowId != nil
            ? SCContentFilter(desktopIndependentWindow: scWindow!)
            : SCContentFilter(display: scDisplay!, excludingWindows: [])
        let rect = windowId != nil
            ? scWindow!.frame
            : CGRect(x: 0, y: 0, width: scDisplay!.width, height: scDisplay!.height)
        let config = SCStreamConfiguration()
        let longest = max(rect.width, rect.height, 1)
        let shrink = min(1.0, 1280.0 / longest)
        config.width = Int(rect.width * shrink)
        config.height = Int(rect.height * shrink)
        config.showsCursor = false
        let started = Date()
        var result: [String: Any] = ["ok": false, "error": "static_capture_failed"]
        let sem = DispatchSemaphore(value: 0)
        Task {
            do {
                let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
                DispatchQueue.main.async {
                    card.staticLayer.contents = image
                    card.displayLayer.isHidden = true
                    card.showStatus("Still image")
                }
                result = ["ok": true, "mode": "static", "pixelWidth": image.width,
                          "pixelHeight": image.height,
                          "firstFrameMs": Int(Date().timeIntervalSince(started) * 1000)]
            } catch {
                result = ["ok": false, "error": "static_capture_failed",
                          "message": String(describing: error)]
            }
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + 5)
        emit(result)
        let stop = Timer(timeInterval: Double(max(1, seconds)), repeats: false) { _ in
            exit((result["ok"] as? Bool) == true ? 0 : 1)
        }
        RunLoop.main.add(stop, forMode: .common)
        app.run()
        exit(0)
    }

    let capture = PreviewCapture()
    capture.displayLayer = card.displayLayer
    capture.onFirstFrame = { [weak card] in
        card?.fadeIn()
        emit(["ok": true, "preview": "live"])
    }
    func currentTargetBounds() -> CGRect? {
        guard let windowId,
              let row = (CGWindowListCopyWindowInfo(.optionIncludingWindow, windowId) as? [[String: Any]])?.first,
              row[kCGWindowIsOnscreen as String] as? Bool == true,
              let raw = row[kCGWindowBounds as String] as? NSDictionary else { return nil }
        return CGRect(dictionaryRepresentation: raw)
    }
    var capturedBounds: CGRect?
    var capturedContent: CGRect?
    var capturedPixels: CGSize?
    var frameAt = Date.distantPast
    capture.onFrame = { size, screenRect, contentRect, scale in
        guard let screenRect, let contentRect, screenRect.width > 0, screenRect.height > 0 else {
            capturedBounds = nil
            return
        }
        let pixels = CGRect(x: contentRect.minX * scale, y: contentRect.minY * scale,
                            width: contentRect.width * scale, height: contentRect.height * scale)
        guard pixels.width > 0, pixels.height > 0,
              CGRect(origin: .zero, size: size).insetBy(dx: -1, dy: -1).contains(pixels) else {
            capturedBounds = nil
            return
        }
        capturedBounds = screenRect
        capturedContent = pixels
        capturedPixels = size
        frameAt = Date()
        card.showStatus(nil)
    }
    capture.onIdle = {
        // Idle means the current pixels remain valid, not that capture stalled.
        guard let capturedBounds, currentTargetBounds() == capturedBounds else { return }
        frameAt = Date()
        card.showStatus(nil)
    }
    let filter = windowId != nil ? SCContentFilter(desktopIndependentWindow: scWindow!)
                                 : SCContentFilter(display: scDisplay!, excludingWindows: [])
    let rect = windowId != nil ? scWindow!.frame : CGRect(x: 0, y: 0, width: scDisplay!.width, height: scDisplay!.height)
    let config = SCStreamConfiguration()
    let longest = max(rect.width, rect.height, 1)
    let shrink = min(1.0, 1280.0 / longest)
    config.width = Int(rect.width * shrink)
    config.height = Int(rect.height * shrink)
    config.minimumFrameInterval = CMTime(value: 1, timescale: 15)
    config.queueDepth = 3
    config.showsCursor = false
    if #available(macOS 14.2, *) { config.ignoreShadowsSingleWindow = true }
    let stream = SCStream(filter: filter, configuration: config, delegate: capture)
    try? stream.addStreamOutput(capture, type: .screen, sampleHandlerQueue: capture.queue)

    let start = Date()
    if ProcessInfo.processInfo.environment["CU_PREVIEW_FORCE_NO_FIRST_FRAME"] == "1" {
        // Deterministic test hook (not a product behaviour): simulate "target
        // resolved but the stream never produces a first frame" so the bounded
        // static fallback below can be exercised on any machine.
    } else {
        Task { try? await stream.startCapture() }
    }
    emit(["ok": true, "preview": "starting"])

    var finished = false
    let finishOnce: () -> Void = {
        if finished { return }
        finished = true
        stream.stopCapture { _ in }
        let first = capture.firstFrameAt.map { Int($0.timeIntervalSince(start) * 1000) }
        emit(["ok": capture.frames > 0, "preview": "shown", "frames": capture.frames,
              "firstFrameMs": first ?? NSNull()])
        exit(capture.frames > 0 ? 0 : 1)
    }
    // R7 / Spec §6.3: if the live stream produces no valid first frame within
    // 1500 ms, cancel it and degrade to ONE static frame with an explicit status
    // marker. No fake frame loop, no blank card, no silent hang.
    var degradedToStatic = false
    let firstFrameBudget = Timer(timeInterval: 1.5, repeats: false) { _ in
        guard capture.frames == 0, !finished, !degradedToStatic else { return }
        degradedToStatic = true
        stream.stopCapture { _ in }
        Task {
            do {
                let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
                DispatchQueue.main.async {
                    card.staticLayer.contents = image
                    card.displayLayer.isHidden = true
                    card.showStatus("Recent image · live preview unavailable")
                    card.fadeIn()
                }
                emit(["ok": true, "preview": "degraded", "mode": "static-fallback",
                      "reason": "first_frame_timeout", "budgetMs": 1500,
                      "pixelWidth": image.width, "pixelHeight": image.height])
            } catch {
                DispatchQueue.main.async { card.showStatus("Preview unavailable") }
                emit(["ok": false, "preview": "degraded", "mode": "static-fallback",
                      "reason": "first_frame_timeout", "budgetMs": 1500,
                      "message": String(describing: error)])
            }
        }
    }
    RunLoop.main.add(firstFrameBudget, forMode: .common)
    let freshness = Timer(timeInterval: 0.5, repeats: true) { _ in
        guard !degradedToStatic else { return }
        if windowId != nil && currentTargetBounds() == nil {
            capturedBounds = nil
            card.showStatus("Window unavailable · recent image")
        } else if Date().timeIntervalSince(frameAt) >= 2 {
            card.showStatus("Waiting for a fresh frame")
        }
    }
    RunLoop.main.add(freshness, forMode: .common)
    let finish = Timer(timeInterval: Double(max(1, seconds)), repeats: false) { _ in finishOnce() }
    RunLoop.main.add(finish, forMode: .common)

    // preview.visible / preview.stop protocol (Spec §6.1): hiding pauses the
    // stream so a hidden card costs no capture; showing resumes without replaying
    // backlog; stop closes it. One JSON ack per command.
    DispatchQueue(label: "cu.preview.stdin").async {
        while let line = readLine(strippingNewline: true) {
            guard let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let cmd = obj["cmd"] as? String else { continue }
            DispatchQueue.main.async {
                switch cmd {
                case "visible":
                    let visible = obj["visible"] as? Bool ?? true
                    if visible {
                        panel.orderFrontRegardless()
                        if !degradedToStatic { Task { try? await stream.startCapture() } }
                    } else {
                        panel.orderOut(nil)
                        stream.stopCapture { _ in }
                    }
                    emit(["ok": true, "cmd": "visible", "visible": visible, "frames": capture.frames])
                case "feedback":
                    guard !degradedToStatic, Date().timeIntervalSince(frameAt) < 2,
                          let captured = capturedBounds, let current = currentTargetBounds(),
                          let raw = obj["bounds"] as? [String: Double],
                          let x = raw["x"], let y = raw["y"],
                          let width = raw["width"], let height = raw["height"],
                          let point = obj["point"] as? [String: Double],
                          let px = point["x"], let py = point["y"],
                          let stamp = obj["sentAt"] as? Double,
                          abs(Date().timeIntervalSince1970 * 1000 - stamp) < 1000,
                          let mapped = PreviewGeometry.feedbackPoint(global: CGPoint(x: px, y: py),
                              observed: CGRect(x: x, y: y, width: width, height: height),
                              captured: captured, current: current, container: card.bounds.size,
                              sourcePixels: capturedPixels, sourceContent: capturedContent) else { return }
                    card.feedback(at: mapped, click: obj["click"] as? Bool == true)
                case "status":
                    let first = capture.firstFrameAt.map { Int($0.timeIntervalSince(start) * 1000) }
                    emit(["ok": true, "cmd": "status", "frames": capture.frames,
                          "firstFrameMs": first ?? NSNull(),
                          "capturedBounds": capturedBounds.map { ["x": $0.minX, "y": $0.minY,
                              "width": $0.width, "height": $0.height] } ?? [:],
                          "contentPixels": capturedContent.map { ["x": $0.minX, "y": $0.minY,
                              "width": $0.width, "height": $0.height] } ?? [:]])
                case "stop":
                    emit(["ok": true, "cmd": "stop", "frames": capture.frames])
                    finishOnce()
                default:
                    break
                }
            }
        }
        // stdin EOF: when THIS preview was spawned by a cursor helper, its owner
        // went away (crash / explicit stop / host reload) — end the capture and
        // close the card so it never outlives the tool that created it (R8).
        // A standalone `cu preview` CLI has no owner pipe and keeps running.
        if ProcessInfo.processInfo.environment["CU_PREVIEW_OWNED_BY_HELPER"] == "1" {
            DispatchQueue.main.async {
                stream.stopCapture { _ in }
                panel.orderOut(nil)
                exit(0)
            }
        }
    }
    app.run()
    exit(0)
}
