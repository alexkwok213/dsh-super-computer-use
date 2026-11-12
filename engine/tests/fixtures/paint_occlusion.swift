import AppKit
final class Delegate: NSObject, NSApplicationDelegate {
    var canvas: NSWindow!
    var panel: NSWindow!
    func applicationDidFinishLaunching(_ notification: Notification) {
        canvas = NSWindow(contentRect: NSRect(x: 200, y: 260, width: 500, height: 340), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        canvas.title = "CU Paint Target"
        canvas.isReleasedWhenClosed = false
        canvas.orderFrontRegardless()
        if ProcessInfo.processInfo.environment["CU_NO_PANEL"] == "1" { canvas.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return }
        let floating = ProcessInfo.processInfo.environment["CU_PANEL"] == "1"
        let panelType: NSWindow.Type = floating ? NSPanel.self : NSWindow.self
        panel = panelType.init(contentRect: NSRect(x: 380, y: 360, width: 140, height: 120), styleMask: [.titled], backing: .buffered, defer: false)
        panel.title = "CU Paint Obstacle"
        panel.isReleasedWhenClosed = false
        panel.orderFrontRegardless()
        if floating { NSApp.activate(ignoringOtherApps: true) }
    }
}
let app = NSApplication.shared
app.setActivationPolicy((ProcessInfo.processInfo.environment["CU_PANEL"] == "1" || ProcessInfo.processInfo.environment["CU_CURSOR"] == "1") ? .regular : .accessory)
let delegate = Delegate()
app.delegate = delegate
app.run()
