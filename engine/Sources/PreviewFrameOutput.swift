import Foundation
import AppKit
import CoreImage
import CoreMedia
import ScreenCaptureKit

// Bounded live-frame outlet for the Harness viewer.
//
// `cu preview-stream --window <id> --session <sid> --generation <n>` keeps the
// existing ScreenCaptureKit capture path but writes length-prefixed JPEG frames
// to stdout instead of drawing an AppKit panel. The Host proxies that stream
// over its authenticated Fetch route; the browser decodes it into a canvas.
//
// Frame = uint32BE metadataLength | uint32BE jpegLength | UTF-8 JSON | JPEG.
// Metadata is capped at 16 KiB and a JPEG at 2 MiB before a receiver allocates
// anything. stderr carries diagnostics only; a parent that dies closes stdin and
// this process exits, so no capture outlives its owner.
//
// Concurrency: the capture callback and the JPEG encoder run on different
// queues. All mutable state (stopped / encoding / dropped / wrote / frameSeq /
// lastEmit / firstFrameSent) is read and written under `stateLock`; the encoder
// queue never blocks the capture queue, and stdout is written only from the
// encoder queue.

private let maxMetadataBytes = 16 * 1024
private let maxFrameBytes = 2 * 1024 * 1024
private let firstFrameBudgetSeconds: TimeInterval = 2.0
private let stderrHandle = FileHandle.standardError
private let stdoutHandle = FileHandle.standardOutput

private func diagnostic(_ line: String) {
    guard let data = (line + "\n").data(using: .utf8) else { return }
    try? stderrHandle.write(contentsOf: data)
}

private func uint32BE(_ value: Int) -> Data {
    var big = UInt32(clamping: value).bigEndian
    return withUnsafeBytes(of: &big) { Data($0) }
}

private func nowNs() -> UInt64 {
    UInt64(Date().timeIntervalSince1970 * 1_000_000_000)
}

