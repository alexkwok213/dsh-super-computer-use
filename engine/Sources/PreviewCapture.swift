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
    private let controls = NSVisualEffectView()
    private var controlsVisible = false
    private var reducedMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    private var dismissing = false
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
        layer?.cornerRadius = 8
        layer?.masksToBounds = true
        border.cornerRadius = 8
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
        pointer.name = "agent-pointer"
        let arrow = CGMutablePath()
        arrow.addLines(between: [.zero, CGPoint(x: 2, y: -14),
            CGPoint(x: 5, y: -10), CGPoint(x: 10, y: -9)])
        arrow.closeSubpath()
        pointer.path = arrow
        pointer.shadowColor = NSColor.black.cgColor
        pointer.shadowOpacity = 0.3
        pointer.shadowRadius = 2
        pointer.shadowOffset = CGSize(width: 0, height: -1)
        pointer.fillColor = NSColor.white.cgColor
        pointer.strokeColor = NSColor.black.cgColor
        pointer.lineWidth = 1
        pointer.opacity = 0
        clickRing.fillColor = nil
        clickRing.strokeColor = NSColor.systemPurple.withAlphaComponent(0.85).cgColor
        clickRing.lineWidth = 2
        clickRing.opacity = 0
        layer?.addSublayer(clickRing)
        layer?.addSublayer(pointer)
        controls.material = .hudWindow
        controls.blendingMode = .withinWindow
        controls.state = .active
        controls.appearance = NSAppearance(named: .darkAqua)
        controls.wantsLayer = true
        controls.layer?.cornerRadius = 13
        controls.layer?.masksToBounds = true
        for (index, symbol) in ["stop.fill", "xmark"].enumerated() {
            let button = NSButton(image: NSImage(systemSymbolName: symbol, accessibilityDescription: nil)!,
                                  target: self, action: index == 0 ? #selector(stopTarget) : #selector(closePreview))
            button.frame = NSRect(x: 3 + index * 26, y: 2, width: 26, height: 22)
            button.isBordered = false
            button.contentTintColor = .white
            let label = index == 0 ? "Stop this target" : "Close preview"
            button.setAccessibilityLabel(label)
            button.toolTip = label
            controls.addSubview(button)
        }
        controls.isHidden = true
        controls.alphaValue = 0
        addSubview(controls)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(accessibilityChanged),
            name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil)
    }
    deinit { NSWorkspace.shared.notificationCenter.removeObserver(self) }
    @objc private func accessibilityChanged() {
        setReducedMotion(NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
    }
    func setReducedMotion(_ enabled: Bool) {
        reducedMotion = enabled
        if enabled {
            layer?.removeAllAnimations()
            pointer.removeAllAnimations()
            clickRing.removeAllAnimations()
        }
    }
    @objc private func stopTarget() {
        // Close the input gate immediately; only the visual departure is delayed.
        emit(["event": "stop-target"])
        dismiss { exit(0) }
    }
    @objc private func closePreview() {
        emit(["event": "close-preview"])
        dismiss { exit(0) }
    }
    func dismiss(verifiedAppIcon: NSImage? = nil, completion: @escaping () -> Void) {
        guard !dismissing else { return }
        dismissing = true
        hideFeedback?.cancel()
        window?.ignoresMouseEvents = true
        if let icon = verifiedAppIcon {
            controls.isHidden = true
            pointer.removeAllAnimations()
            pointer.opacity = 0
            clickRing.removeAllAnimations()
            let image = NSImageView(image: icon)
            image.imageScaling = .scaleProportionallyUpOrDown
            let side = min(40, bounds.width, bounds.height)
            image.frame = NSRect(x: bounds.midX - side/2, y: bounds.midY - side/2, width: side, height: side)
            image.setAccessibilityLabel("Last action verified")
            addSubview(image)
            let check = NSTextField(labelWithString: "✓")
            check.alignment = .center
            check.font = .systemFont(ofSize: 11, weight: .bold)
            check.textColor = .black
            check.wantsLayer = true
            check.layer?.backgroundColor = NSColor.systemGreen.cgColor
            check.layer?.cornerRadius = 8
            check.frame = NSRect(x: image.frame.maxX - 11, y: image.frame.minY - 3, width: 16, height: 16)
            addSubview(check)
            if !reducedMotion {
                image.alphaValue = 0; check.alphaValue = 0
                NSAnimationContext.runAnimationGroup { context in
                    context.duration = 0.14
                    image.animator().alphaValue = 1; check.animator().alphaValue = 1
                }
            }
        }
        let depart = {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = self.reducedMotion ? 0 : 0.16
                context.timingFunction = CAMediaTimingFunction(name: .easeIn)
                self.window?.animator().alphaValue = 0
            } completionHandler: {
                self.window?.orderOut(nil)
                completion()
            }
        }
        if verifiedAppIcon != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.75, execute: depart)
        } else { depart() }
    }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let hoverArea { removeTrackingArea(hoverArea) }
        let area = NSTrackingArea(rect: .zero,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area)
        hoverArea = area
    }
    override func mouseEntered(with event: NSEvent) { setControlsVisible(true) }
    override func mouseExited(with event: NSEvent) { setControlsVisible(false) }
    private func setControlsVisible(_ visible: Bool) {
        controlsVisible = visible
        if visible { controls.isHidden = false }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = reducedMotion ? 0 : 0.16
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            controls.animator().alphaValue = visible ? 1 : 0
        } completionHandler: {
            if !self.controlsVisible { self.controls.isHidden = true }
        }
    }

    func showStatus(_ message: String?) {
        statusText.string = message
        statusText.isHidden = message == nil
        if message != nil {
            hideFeedback?.cancel()
            pointer.removeAllAnimations()
            clickRing.removeAllAnimations()
            CATransaction.begin(); CATransaction.setDisableActions(true)
            pointer.opacity = 0
            clickRing.opacity = 0
            CATransaction.commit()
            if window?.alphaValue == 0 { fadeIn() }
        }
    }

    func feedback(at point: CGPoint, click: Bool) {
        guard !dismissing else { return }
        hideFeedback?.cancel()
        // Retarget from the visible position, never from the previous destination.
        let origin = pointer.presentation()?.position ?? pointer.position
        let opacity = pointer.presentation()?.opacity ?? pointer.opacity
        let visible = opacity > 0
        let distance = hypot(point.x - origin.x, point.y - origin.y)
        let duration = reducedMotion || !visible ? 0 : min(0.22, max(0.08, Double(distance) / 700))
        pointer.removeAllAnimations()
        clickRing.removeAllAnimations()
        CATransaction.begin(); CATransaction.setDisableActions(true)
        pointer.position = point
        pointer.opacity = 1
        clickRing.position = point
        clickRing.path = CGPath(ellipseIn: CGRect(x: -12, y: -12, width: 24, height: 24), transform: nil)
        CATransaction.commit()
        if !reducedMotion && opacity < 1 {
            let appear = CABasicAnimation(keyPath: "opacity")
            appear.fromValue = opacity; appear.toValue = 1; appear.duration = 0.1
            pointer.add(appear, forKey: "fade")
        }
        if duration > 0 {
            let move = CABasicAnimation(keyPath: "position")
            move.fromValue = NSValue(point: origin); move.toValue = NSValue(point: point)
            move.duration = duration
            move.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 1, 0.36, 1)
            pointer.add(move, forKey: "move")
        }
        if click {
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 0.9; fade.toValue = 0
            let expand = CABasicAnimation(keyPath: "transform.scale")
            expand.fromValue = 0.35; expand.toValue = 1.25
            let group = CAAnimationGroup()
            group.animations = reducedMotion ? [fade] : [fade, expand]
            group.duration = reducedMotion ? 0.1 : 0.32
            fade.duration = group.duration
            expand.duration = group.duration
            group.beginTime = CACurrentMediaTime() + duration
            group.timingFunction = CAMediaTimingFunction(name: .easeOut)
            clickRing.add(group, forKey: "click")
        }
        let hide = DispatchWorkItem { [weak self] in
            guard let self else { return }
            CATransaction.begin(); CATransaction.setDisableActions(true)
            self.pointer.opacity = 0
            CATransaction.commit()
            if !self.reducedMotion {
                let fade = CABasicAnimation(keyPath: "opacity")
                fade.fromValue = 1; fade.toValue = 0; fade.duration = 0.2
                self.pointer.add(fade, forKey: "fade")
            }
        }
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

    /// Reveal only when content (or an explicit unavailable status) is ready.
    func fadeIn(duration: CFTimeInterval = 0.22) {
        guard !dismissing else { return }
        window?.alphaValue = 1
        layer?.removeAllAnimations()
        guard !reducedMotion else { return }
        let scale = CABasicAnimation(keyPath: "transform.scale")
        scale.fromValue = 0.96; scale.toValue = 1
        scale.duration = duration
        scale.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 1, 0.36, 1)
        layer?.add(scale, forKey: "appear")
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
        controls.frame = NSRect(x: max(0, bounds.width - 64), y: bounds.height - 32, width: 58, height: 26)
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
    let ratio = min(200 / max(1, sourceSize.width), 150 / max(1, sourceSize.height))
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
        let proposed = NSRect(x: v.maxX - cardRect.width - 24 - CGFloat(slot % 2) * 216,
                              y: v.maxY - cardRect.height - 24 - CGFloat(slot / 2) * 166,
                              width: cardRect.width, height: cardRect.height)
        panel.setFrame(PreviewGeometry.constrainCard(proposed, to: v), display: true)
    }
    panel.alphaValue = 0
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
                    card.fadeIn()
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
    config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
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
        card.dismiss { exit(capture.frames > 0 ? 0 : 1) }
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
        guard !finished, !degradedToStatic else { return }
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
                case "last-action-verified":
                    guard panel.isVisible, panel.alphaValue > 0, !degradedToStatic,
                          let capturedBounds, currentTargetBounds() == capturedBounds,
                          Date().timeIntervalSince(frameAt) < 2,
                          let pid = scWindow?.owningApplication?.processID else { break }
                    finished = true
                    stream.stopCapture { _ in }
                    let icon = NSRunningApplication(processIdentifier: pid)?.icon ??
                        NSImage(systemSymbolName: "app", accessibilityDescription: nil)
                    card.dismiss(verifiedAppIcon: icon) { exit(0) }
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
                card.dismiss { exit(0) }
            }
        }
    }
    app.run()
    exit(0)
}
