// ConsoleWindow — the borderless vibrancy control panel and its controller.
//
// One window, five pages, in-window navigation (back chevron on sub-pages) and a
// pinned footer. Built lazily on first show, like the reference implementation,
// and it never activates the app unless it is explicitly opened by the user.

import AppKit

final class CUConsoleWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

final class CUConsoleController: NSObject, NSWindowDelegate {
    // Data and actions owned by the menu-bar controller.
    var onRefresh: (() -> Void)?
    var onPauseToggle: (() -> Void)?
    var onOpenPermission: ((String) -> Void)?          // "accessibility" | "screenRecording"
    var onConnectAll: (() -> Void)?
    var onToggleAgent: ((String, Bool) -> Void)?
    var onRestartService: (() -> Void)?
    var onRelaunchApp: (() -> Void)?
    var onSaveSettings: ((CUConsoleSettings) -> Void)?
    var onOpenConfigFile: (() -> Void)?
    var onOpenServiceLog: (() -> Void)?
    var onCopyDiagnostics: (() -> Void)?
    var onCopyConfiguration: (() -> Void)?
    var onWindowClosed: (() -> Void)?
    var settingsProvider: (() -> CUConsoleSettings)?
    var configurationTextProvider: (() -> String)?
    var versionProvider: (() -> String)?

    private(set) var window: CUConsoleWindow?
    /// Actual window height: 780 unless the display's visible frame is shorter.
    private var windowHeight: CGFloat = CUI.height
    private var pageHeight: CGFloat { windowHeight - CUI.footerHeight }
    private var material: NSVisualEffectView?
    private var host: CUFlippedView?
    private var footer: CUFooter?
    private var closeButton: NSButton?
    private var backButton: NSButton?
    private var guide: CUGuidePanel?
    private var model = CUConsoleModel()
    private(set) var currentPage: CUConsolePage = .overview

    private let overviewPage = CUOverviewPage(frame: .zero)
    private lazy var connectionsPage = CUConnectionsPage(frame: .zero)
    private lazy var settingsPage = CUSettingsPage(frame: .zero)
    private lazy var diagnosticsPage = CUDiagnosticsPage(frame: .zero)
    private lazy var agentSetupPage = CUAgentSetupPage(frame: .zero)
    private var scrolls: [CUConsolePage: NSScrollView] = [:]
    private var pageViews: [CUConsolePage: CUFlippedView] = [:]

    var isVisible: Bool { window?.isVisible ?? false }

    override init() {
        super.init()
        overviewPage.onOpenPermission = { [weak self] pane in self?.onOpenPermission?(pane) }
        overviewPage.onConnectAll = { [weak self] in self?.onConnectAll?() }
        overviewPage.onToggleAgent = { [weak self] id, enabled in self?.onToggleAgent?(id, enabled) }
        overviewPage.onRestartService = { [weak self] in self?.onRestartService?() }
        overviewPage.onRefreshRequested = { [weak self] in self?.onRefresh?() }
        overviewPage.onShowPage = { [weak self] page in self?.show(page: page) }
        connectionsPage.onRefreshRequested = { [weak self] in self?.onRefresh?() }
        settingsPage.onSave = { [weak self] settings in self?.onSaveSettings?(settings) }
        settingsPage.onOpenConfigFile = { [weak self] in self?.onOpenConfigFile?() }
        settingsPage.onOpenSystemSettings = { [weak self] in
            self?.onOpenPermission?("accessibility")
        }
        diagnosticsPage.onRefreshRequested = { [weak self] in self?.onRefresh?() }
        diagnosticsPage.onOpenServiceLog = { [weak self] in self?.onOpenServiceLog?() }
        diagnosticsPage.onCopyDiagnostics = { [weak self] in self?.onCopyDiagnostics?() }
        agentSetupPage.configurationTextProvider = { [weak self] in
            self?.configurationTextProvider?() ?? ""
        }
        agentSetupPage.onCopyConfiguration = { [weak self] in self?.onCopyConfiguration?() }
    }

    // MARK: window

