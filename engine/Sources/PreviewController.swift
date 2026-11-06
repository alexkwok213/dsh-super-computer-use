import Foundation
import CoreGraphics

// Preview contract (Spec §6.2) as pure, testable geometry. The continuous
// ScreenCaptureKit stream + AVSampleBufferDisplayLayer panel are NOT wired here
// yet (Task 7 deferred); this file fixes the frame-identity / letterbox /
// degradation rules so the eventual controller has one source of truth and the
// rules are proven offscreen.

struct PreviewTarget: Equatable {
    var targetGeneration: Int
    var geometryVersion: Int
}

struct PreviewFrameMeta: Equatable {
    var frameId: String
    var sessionId: String
    var targetGeneration: Int
    var geometryVersion: Int
    var capturedAtNs: UInt64
    var contentRect: CGRect
    var pixelSize: CGSize
    var scale: CGFloat
    var status: String
}

enum PreviewStatus: String {
    case live
    case stale
    case unavailable
}

enum PreviewWindowState: String {
    case visible
    case minimized
    case hidden
    case exited
}

enum PreviewGeometry {
    static func feedbackPoint(global: CGPoint, observed: CGRect, captured: CGRect,
                              current: CGRect, container: CGSize,
                              sourcePixels: CGSize? = nil, sourceContent: CGRect? = nil) -> CGPoint? {
        guard observed == captured, captured == current, current.contains(global),
              current.width > 0, current.height > 0 else { return nil }
        let pixels = sourcePixels ?? current.size
        let content = sourceContent ?? CGRect(origin: .zero, size: pixels)
        let fitted = fitRect(source: pixels, container: container)
        let scale = fitScale(source: pixels, container: container)
        let x = content.minX + (global.x - current.minX) / current.width * content.width
        let y = content.minY + (global.y - current.minY) / current.height * content.height
        return CGPoint(x: fitted.minX + x * scale, y: fitted.maxY - y * scale)
    }

    static func constrainCard(_ frame: CGRect, to visible: CGRect) -> CGRect {
        CGRect(x: min(max(frame.minX, visible.minX), max(visible.minX, visible.maxX - frame.width)),
               y: min(max(frame.minY, visible.minY), max(visible.minY, visible.maxY - frame.height)),
               width: frame.width, height: frame.height)
    }

    /// Equal-aspect fit scale for a source frame inside a container (letterbox).
    static func fitScale(source: CGSize, container: CGSize) -> CGFloat {
        guard source.width > 0, source.height > 0, container.width > 0, container.height > 0 else {
            return 0
        }
        return min(container.width / source.width, container.height / source.height)
    }

    /// The letterboxed rect inside the container (centred; margins are letterbox).
    static func fitRect(source: CGSize, container: CGSize) -> CGRect {
        let scale = fitScale(source: source, container: container)
        let width = source.width * scale
        let height = source.height * scale
        return CGRect(x: (container.width - width) / 2,
                      y: (container.height - height) / 2,
                      width: width,
                      height: height)
    }

    /// offset + (globalPoint - contentOrigin) × fitScale — the ONE mapping. It is
    /// not `point × retinaScale`: the container offset and the fit scale are
    /// separate (Spec §6.2).
    static func mapPoint(global: CGPoint, contentOrigin: CGPoint, fitScale: CGFloat,
                         offset: CGPoint) -> CGPoint {
        CGPoint(x: offset.x + (global.x - contentOrigin.x) * fitScale,
                y: offset.y + (global.y - contentOrigin.y) * fitScale)
    }

    /// Whether a frame may be drawn as "live" for the current target and window
    /// state. Minimised/hidden/exited windows and a missing first frame are
    /// **unavailable** (show "画面暂不可用/最近画面", never mark it live); a frame
    /// from another generation/geometry is **stale** (do not draw the cursor).
    static func placement(frame: PreviewFrameMeta?, target: PreviewTarget,
                          windowState: PreviewWindowState,
                          hasVisibleFirstFrame: Bool) -> (status: PreviewStatus, reason: String?) {
        if windowState != .visible {
            return (.unavailable, windowState.rawValue)
        }
        guard hasVisibleFirstFrame, let frame else {
            return (.unavailable, "no_first_frame")
        }
        if frame.targetGeneration != target.targetGeneration
            || frame.geometryVersion != target.geometryVersion {
            return (.stale, "generation_or_geometry_mismatch")
        }
        return (.live, nil)
    }

    /// A capture that has not shown a valid first frame by its deadline must
    /// degrade (cancel the stream) instead of spinning.
    static func firstFrameInBudget(elapsedMs: Int, deadlineMs: Int = 1500) -> Bool {
        elapsedMs <= deadlineMs
    }
}
