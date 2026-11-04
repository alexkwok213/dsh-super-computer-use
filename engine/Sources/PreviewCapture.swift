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
    private(set) var frames = 0
    private(set) var firstFrameAt: Date?
    private var lastFrameAt: Date?
    private(set) var maxGapMs: Int = 0

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .screen else { return }
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

/// A card that shows live frames in an AVSampleBufferDisplayLayer, with a bright
/// border so the panel is unmistakably on screen (and easy to locate in a capture).
final class PreviewCardView: NSView {
    let displayLayer = AVSampleBufferDisplayLayer()
    let staticLayer = CALayer()   // static-frame fallback when no live first frame
    private let border = CALayer()
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        staticLayer.contentsGravity = .resizeAspect
        layer?.addSublayer(staticLayer)
        displayLayer.videoGravity = .resizeAspect
        displayLayer.backgroundColor = NSColor.black.cgColor
        layer?.addSublayer(displayLayer)
        border.borderColor = NSColor(srgbRed: 1, green: 0.1, blue: 0.8, alpha: 1).cgColor
        border.borderWidth = 3
        border.backgroundColor = NSColor.clear.cgColor
        layer?.addSublayer(border)
    }
    required init?(coder: NSCoder) { fatalError() }

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
        CATransaction.commit()
    }
}

/// Show a floating preview card for `windowId` (or the main display) for
/// `seconds`, presenting live SCStream frames. Emits an early ack, then a final
/// `{ok, preview:"shown", frames, firstFrameMs}`. A non-capturable window exits
/// immediately with `window_not_capturable` (no empty card).
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
    _ = resolved.wait(timeout: .now() + 5)
    if let resolveError { emit(["ok": false, "error": resolveError]); exit(1) }

    let card = PreviewCardView(frame: NSRect(x: 0, y: 0, width: 320, height: 200))
    let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 320, height: 200),
                        styleMask: [.titled, .nonactivatingPanel],
                        backing: .buffered, defer: false)
    panel.title = "cu preview"
    // Normal level (layer 0) so it is an ordinary on-screen window that window
    // inspection/`cu windows` can see; still ordered front for the watcher.
    panel.level = .normal
    panel.hidesOnDeactivate = false
    panel.isMovableByWindowBackground = true
    panel.contentView = card
    if let screen = NSScreen.main {
        let v = screen.visibleFrame
        panel.setFrameOrigin(NSPoint(x: v.maxX - 320 - 24, y: v.maxY - 200 - 24))
    }
    panel.orderFrontRegardless()

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
    capture.onFirstFrame = { [weak card] in card?.fadeIn() }
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
    let stream = SCStream(filter: filter, configuration: config, delegate: capture)
    try? stream.addStreamOutput(capture, type: .screen, sampleHandlerQueue: capture.queue)

    let start = Date()
    Task { try? await stream.startCapture() }
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
                        Task { try? await stream.startCapture() }
                    } else {
                        panel.orderOut(nil)
                        stream.stopCapture { _ in }
                    }
                    emit(["ok": true, "cmd": "visible", "visible": visible, "frames": capture.frames])
                case "status":
                    let first = capture.firstFrameAt.map { Int($0.timeIntervalSince(start) * 1000) }
                    emit(["ok": true, "cmd": "status", "frames": capture.frames,
                          "firstFrameMs": first ?? NSNull()])
                case "stop":
                    emit(["ok": true, "cmd": "stop", "frames": capture.frames])
                    finishOnce()
                default:
                    break
                }
            }
        }
    }
    app.run()
    exit(0)
}