    @discardableResult
    private func ensureWindow() -> CUConsoleWindow {
        if let window { return window }
        // A 780 pt panel does not fit every display; shrink to the visible frame
        // (pages already scroll) and never let the footer go off-screen.
        var targetHeight = CUI.height
        if let screen = NSScreen.main {
            targetHeight = min(targetHeight, screen.visibleFrame.height)
        }
        windowHeight = targetHeight
        let window = CUConsoleWindow(
            contentRect: CUIRect(0, 0, CUI.width, targetHeight),
            styleMask: [.borderless],
            backing: .buffered, defer: false)
        window.title = "DSH Super Computer Use"
        window.isReleasedWhenClosed = false
        window.backgroundColor = .clear
        window.isOpaque = false
        window.hasShadow = true
        window.isMovableByWindowBackground = true
        window.delegate = self
        window.center()
        if let screen = NSScreen.main {
            let visible = screen.visibleFrame
            var frame = window.frame
            frame.origin.x = max(visible.minX, min(frame.origin.x, visible.maxX - frame.width))
            frame.origin.y = max(visible.minY, min(frame.origin.y, visible.maxY - frame.height))
            window.setFrame(frame, display: false)
        }

        let material = NSVisualEffectView(frame: CUIRect(0, 0, CUI.width, CUI.height))
        material.material = .underWindowBackground
        material.blendingMode = .behindWindow
        material.state = .active
        material.wantsLayer = true
        material.layer?.cornerRadius = CUI.controlWindowRadius
        material.layer?.masksToBounds = true
        material.layer?.borderWidth = 0.7
        material.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.28).cgColor
        window.contentView = material
        self.material = material
        // The material view is not flipped; everything inside the console is laid
        // out top-left, so a flipped root owns the content.
        let root = CUFlippedView(frame: CUIRect(0, 0, CUI.width, CUI.height))
        root.autoresizingMask = [.width, .height]
        material.addSubview(root)

        let host = CUFlippedView(frame: CUIRect(0, 0, CUI.width, windowHeight - CUI.footerHeight))
        root.addSubview(host)
        self.host = host

        let footer = CUFooter(width: CUI.width)
        footer.frame = CUIRect(0, windowHeight - CUI.footerHeight, CUI.width, CUI.footerHeight)
        footer.onPauseToggle = { [weak self] in self?.onPauseToggle?() }
        footer.onShowPage = { [weak self] page in self?.show(page: page) }
        root.addSubview(footer)
        self.footer = footer

        let close = CUIIconButton("xmark", label: "关闭控制台", target: self, action: #selector(closeTapped))
        close.frame = CUIRect(CUI.width - 42, 15, 27, 27)
        root.addSubview(close)
        closeButton = close

        let back = CUIIconButton("chevron.left", label: "返回", target: self,
                                 action: #selector(backTapped))
        back.frame = CUIRect(16, 16, 27, 27)
        back.isHidden = true
        root.addSubview(back)
        backButton = back

        self.window = window
        return window
    }

    @objc private func closeTapped() { window?.close() }

    /// Closing the console must hand focus back: this process owns no other
    /// window, and an active app with no windows would swallow the user's typing.
    func windowWillClose(_ notification: Notification) {
        onWindowClosed?()
    }
    @objc private func backTapped() { show(page: .overview) }

    // MARK: pages

    private func pageView(for page: CUConsolePage) -> CUFlippedView {
        if let cached = pageViews[page] { return cached }
        let view: CUFlippedView
        switch page {
        case .overview: view = overviewPage
        case .connections: view = connectionsPage
        case .settings: view = settingsPage
        case .diagnostics: view = diagnosticsPage
        case .agentSetup: view = agentSetupPage
        }
        let scroll = NSScrollView(frame: CUIRect(0, 0, CUI.width, pageHeight))
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.verticalScrollElasticity = .allowed
        scroll.documentView = view
        scroll.isHidden = true
        host?.addSubview(scroll)
        scrolls[page] = scroll
        pageViews[page] = view
        return view
    }

    private func height(for page: CUConsolePage) -> CGFloat {
        switch page {
        case .overview: return max(pageHeight, overviewPage.contentHeight)
        case .connections: return max(pageHeight, connectionsPage.contentHeight)
        case .settings: return 700
        case .diagnostics: return 700
        case .agentSetup: return 660
        }
    }

    func show(page: CUConsolePage, activate: Bool = true) {
        let window = ensureWindow()
        _ = pageView(for: page)
        footer?.update(version: model.version, paused: model.paused)
        currentPage = page
        if page == .settings {
            settingsPage.load(settingsProvider?() ?? CUConsoleSettings())
        }
        if page == .agentSetup {
            agentSetupPage.refresh()
        }
        refresh(page: page)
        for (candidate, scroll) in scrolls {
            scroll.isHidden = candidate != page
        }
        backButton?.isHidden = page == .overview
        if activate {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        } else {
            window.orderFrontRegardless()
        }
    }

    func hide() {
        window?.orderOut(nil)
        onWindowClosed?()
    }

    private func refresh(page: CUConsolePage) {
        guard let view = pageViews[page] else { return }
        switch page {
        case .overview:
            overviewPage.refresh(model)
        case .connections:
            connectionsPage.refresh(model)
        case .diagnostics:
            diagnosticsPage.refresh(model)
        case .agentSetup:
            agentSetupPage.refresh()
        case .settings:
            break
        }
        let pageHeight = height(for: page)
        view.frame = CUIRect(0, 0, CUI.width, pageHeight)
        scrolls[page]?.documentView?.setFrameSize(NSSize(width: CUI.width, height: pageHeight))
    }

    func update(model: CUConsoleModel) {
        self.model = model
        footer?.update(version: model.version, paused: model.paused)
        if window == nil { return }
        for page in CUConsolePage.allCases where pageViews[page] != nil {
            refresh(page: page)
        }
        if model.accessibility && model.screenRecording {
            guide?.orderOut(nil)
        }
    }

    /// Dev/test hook: render the floating permission guide to a PNG without
    /// opening System Settings, so the guide can be checked without breaking a
    /// real grant.
    func captureGuideSnapshot(to path: String) -> [String: Any] {
        showPermissionGuide(screenRecording: false)
        guard let panel = guide, let view = panel.contentView else {
            return ["ok": false, "error": "no_guide"]
        }
        panel.displayIfNeeded()
        view.layoutSubtreeIfNeeded()
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
            return ["ok": false, "error": "no_bitmap"]
        }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let data = rep.representation(using: .png, properties: [:]) else {
            return ["ok": false, "error": "no_png"]
        }
        do {
            try data.write(to: URL(fileURLWithPath: path))
        } catch {
            return ["ok": false, "error": "\(error)"]
        }
        return ["ok": true, "path": path, "via": "panel-bitmap",
                "width": rep.pixelsWide, "height": rep.pixelsHigh]
    }

