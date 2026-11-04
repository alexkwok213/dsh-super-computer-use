import AppKit
import QuartzCore
import Foundation

// Visual feedback rendering, moved out of main.swift (Task 5) so the
// overlay class can be compiled and reasoned about on its own.

final class CursorLayerView: NSView {
    /// Screen-edge breathing rim, not an ambient screen glow: four narrow gradient
    /// bands keep the light on the border (transparent centre) and only show while
    /// the agent is actually acting.
    private let auraContainer = CALayer()
    private let auraBreath = CALayer()
    private var auraBands: [CAGradientLayer] = []
    private var auraHideWork: DispatchWorkItem?
    private(set) var lastActivityAt = Date()
    private static let auraBandWidth: CGFloat = 72
    private static let auraIdleFade: TimeInterval = 2.0
    private let arrow = CAShapeLayer()
    private let arrowGlow = CAShapeLayer()
    private let ripple = CAShapeLayer()
    private let labelBubble = CAShapeLayer()
    private let labelText = CATextLayer()
    private var lastPoint: CGPoint?
    // Bounded, latest-wins visual scheduling (Task 5): rapid cursor moves
    // coalesce to the newest target; the backlog can never grow past the cap.
    private var pendingCursorTarget: CGPoint?
    private var pendingCursorGlide = true
    private var coalesceScheduled = false
    private(set) var appliedCursorCount = 0
    private(set) var droppedCursorCount = 0
    static let visualQueueLimit = 64
    private var hasShownCursor = false
    private let accent = NSColor(srgbRed: 0.28, green: 0.72, blue: 1, alpha: 1).cgColor

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        installAura()

        let path = CGMutablePath()
        // Arrow pointing up-left, ~22pt tall, matching a system pointer shape.
        path.move(to: CGPoint(x: 0, y: 22))
        path.addLine(to: CGPoint(x: 0, y: 0))
        path.addLine(to: CGPoint(x: 16, y: 12))
        path.addLine(to: CGPoint(x: 8.5, y: 13))
        path.addLine(to: CGPoint(x: 13, y: 21))
        path.addLine(to: CGPoint(x: 10, y: 22.5))
        path.addLine(to: CGPoint(x: 5.5, y: 14.5))
        path.closeSubpath()
        for shape in [arrowGlow, arrow] {
            shape.path = path
            shape.lineJoin = .round
            shape.opacity = 0
            layer?.addSublayer(shape)
        }
        arrowGlow.fillColor = accent
        arrowGlow.strokeColor = accent
        arrowGlow.lineWidth = 2
        arrowGlow.shadowColor = accent
        arrowGlow.shadowRadius = 6
        arrowGlow.shadowOpacity = 0.9
        arrowGlow.shadowOffset = .zero
        arrow.fillColor = NSColor.white.cgColor
        arrow.strokeColor = NSColor(srgbRed: 0.10, green: 0.20, blue: 0.45, alpha: 1).cgColor
        arrow.lineWidth = 1.2

        ripple.fillColor = nil
        ripple.strokeColor = accent
        ripple.lineWidth = 2
        ripple.opacity = 0
        layer?.addSublayer(ripple)

