import AppKit
final class Delegate: NSObject, NSApplicationDelegate {
    var panel: NSPanel!
    func applicationDidFinishLaunching(_ notification: Notification) {
        panel = NSPanel(contentRect: NSRect(x: 380, y: 360, width: 140, height: 120), styleMask: [.titled], backing: .buffered, defer: false)
        panel.title = "CU Foreign Float"
        panel.level = .floating
        panel.isReleasedWhenClosed = false
        panel.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Delegate()
app.delegate = delegate
app.run()