    func showPermissionGuide(screenRecording: Bool) {
        if guide == nil {
            let panel = CUGuidePanel()
            panel.onRelaunch = { [weak self] in self?.onRelaunchApp?() }
            guide = panel
        }
        guide?.present(screenRecording: screenRecording)
    }

    // MARK: snapshots & selftest

    /// Render the visible console window to a PNG. Prefers a real window capture
    /// (ScreenCaptureKit) so vibrancy is in the image; falls back to a view bitmap.
    func captureSnapshot(to path: String) -> [String: Any] {
        let window = ensureWindow()
        window.displayIfNeeded()
        window.contentView?.layoutSubtreeIfNeeded()
        let pid = ProcessInfo.processInfo.processIdentifier
        var windowId: CGWindowID?
        for _ in 0..<20 {
            if let info = onScreenWindows().first(where: { $0.pid == pid }) {
                windowId = info.id
                break
            }
            usleep(100_000)
        }
        if let windowId, #available(macOS 14.0, *) {
            do {
                let shot = try capture(windowId: windowId, screen: false,
                                       displayIndex: 0, maxDimension: 0, timeout: 12)
                try shot.png.write(to: URL(fileURLWithPath: path))
                return ["ok": true, "path": path, "via": "screencapturekit",
                        "windowId": Int(windowId),
                        "windowKey": window.isKeyWindow,
                        "switchOn": overviewPage.switchOnCount,
                        "switchTotal": overviewPage.agentRowCount,
                        "width": Int((shot.size.width * shot.scale).rounded()),
                        "height": Int((shot.size.height * shot.scale).rounded())]
            } catch {
                // Fall through to the bitmap path; the caller still gets evidence.
            }
        }
        if let view = window.contentView,
           let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
            view.cacheDisplay(in: view.bounds, to: rep)
            if let data = rep.representation(using: .png, properties: [:]) {
                try? data.write(to: URL(fileURLWithPath: path))
                return ["ok": true, "path": path, "via": "bitmap",
                        "width": rep.pixelsWide, "height": rep.pixelsHigh]
            }
        }
        return ["ok": false, "error": "capture_failed", "path": path]
    }

    func selftestReport() -> [String: Any] {
        _ = ensureWindow()
        // Materialise every page so the report describes what a user would get,
        // not only the pages visited so far.
        for page in CUConsolePage.allCases { _ = pageView(for: page) }
        update(model: model)
        var report: [String: Any] = [
            "ok": true,
            "pages": CUConsolePage.allCases.map { $0.rawValue },
            "pageCount": CUConsolePage.allCases.count,
            "windowBorderless": window?.styleMask.contains(.borderless) ?? false,
            "windowVisible": window?.isVisible ?? false,
            "materialInstalled": material != nil,
            "footerInstalled": footer != nil,
            "permissionRows": 2,
            "agentRows": overviewPage.agentRowCount,
            "agentSwitchCount": overviewPage.switchCount,
            "configurationContainsMCPServers": agentSetupPage.configuredText.contains("mcpServers"),
            "version": versionProvider?() ?? "dev",
        ]
        // Every nav target must be reachable from the footer without a menu.
        report["footerPageTargets"] = ["connections", "diagnostics", "settings"]
        if let window {
            report["windowWidth"] = Int(window.frame.width)
            report["windowHeight"] = Int(window.frame.height)
        }
        return report
    }
}