        // Small action label that trails the cursor ("点击 导入"), so the user can
        // read what the agent is doing at the point of action, not just in a HUD.
        labelBubble.fillColor = NSColor(srgbRed: 0.06, green: 0.08, blue: 0.14, alpha: 0.92).cgColor
        labelBubble.strokeColor = NSColor(srgbRed: 0.30, green: 0.72, blue: 1, alpha: 0.55).cgColor
        labelBubble.lineWidth = 1
        labelBubble.opacity = 0
        labelText.font = CGFont("SFPro-Medium" as CFString) ?? CGFont("Helvetica" as CFString)
        labelText.fontSize = 11
        labelText.foregroundColor = NSColor.white.cgColor
        labelText.alignmentMode = .center
        labelText.contentsScale = 2
        labelText.opacity = 0
        layer?.addSublayer(labelBubble)
        layer?.addSublayer(labelText)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layoutAura()
        for layer in [arrow, arrowGlow, ripple] { layer.frame = bounds }
        CATransaction.commit()
    }

    private func installAura() {
        auraContainer.opacity = 0
        layer?.addSublayer(auraContainer)
        auraContainer.addSublayer(auraBreath)
        let clear = NSColor.clear.cgColor
        let blue = NSColor(srgbRed: 0.24, green: 0.55, blue: 1, alpha: 0.10).cgColor
        let cyan = NSColor(srgbRed: 0.30, green: 0.85, blue: 0.98, alpha: 0.20).cgColor
        let violet = NSColor(srgbRed: 0.60, green: 0.44, blue: 1, alpha: 0.28).cgColor
        // One band per edge; location 0 is the inner (transparent) side, 1 the
        // screen edge. Four linear gradients stay on the border by construction,
        // unlike the radial version this replaces.
        let specs: [(CGPoint, CGPoint)] = [
            (CGPoint(x: 0.5, y: 0), CGPoint(x: 0.5, y: 1)),   // top
            (CGPoint(x: 0.5, y: 1), CGPoint(x: 0.5, y: 0)),   // bottom
            (CGPoint(x: 1, y: 0.5), CGPoint(x: 0, y: 0.5)),   // left
            (CGPoint(x: 0, y: 0.5), CGPoint(x: 1, y: 0.5)),   // right
        ]
        for (start, end) in specs {
            let band = CAGradientLayer()
            band.colors = [clear, blue, cyan, violet]
            band.locations = [0, 0.45, 0.8, 1]
            band.startPoint = start
            band.endPoint = end
            auraBreath.addSublayer(band)
            auraBands.append(band)
        }
        // Slow breathing so the rim reads as "alive" without drawing attention.
        let breath = CABasicAnimation(keyPath: "opacity")
        breath.fromValue = 0.55
        breath.toValue = 1.0
        breath.duration = 1.8
        breath.autoreverses = true
        breath.repeatCount = .infinity
        breath.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        auraBreath.add(breath, forKey: "breath")
        layoutAura()
    }

    private func layoutAura() {
        auraContainer.frame = bounds
        auraBreath.frame = bounds
        let bandWidth = min(Self.auraBandWidth, min(bounds.width, bounds.height) * 0.10)
        let w = bounds.width
        let h = bounds.height
        for (index, band) in auraBands.enumerated() {
            switch index {
            case 0: band.frame = CGRect(x: 0, y: h - bandWidth, width: w, height: bandWidth)
            case 1: band.frame = CGRect(x: 0, y: 0, width: w, height: bandWidth)
            case 2: band.frame = CGRect(x: 0, y: 0, width: bandWidth, height: h)
            default: band.frame = CGRect(x: w - bandWidth, y: 0, width: bandWidth, height: h)
            }
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layoutAura()
        for layer in [arrow, arrowGlow, ripple] { layer.frame = bounds }
        CATransaction.commit()
    }

    // Each shape layer is full-screen with a path in *view* coordinates
    // (bottom-left origin, matching the flipped view). We move the path, not the
    // layer position, so the tip lands exactly on the requested global point.
    private func arrowPath(at p: CGPoint) -> CGPath {
        let path = CGMutablePath()
        // p is already in view coordinates (bottom-left origin).
        let pts = [
            CGPoint(x: 0, y: -22), CGPoint(x: 0, y: 0), CGPoint(x: 16, y: -12),
            CGPoint(x: 8.5, y: -13), CGPoint(x: 13, y: -21), CGPoint(x: 10, y: -22.5),
            CGPoint(x: 5.5, y: -14.5),
        ].map { CGPoint(x: p.x + $0.x, y: p.y + $0.y) }
        path.addLines(between: pts)
        path.closeSubpath()
        return path
    }

    /// Global origin of the overlay window (the union of all displays).
    var overlayOrigin: CGPoint = .zero
    /// Top edge of the main display in Cocoa coordinates. Global top-left points
    /// are measured from there, so the mapping needs it rather than bounds.height:
    /// with two displays the union is taller than the main screen.
    var mainScreenTop: CGFloat = 0

    private func viewPoint(_ global: CGPoint) -> CGPoint {
        CGPoint(x: global.x - overlayOrigin.x,
                y: mainScreenTop - global.y - overlayOrigin.y)
    }

    func showCursor(at point: CGPoint, glide: Bool) {
        let target = viewPoint(point)
        let first = !hasShownCursor
        hasShownCursor = true
        arrow.opacity = 1
        arrowGlow.opacity = 1
        let next = arrowPath(at: target)
        // The first appearance lands directly on the target (no fly-in from the
        // origin); later moves may glide.
        if glide && !first && !reduceMotion {
            let anim = CABasicAnimation(keyPath: "path")
            // Continue from what is on screen. Animating from the model value
            // makes a fast batch look like it jumps backwards on every step.
            anim.fromValue = arrow.presentation()?.path ?? arrow.path
            anim.toValue = next
            anim.duration = Self.glideDuration
            anim.timingFunction = CAMediaTimingFunction(name: .easeOut)
            for shape in [arrow, arrowGlow] { shape.add(anim, forKey: "glide") }
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        arrow.path = next
        arrowGlow.path = next
        CATransaction.commit()
    }

    /// Coalesce rapid cursor moves: only the newest target is applied, so ten
    /// quick targets leave the cursor at the last one (Task 5).
    func scheduleCursor(at point: CGPoint, glide: Bool = true) {
        pendingCursorTarget = point
        pendingCursorGlide = glide
        if coalesceScheduled {
            droppedCursorCount = min(Self.visualQueueLimit, droppedCursorCount + 1)
            return
        }
        coalesceScheduled = true
        DispatchQueue.main.async { [weak self] in self?.flushScheduledCursor() }
    }

    func flushScheduledCursor() {
        coalesceScheduled = false
        guard let target = pendingCursorTarget else { return }
        pendingCursorTarget = nil
        showCursor(at: target, glide: pendingCursorGlide)
        appliedCursorCount += 1
    }

    /// Runtime Reduce-Motion: turning it on drops every running animation so a
    /// glide/breath/ripple already in flight does not keep moving (Task 5).
    func setReduceMotion(_ on: Bool) {
        reduceMotion = on
        guard on else { return }
        for shape in [arrow, arrowGlow, ripple, labelBubble, labelText, auraBreath] {
            shape.removeAllAnimations()
        }
    }

    func animationKeyCountForTesting() -> Int {
        (arrow.animationKeys()?.count ?? 0)
            + (auraBreath.animationKeys()?.count ?? 0)
            + (ripple.animationKeys()?.count ?? 0)
    }

    /// Grapheme-safe truncation: `prefix` counts Characters (user-perceived
    /// grapheme clusters), so an emoji or combining sequence is never split.
    static func clampLabel(_ text: String, max: Int = 28) -> String {
        String(text.prefix(max))
    }

    /// Timings measured against the previous 280 ms glide / 500 ms ripple: a
    /// click should read as one quick gesture, not a slow tour of the desktop.
    static let glideDuration: CFTimeInterval = 0.14
    static let rippleDuration: CFTimeInterval = 0.24

    /// macOS "Reduce Motion", plus an explicit override for reviewers who want a
    /// static overlay. Re-read on the system notification, not per frame.
    var reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        || ProcessInfo.processInfo.environment["CU_REDUCE_MOTION"] == "1"

    /// Persistent rim state (F6). The edge rim is a demo aid and is OFF by
    /// default in daily use. `setAura(false)` must stick: later cursor/click/label
    /// events may not re-light it. `setAura(true)` (demo mode) re-arms it.
    var rimEnabled = false

    func refreshMotionPreference() {
        reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
            || ProcessInfo.processInfo.environment["CU_REDUCE_MOTION"] == "1"
    }

    /// Show a short action label just below-right of the cursor tip.
    func showLabel(_ text: String, at point: CGPoint) {
        guard !text.isEmpty else {
            CATransaction.begin(); CATransaction.setDisableActions(true)
            labelBubble.opacity = 0; labelText.opacity = 0
            CATransaction.commit()
            return
        }
        let p = viewPoint(point)
        let display = Self.clampLabel(text)
        let font = NSFont.systemFont(ofSize: 11, weight: .medium)
        let width = (display as NSString).size(withAttributes: [.font: font]).width + 16
        let height: CGFloat = 20
        // Cursor tip is at p; place the chip below-right so it never covers it.
        // Keep the chip on screen even for a control near an edge, and clear of
        // the control itself so the next click target is never covered.
        let clampedX = min(max(p.x + 12, 4), max(4, bounds.width - width - 4))
        let clampedY = min(max(p.y - 30, 4), max(4, bounds.height - height - 4))
        let rect = CGRect(x: clampedX, y: clampedY, width: width, height: height)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let oldPath = labelBubble.path
        labelBubble.path = CGPath(roundedRect: rect, cornerWidth: 6, cornerHeight: 6, transform: nil)
        labelText.string = display
        labelText.frame = CGRect(x: rect.minX, y: rect.minY + 4, width: rect.width, height: 14)
        labelBubble.opacity = 1
        labelText.opacity = 1
        CATransaction.commit()
        if oldPath != nil {
            let grow = CABasicAnimation(keyPath: "opacity")
            grow.fromValue = 0.4
            grow.toValue = 1
            grow.duration = reduceMotion ? 0.05 : 0.12
            labelBubble.add(grow, forKey: "fade")
            labelText.add(grow, forKey: "fade")
        }
    }

    func clickRipple(at point: CGPoint) {
        let c = viewPoint(point)
        let small = CGPath(ellipseIn: CGRect(x: c.x - 4, y: c.y - 4, width: 8, height: 8),
                           transform: nil)
        let large = CGPath(ellipseIn: CGRect(x: c.x - 26, y: c.y - 26, width: 52, height: 52),
                           transform: nil)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        ripple.path = large
        ripple.opacity = 0
        CATransaction.commit()
        let expand = CABasicAnimation(keyPath: "path")
        expand.fromValue = small
        expand.toValue = large
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.95
        fade.toValue = 0
        for animation in [expand, fade] {
            animation.duration = reduceMotion ? 0.1 : Self.rippleDuration
            animation.timingFunction = CAMediaTimingFunction(name: .easeOut)
        }
        ripple.add(expand, forKey: "expand")
        ripple.add(fade, forKey: "fade")
    }

    func noteActivity() {
        lastActivityAt = Date()
    }

    /// Light the edge rim for a moment whenever the agent acts. It fades on its
    /// own, so the desktop is never permanently tinted.
    func pulseAura() {
        lastActivityAt = Date()
        // F6: a disabled rim must stay disabled. Every cursor/click/label used to
        // call pulseAura unconditionally, re-lighting a rim the user turned off.
        guard rimEnabled else { return }
        auraHideWork?.cancel()
        if auraContainer.opacity < 0.99 {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = auraContainer.opacity
            fade.toValue = 1.0
            fade.duration = 0.25
            fade.timingFunction = CAMediaTimingFunction(name: .easeOut)
            auraContainer.add(fade, forKey: "show")
            auraContainer.opacity = 1.0
            CATransaction.commit()
        }
        let work = DispatchWorkItem { [weak self] in self?.fadeAura() }
        auraHideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.auraIdleFade, execute: work)
    }

    func fadeAura() {
        auraHideWork?.cancel()
        auraHideWork = nil
        guard auraContainer.opacity > 0 else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = auraContainer.opacity
        fade.toValue = 0
        fade.duration = 0.5
        fade.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        auraContainer.add(fade, forKey: "hide")
        auraContainer.opacity = 0
        CATransaction.commit()
    }

    /// Session start arms or disables the rim. A disabled rim is a persistent
    /// renderer state, not a one-off fade (F6).
    func setAura(_ visible: Bool) {
        rimEnabled = visible
        if !visible { fadeAura() }
    }

    func hide() {
        for layer in [arrow, arrowGlow] {
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = layer.opacity
            fade.toValue = 0
            fade.duration = 0.2
            layer.add(fade, forKey: "hide")
            layer.opacity = 0
        }
    }
}

