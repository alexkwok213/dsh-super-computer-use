import Foundation
import AppKit
import CoreMedia
import ScreenCaptureKit

// Task 7 native preview capture: a real SCStream on a target window (or a
// display), reporting first-frame latency, update count and a clean degrade —
// without the AVSampleBufferDisplayLayer panel (that visible layer is the next
// piece). `cu preview-probe --window <id> --seconds N` is how it is exercised.

final class PreviewCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    let queue = DispatchQueue(label: "cu.preview.capture")
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
        frames += 1
        if firstFrameAt == nil { firstFrameAt = now }
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
