// Low-impact macOS fixture for Computer Use acceptance tests. It is not a
// product component: two instances provide owned windows with an AX button, an
// AX text field, and a custom view that only reacts to PID-targeted mouse
// events (no AXPress). All state is local and process-owned.
import AppKit

final class CanvasView: NSView {
    var count = 0
    var status: NSTextField?
    var onMouseDown: ((NSEvent) -> Void)?
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill()
        dirtyRect.fill()
        NSColor.controlAccentColor.setStroke()
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 2, dy: 2), xRadius: 8, yRadius: 8)
        path.lineWidth = 2
        path.stroke()
        let text = "Click canvas (count \(count))" as NSString
        text.draw(at: NSPoint(x: 12, y: 12), withAttributes: [
            .font: NSFont.systemFont(ofSize: 13),
            .foregroundColor: NSColor.labelColor,
        ])
    }
    override func mouseDown(with event: NSEvent) {
        logPaintEvent("down")
        onMouseDown?(event)
        count += 1
        status?.stringValue = "Canvas \(count)"
        needsDisplay = true
    }
    override func mouseUp(with event: NSEvent) { logPaintEvent("up") }
    private func logPaintEvent(_ event: String) {
        guard let path = ProcessInfo.processInfo.environment["CU_PAINT_EVENT_LOG"], let data = "\(event)\n".data(using: .utf8) else { return }
        if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
        guard let handle = FileHandle(forWritingAtPath: path) else { return }
        handle.seekToEndOfFile(); handle.write(data); try? handle.close()
    }
    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .group }
    override func accessibilityLabel() -> String? { "Canvas Surface" }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var button: NSButton!
    var field: NSTextField!
    var canvas: CanvasView!
    var status: NSTextField!
    var count = 0
    var paintObstacle: NSPanel?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let label = ProcessInfo.processInfo.environment["CU_ACCEPT_LABEL"] ?? "Target"
        let x = Double(ProcessInfo.processInfo.environment["CU_ACCEPT_X"] ?? "80") ?? 80
        let y = Double(ProcessInfo.processInfo.environment["CU_ACCEPT_Y"] ?? "120") ?? 120

        let frame = NSRect(x: x, y: y, width: 420, height: 320)
        window = NSWindow(contentRect: frame, styleMask: [.titled, .closable],
                          backing: .buffered, defer: false)
        window.title = "CU Acceptance \(label)"
        window.isReleasedWhenClosed = false

        let content = NSView(frame: NSRect(x: 0, y: 0, width: 420, height: 320))
        window.contentView = content

        button = NSButton(title: "Acceptance Button 0", target: self, action: #selector(pressButton))
        button.frame = NSRect(x: 20, y: 270, width: 220, height: 30)
        button.bezelStyle = .rounded
        content.addSubview(button)

        field = NSTextField(frame: NSRect(x: 20, y: 230, width: 360, height: 26))
        field.placeholderString = "Acceptance Field"
        field.setAccessibilityLabel("Acceptance Field")
        content.addSubview(field)

        canvas = CanvasView(frame: NSRect(x: 20, y: 70, width: 360, height: 140))
        content.addSubview(canvas)

        status = NSTextField(labelWithString: "Canvas 0")
        status.frame = NSRect(x: 20, y: 35, width: 360, height: 22)
        status.setAccessibilityLabel("Canvas Status")
        content.addSubview(status)
        canvas.status = status
        if ProcessInfo.processInfo.environment["CU_PAINT_DYNAMIC_OBSTACLE"] == "1" {
            canvas.onMouseDown = { [weak self] event in
                guard let self, self.paintObstacle == nil else { return }
                let point = self.window.convertPoint(toScreen: NSPoint(x: event.locationInWindow.x + 90, y: event.locationInWindow.y - 30))
                let panel = NSPanel(contentRect: NSRect(x: point.x, y: point.y, width: 80, height: 60), styleMask: [.titled], backing: .buffered, defer: false)
                panel.title = "CU Dynamic Obstacle"
                panel.level = .floating
                panel.orderFrontRegardless()
                self.paintObstacle = panel
            }
        }

        window.orderFrontRegardless()
        if ProcessInfo.processInfo.environment["CU_ACCEPT_FOREGROUND"] == "1" {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        NSApp.run()
    }

    @objc func pressButton() {
        count += 1
        button.title = "Acceptance Button \(count)"
    }
}

let app = NSApplication.shared
app.setActivationPolicy(ProcessInfo.processInfo.environment["CU_ACCEPT_FOREGROUND"] == "1" ? .regular : .accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