// MARK: - per-display geometry (Task 5)

/// A display in Cocoa coordinates (bottom-left origin). Global input points are
/// top-left origin anchored on the main display, so the mapping needs `mainTop`.
struct ScreenSpec {
    var originX: CGFloat
    var originY: CGFloat
    var width: CGFloat
    var height: CGFloat
}

/// The display's frame expressed in the global TOP-LEFT coordinate space the
/// engine reports points in. Screens can have negative origins and vertical
/// offsets; each is handled independently, never via the union of all screens.
func screenTopLeftFrame(_ screen: ScreenSpec, mainTop: CGFloat) -> CGRect {
    CGRect(x: screen.originX,
           y: mainTop - (screen.originY + screen.height),
           width: screen.width,
           height: screen.height)
}

/// Which display contains a global top-left point, or nil when it falls in a gap
/// between displays (so a stale cursor is never drawn onto the wrong screen).
func screenIndex(forGlobal point: CGPoint, screens: [ScreenSpec], mainTop: CGFloat) -> Int? {
    for (index, screen) in screens.enumerated() {
        if screenTopLeftFrame(screen, mainTop: mainTop).contains(point) { return index }
    }
    return nil
}

/// Convert a global top-left point into a display's local Cocoa point.
func localPoint(global: CGPoint, screen: ScreenSpec, mainTop: CGFloat) -> CGPoint {
    CGPoint(x: global.x - screen.originX, y: mainTop - global.y - screen.originY)
}