final class PreviewFrameOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    private let sessionId: String
    private let generation: Int
    private let targetId: String
    private let geometryVersion: Int
    private let contentRect: CGRect
    private let maxDimension: Int
    private let minimumInterval: CFTimeInterval
    private let encodeQueue = DispatchQueue(label: "cu.preview-stream.encode", qos: .userInitiated)
    /// SCStream callback queue. Frame encoding happens on a separate serial
    /// queue so a slow JPEG never stalls capture delivery.
    let captureQueue = DispatchQueue(label: "cu.preview-stream.capture", qos: .userInitiated)
    private let context = CIContext(options: [.useSoftwareRenderer: false])

    private let stateLock = NSLock()
    private var frameSeq: UInt64 = 0
    private var lastEmit: CFTimeInterval = 0
    private var encoding = false
    private var dropped = 0
    private var wrote = 0
    private var stopped = false
    private var firstFrameSent = false

    /// Called on the main queue exactly once, after the first successful write.
    var onFirstFrame: (() -> Void)?

    init(sessionId: String, generation: Int, targetId: String = "",
         geometryVersion: Int, contentRect: CGRect,
         maxDimension: Int, fps: Double) {
        self.sessionId = sessionId
        self.generation = generation
        self.targetId = targetId
        self.geometryVersion = geometryVersion
        self.contentRect = contentRect
        self.maxDimension = maxDimension
        self.minimumInterval = 1.0 / max(1.0, fps)
        super.init()
    }

    var hasFirstFrame: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return firstFrameSent
    }

    func stop() {
        stateLock.lock()
        stopped = true
        stateLock.unlock()
    }

    private func markDropped() {
        stateLock.lock()
        dropped += 1
        stateLock.unlock()
    }

    private func dropCount() -> Int {
        stateLock.lock()
        defer { stateLock.unlock() }
        return dropped
    }

    private func isStopped() -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return stopped
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .screen else { return }
        let now = CFAbsoluteTimeGetCurrent()
        stateLock.lock()
        if stopped {
            stateLock.unlock()
            return
        }
        if now - lastEmit < minimumInterval {
            stateLock.unlock()
            return
        }
        if encoding {
            dropped += 1
            stateLock.unlock()
            return
        }
        lastEmit = now
        encoding = true
        stateLock.unlock()

        encodeQueue.async { [weak self] in
            guard let self else { return }
            self.encode(sampleBuffer)
        }
    }

    private func encode(_ sampleBuffer: CMSampleBuffer) {
        defer {
            stateLock.lock()
            encoding = false
            stateLock.unlock()
        }
        if isStopped() { return }
        // A buffer that is not ready / has no image plane / has a degenerate
        // extent is not a frame. Count it and wait for a valid one instead of
        // emitting a black or zero-size image.
        guard CMSampleBufferDataIsReady(sampleBuffer),
              let pool = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            markDropped()
            return
        }
        let pixelWidth = CVPixelBufferGetWidth(pool)
        let pixelHeight = CVPixelBufferGetHeight(pool)
        guard pixelWidth >= 2, pixelHeight >= 2 else {
            markDropped()
            return
        }
        let image = CIImage(cvPixelBuffer: pool)
        let extent = image.extent
        guard extent.width.isFinite, extent.height.isFinite,
              extent.width >= 2, extent.height >= 2 else {
            markDropped()
            return
        }

        // The stream configuration already scales to the requested longest edge.
        // A defensive second scale keeps a mis-sized configuration within bounds.
        var output = image
        let longest = max(extent.width, extent.height)
        if maxDimension > 0, longest > CGFloat(maxDimension) {
            let scale = CGFloat(maxDimension) / longest
            output = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        }
        guard let cgImage = context.createCGImage(output, from: output.extent),
              cgImage.width >= 2, cgImage.height >= 2 else {
            markDropped()
            return
        }
        let rep = NSBitmapImageRep(cgImage: cgImage)
        rep.size = NSSize(width: cgImage.width, height: cgImage.height)
        guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.66]),
              jpeg.count > 4 else {
            markDropped()
            return
        }
        guard jpeg.count <= maxFrameBytes else {
            markDropped()
            return
        }
        if isStopped() { return }

        stateLock.lock()
        frameSeq += 1
        let seq = frameSeq
        let droppedSnapshot = dropped
        stateLock.unlock()

        let metadata: [String: Any] = [
            "version": 1,
            "frameId": String(seq),
            "cuSessionId": sessionId,
            "targetGeneration": generation,
            "targetId": targetId,
            "geometryVersion": geometryVersion,
            "capturedAtNs": nowNs(),
            "pixelWidth": cgImage.width,
            "pixelHeight": cgImage.height,
            "contentRect": [
                "x": Double(contentRect.origin.x),
                "y": Double(contentRect.origin.y),
                "width": Double(contentRect.width),
                "height": Double(contentRect.height),
            ],
            "dropped": droppedSnapshot,
        ]
        guard let meta = try? JSONSerialization.data(withJSONObject: metadata, options: []),
              meta.count <= maxMetadataBytes else { return }

        var payload = Data()
        payload.append(uint32BE(meta.count))
        payload.append(uint32BE(jpeg.count))
        payload.append(meta)
        payload.append(jpeg)

        do {
            try stdoutHandle.write(contentsOf: payload)
        } catch {
            // The Host closed the pipe: the owner is gone, stop capturing.
            exit(0)
        }

        stateLock.lock()
        wrote += 1
        let wroteSnapshot = wrote
        let isFirst = !firstFrameSent
        if isFirst { firstFrameSent = true }
        stateLock.unlock()

        if isFirst {
            DispatchQueue.main.async { [weak self] in
                self?.onFirstFrame?()
            }
        }
        // One diagnostic line per 100 frames keeps stderr useful without
        // becoming a per-frame log.
        if wroteSnapshot % 100 == 0 {
            diagnostic("[preview-stream] frames=\(wroteSnapshot) dropped=\(dropCount()) bytes=\(payload.count)")
        }
    }

    /// ScreenCaptureKit reports an unexpected capture stop here (the captured
    /// window closed, the display was reconfigured, permission was revoked).
    /// A preview that silently keeps "running" after that is a lie, so exit
    /// non-zero and let the Host finalize the stream.
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        stop()
        diagnostic("[preview-stream] error=capture_stopped message=\(error)")
        DispatchQueue.main.async { exit(5) }
    }
}

func runPreviewStream(windowId: CGWindowID, sessionId: String, generation: Int,
                      targetId: String = "", seconds: Int, fps: Double, maxDimension: Int,
                      watchParentStdin: Bool) -> Never {
    // A closed stdout must surface as a write error, not a signal that kills the
    // process before it can close the stream cleanly.
    signal(SIGPIPE, SIG_IGN)

    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)

    // Parent-death detector: the Host keeps stdin open on the child and passes
    // --watch-parent. EOF then means the Host (or its preview request) is gone.
    // A standalone CLI run does not pass the flag, so inheriting /dev/null or a
    // terminal cannot terminate capture by accident.
    if watchParentStdin {
        DispatchQueue.global(qos: .utility).async {
            var byte: UInt8 = 0
            while true {
                let count = read(STDIN_FILENO, &byte, 1)
                if count <= 0 { break }
            }
            exit(0)
        }
    }

    signal(SIGTERM) { _ in exit(0) }
    signal(SIGINT) { _ in exit(0) }

    var scWindow: SCWindow?
    var resolveError: String?
    let resolved = DispatchSemaphore(value: 0)
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            if let win = content.windows.first(where: { $0.windowID == windowId }) {
                scWindow = win
            } else {
                resolveError = "window_not_capturable"
            }
        } catch {
            resolveError = "scshareable_failed"
        }
        resolved.signal()
    }
    _ = resolved.wait(timeout: .now() + 5)
    guard let window = scWindow else {
        diagnostic("[preview-stream] error=\(resolveError ?? "window_not_capturable") window=\(windowId)")
        exit(2)
    }

    let frame = window.frame
    let longest = max(frame.width, frame.height, 1)
    let shrink = min(1.0, CGFloat(maxDimension) / longest)
    let width = max(2, Int(frame.width * shrink))
    let height = max(2, Int(frame.height * shrink))

    let config = SCStreamConfiguration()
    config.width = width
    config.height = height
    config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, min(30, Int(fps.rounded())))))
    config.queueDepth = 3
    config.showsCursor = false
    config.scalesToFit = true
    config.preservesAspectRatio = true
    config.pixelFormat = kCVPixelFormatType_32BGRA

    let filter = SCContentFilter(desktopIndependentWindow: window)
    let output = PreviewFrameOutput(
        sessionId: sessionId,
        generation: generation,
        targetId: targetId,
        geometryVersion: 1,
        contentRect: frame,
        maxDimension: maxDimension,
        fps: fps
    )
    let stream = SCStream(filter: filter, configuration: config, delegate: output)
    do {
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: output.captureQueue)
    } catch {
        diagnostic("[preview-stream] error=add_output_failed message=\(error)")
        exit(3)
    }

    var firstFrameTimer: Timer?
    output.onFirstFrame = {
        // Main queue: the timer is owned by the main run loop.
        firstFrameTimer?.invalidate()
        firstFrameTimer = nil
    }

    Task {
        do {
            try await stream.startCapture()
            diagnostic("[preview-stream] ready window=\(windowId) size=\(width)x\(height) fps=\(fps) session=\(sessionId) generation=\(generation)")
            DispatchQueue.main.async {
                // No valid frame within the budget is a failed capture, not a
                // stream that should wait forever behind a stale label.
                let timer = Timer(timeInterval: firstFrameBudgetSeconds, repeats: false) { _ in
                    guard !output.hasFirstFrame else { return }
                    output.stop()
                    diagnostic("[preview-stream] error=no_first_frame window=\(windowId)")
                    stream.stopCapture { _ in exit(6) }
                    // stopCapture may never call back if capture never really
                    // started; do not leave the parent waiting for it.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { exit(6) }
                }
                firstFrameTimer = timer
                RunLoop.main.add(timer, forMode: .common)
            }
        } catch {
            diagnostic("[preview-stream] error=start_failed message=\(error)")
            exit(4)
        }
    }

    let deadline = Timer(timeInterval: Double(max(1, seconds)), repeats: false) { _ in
        firstFrameTimer?.invalidate()
        firstFrameTimer = nil
        output.stop()
        stream.stopCapture { _ in exit(0) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { exit(0) }
    }
    RunLoop.main.add(deadline, forMode: .common)
    app.run()
    exit(0)
}
