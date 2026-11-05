// ConsoleApp — the menu-bar host for the Computer Use control panel.
//
// Replaces the old tabbed NSTabView console. The menu-bar item, status menu,
// pause latch, agent config writers, permission prompts and diagnostics stay
// here; everything visual lives in ConsoleKit/ConsolePages/ConsoleWindow.

import AppKit
import ApplicationServices
import CoreGraphics

// MARK: - shared strings & helpers

func appVersion() -> String {
    (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0.1.0"
}

func mcpConfigurationJSON() -> String {
    let object: [String: Any] = ["mcpServers": ["computer-use": agentMCPEntry(name: "computer-use")]]
    guard let data = try? JSONSerialization.data(
        withJSONObject: object,
        options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]),
        let text = String(data: data, encoding: .utf8) else { return "{}" }
    return text
}

func mcpConfigurationText() -> String {
    let entry = agentMCPEntry(name: "computer-use")
    let command = entry["command"] as? String ?? "/usr/bin/python3"
    let args = (entry["args"] as? [String] ?? []).joined(separator: " ")
    return """
    将以下 MCP Server 添加到你的 agent：

    Name: computer-use
    Type: stdio
    Command: \(command)
    Args: \(args)

    JSON:
    \(mcpConfigurationJSON())

    配置完成后重新加载 MCP，或开始新的会话即可使用。
    """
}

func copyToPasteboard(_ text: String) {
    let board = NSPasteboard.general
    board.clearContents()
    board.setString(text, forType: .string)
}

/// Reset one privacy grant for our own bundle id. Used only when a grant is
/// missing AND the tccd log proves it is a stale code-requirement record.
func resetTCCPermission(_ service: String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/tccutil")
    process.arguments = ["reset", service, "local.cu.app"]
    try? process.run()
    process.waitUntilExit()
}

/// Reference behavior: when a grant is missing, look for the classic stale-TCC
/// symptom (a code-requirement mismatch after an ad-hoc rebuild) and repair it
/// once, then re-prompt. Never touches a working grant.
func healStalePermissionsIfNeeded() {
    if AXIsProcessTrusted() && CGPreflightScreenCaptureAccess() { return }
    DispatchQueue.global(qos: .utility).async {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/log")
        process.arguments = [
            "show", "--last", "5m", "--predicate",
            "process == \"tccd\" AND eventMessage CONTAINS \"local.cu.app\"",
        ]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard let output = String(data: data, encoding: .utf8),
              output.contains("Failed to match existing code requirement") else { return }
        DispatchQueue.main.async {
            var didReset = false
            if output.contains("kTCCServiceAccessibility") && !AXIsProcessTrusted() {
                resetTCCPermission("Accessibility")
                didReset = true
            }
            if output.contains("kTCCServiceScreenCapture") && !CGPreflightScreenCaptureAccess() {
                resetTCCPermission("ScreenCapture")
                didReset = true
            }
            if didReset { requestPermissionsIfMissing() }
        }
    }
}

// MARK: - menu bar controller

final class MenuBarController: NSObject, NSApplicationDelegate {
    private var item: NSStatusItem!
    private var timer: Timer?
    private var serviceState = "未知"
    private var serviceRunning = false
    private var accessibility = false
    private var screenRecording = false
    private var statusCache: [String: Any] = [:]
    private var clientsCache: [String: Any] = [:]
    private var clientRows: [[String: Any]] = []
    private var usageRows: [[String: Any]] = []
    private var agentRows: [[String: Any]] = []
    private var console: CUConsoleController?
    private let screenIndicator = ScreenRecordingIndicator()
    private var screenIndicatorOn = false
    private var screenIndicatorTimer: Timer?
    private var lastFrontPid: pid_t = 0
    private var busyAgents: Set<String> = []
    private var firstRefreshDone = false

    var openSettingsAtLaunch = false
    var openMenuAtLaunch = false
    var openConsoleAtLaunch = false
    var snapshotPath: String?
    var snapshotPage: String?
    var guideSnapshotPath: String?
    var selftestMode = false
    private var snapshotStarted = false
    private var selftestStarted = false
    var launchFrontPid: pid_t = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Menu-bar only: the bundle launches a script that execs the external
        // binary, so the process has no bundle identity and cannot own a Dock icon.
        NSApp.setActivationPolicy(.accessory)
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = nil
        item.button?.imagePosition = .noImage
        buildConsole()
        rebuildMenu()
        refresh()
        // Publish the starting state so `cu screen-indicator --state off` reads as
        // applied even when the app was already idle: the stream dies with the
        // previous process, and a listener that never wrote a file is
        // indistinguishable from one that is not running at all.
        writeScreenIndicatorState(active: screenIndicatorOn)
        timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name("local.cu.showConsole"), object: nil, queue: .main
        ) { [weak self] _ in
            self?.showConsole(nil)
        }
        DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name("local.cu.handover"), object: nil, queue: .main
        ) { note in
            // A freshly launched app copy takes over the menu bar; retire with a
            // clean exit so the LaunchAgent (KeepAlive on failures only) stays dead.
            //
            // Ignore our own take-over note: `cu app` posts it a few milliseconds
            // before this observer exists, and distributed delivery is async, so a
            // new instance could receive its own handover and exit(0) — leaving no
            // menu bar at all, with nothing in the log to explain it.
            let from = (note.userInfo?["from"] as? NSNumber)?.int32Value ?? 0
            if from == getpid() { return }
            NSLog("menu bar: retiring for a newer instance (handover from pid %d)", from)
            exit(0)
        }
        // Serve capture requests from the CLI/service: they run where ScreenCaptureKit
        // callbacks never fire, while this app has its own Screen Recording grant.
        // The CU plugin asks the app to own a display stream for the duration of
        // a session. A real bundle process gets the system screen-recording
        // indicator; the menu-bar item mirrors that state for quick visibility.
        DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name("local.cu.screen-indicator"), object: nil, queue: .main
        ) { [weak self] note in
            let active = (note.userInfo?["active"] as? Bool) ?? false
            self?.setScreenIndicator(active)
        }
        DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name("local.cu.capture-request"), object: nil, queue: .main
        ) { note in
            guard #available(macOS 14.0, *),
                  let info = note.userInfo,
                  let requestId = info["id"] as? String,
                  let path = info["path"] as? String else { return }
            let screen = (info["screen"] as? Bool) ?? false
            let windowId = (info["windowId"] as? Int).map(CGWindowID.init)
            let maxDimension = (info["maxDimension"] as? Int) ?? 0
            DispatchQueue.global(qos: .userInitiated).async {
                var reply: [String: Any] = ["id": requestId]
                do {
                    let shot: Capture
                    do {
                        shot = try capture(windowId: windowId, screen: screen,
                                           displayIndex: 0, maxDimension: maxDimension)
                    } catch let error as NSError where error.domain == "cu" && error.code == 5 {
                        shot = try capture(windowId: windowId, screen: screen,
                                           displayIndex: 0, maxDimension: maxDimension,
                                           timeout: 12)
                    }
                    try shot.png.write(to: URL(fileURLWithPath: path))
                    reply["ok"] = true
                    reply["path"] = path
                    reply["scale"] = shot.scale
                    reply["origin"] = ["x": Double(shot.origin.x), "y": Double(shot.origin.y)]
                    reply["size"] = ["width": Double(shot.size.width),
                                     "height": Double(shot.size.height)]
                } catch {
                    reply["ok"] = false
                    reply["error"] = "capture_failed"
                    reply["message"] = error.localizedDescription
                }
                DistributedNotificationCenter.default().postNotificationName(
                    NSNotification.Name("local.cu.capture-reply"), object: nil,
                    userInfo: reply, deliverImmediately: true)
            }
        }
        // Track who else is frontmost, so an accidental activation of this
        // windowless helper can always be handed straight back.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  app.processIdentifier != getpid() else { return }
            self?.lastFrontPid = app.processIdentifier
        }
        lastFrontPid = launchFrontPid
        // `open`/LaunchServices activates a freshly launched app. This one has no
        // windows yet, so holding activation would freeze the user's typing.
        if !openSettingsAtLaunch { stayInBackground(launchFrontPid) }
        if openSettingsAtLaunch { showSettings(nil) }
        if snapshotPath == nil && guideSnapshotPath == nil && !selftestMode {
            // Missing TCC grants raise the system consent dialogs once, like Claude's.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { requestPermissionsIfMissing() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { healStalePermissionsIfNeeded() }
        }
        if openConsoleAtLaunch {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.showConsole(nil) }
        }
        if openMenuAtLaunch {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                self.item.button?.performClick(nil)
            }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // Double-clicking the app while it already runs just shows the console.
        showConsole(nil)
        return true
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        guard console?.isVisible != true, !openSettingsAtLaunch else { return }
        stayInBackground(lastFrontPid != 0 ? lastFrontPid : launchFrontPid)
    }

    // MARK: console wiring

    private func buildConsole() {
        let console = CUConsoleController()
        console.onRefresh = { [weak self] in self?.refresh() }
        console.onPauseToggle = { [weak self] in self?.togglePause() }
        console.onOpenPermission = { [weak self] pane in
            guard let self else { return }
            let screen = pane == "screenRecording"
            openSystemSettings(screen ? "Privacy_ScreenCapture" : "Privacy_Accessibility")
            self.console?.showPermissionGuide(screenRecording: screen)
            requestPermissionsIfMissing()
            self.refresh()
        }
        console.onConnectAll = { [weak self] in self?.connectAgents() }
        console.onToggleAgent = { [weak self] id, enabled in
            self?.setAgent(id: id, enabled: enabled)
        }
        console.onRestartService = { [weak self] in
            restartService()
            self?.refresh()
        }
        console.onRelaunchApp = { [weak self] in self?.relaunchApp() }
        console.onSaveSettings = { [weak self] settings in self?.saveSettings(settings) }
        console.onOpenConfigFile = { [weak self] in self?.openConfigFile() }
        console.onOpenServiceLog = { [weak self] in self?.openServiceLog() }
        console.onCopyDiagnostics = { [weak self] in copyToPasteboard(self?.diagnosticsText() ?? "") }
        console.onCopyConfiguration = { copyToPasteboard(mcpConfigurationText()) }
        console.onWindowClosed = { [weak self] in
            guard let self else { return }
            stayInBackground(self.lastFrontPid != 0 ? self.lastFrontPid : self.launchFrontPid)
        }
        console.settingsProvider = {
            let config = loadServiceConfig(portOverride: nil, tokenOverride: nil)
            return CUConsoleSettings(
                port: config.port,
                screenshotMaxDimension: config.screenshotMaxDimension ?? 1600,
                pauseOnUserActivity: config.pauseOnUserActivity ?? true,
                autoHalo: config.autoHalo ?? true,
                allowedApps: readAllowedAppsFile())
        }
        console.configurationTextProvider = { mcpConfigurationText() }
        console.versionProvider = { appVersion() }
        self.console = console
    }

    private func servicePort() -> Int {
        loadServiceConfig(portOverride: nil, tokenOverride: nil).port
    }

    private func refresh() {
        let port = servicePort()
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let payload = httpGetJSON(port: port, path: "/v1/status")
            let clients = clientsReport()
            let agents = agentsCatalog()
            DispatchQueue.main.async {
                guard let self else { return }
                self.statusCache = payload ?? [:]
                self.clientsCache = clients
                self.clientRows = (clients["clients"] as? [[String: Any]]) ?? []
                self.usageRows = (clients["usage"] as? [[String: Any]]) ?? []
                self.agentRows = agents
                self.serviceRunning = payload != nil
                self.serviceState = payload == nil ? "未运行" : "运行中"
                self.accessibility = payload?["accessibility"] as? Bool ?? false
                self.screenRecording = payload?["screenRecording"] as? Bool ?? false
                self.updateIcon()
                self.rebuildMenu()
                self.applyModel()
                self.finishOneShotModes()
            }
        }
    }

    private func applyModel() {
        let activity = clientsCache["activity"] as? [String: Any]
        let visibleClients = clientRows
            .filter { ($0["alive"] as? Bool ?? false) || Int($0["idleSeconds"] as? Int ?? 99_999) < 300 }
            .prefix(8)
        let online = clientRows.filter { $0["alive"] as? Bool ?? false }.count
        let model = CUConsoleModel(
            serviceRunning: serviceRunning,
            port: servicePort(),
            pid: statusCache["pid"] as? Int ?? 0,
            clientCount: online,
            activityText: activity?["text"] as? String,
            activityAge: Int(clientsCache["activityAge"] as? Int ?? 99_999),
            accessibility: accessibility,
            screenRecording: screenRecording,
            paused: pauseActive(),
            agents: agentRows,
            clients: Array(visibleClients),
            usage: Array(usageRows.prefix(8)),
            diagnostics: diagnosticsText(),
            version: appVersion(),
            frontmost: (statusCache["frontmost"] as? [String: Any])?["app"] as? String ?? "—",
            windowCount: statusCache["windows"] as? Int ?? 0)
        console?.update(model: model)
    }

    /// Snapshot and selftest runs finish as soon as they have real state.
    private func finishOneShotModes() {
        firstRefreshDone = true
        if selftestMode && !selftestStarted {
            selftestStarted = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in self?.runSelftest() }
        } else if let path = guideSnapshotPath {
            guideSnapshotPath = nil
            let result = console?.captureGuideSnapshot(to: path)
                ?? ["ok": false, "error": "no_console"]
            emit(result)
            exit((result["ok"] as? Bool ?? false) ? 0 : 1)
        } else if let path = snapshotPath, !snapshotStarted {
            snapshotStarted = true
            runSnapshot(path: path)
        }
    }

    private func runSnapshot(path: String) {
        let requested = snapshotPage ?? "overview"
        let page = CUConsolePage(rawValue: requested)
            ?? (requested == "agent-setup" ? .agentSetup : .overview)
        // Build and render the view without ever ordering or activating its window.
        console?.show(page: page, activate: false, offscreen: true)
        let result = console?.captureSnapshot(to: path)
            ?? ["ok": false, "error": "no_console"]
        emit(result)
        exit((result["ok"] as? Bool ?? false) ? 0 : 1)
    }

    private func runSelftest() {
        var report = console?.selftestReport() ?? ["ok": false]
        report["menuBarInstalled"] = item?.menu != nil
        report["menuTitles"] = item?.menu?.items.map(\.title) ?? []
        let titles = item?.menu?.items.map(\.title) ?? []
        report["menuCopyConfiguration"] = titles.contains("复制 MCP 配置")
        report["menuResetPermissions"] = titles.contains("重置失效授权")
        report["menuAgentSetup"] = titles.contains("接入其他 agent…")
        report["menubarTitle"] = item?.button?.title ?? ""
        report["configuration"] = mcpConfigurationJSON()
        report["agentCount"] = agentRows.count
        report["paused"] = pauseActive()
        emit(report)
        exit(0)
    }

    // MARK: status icon & menu

    /// Own the ScreenCaptureKit display stream in this app process. Starting it
    /// off the main thread keeps a slow SCShareableContent lookup from freezing
    /// the menu bar; the system privacy indicator follows the stream's lifetime.
    private func setScreenIndicator(_ active: Bool) {
        guard active != screenIndicatorOn else { return }
        screenIndicatorOn = active
        screenIndicatorTimer?.invalidate()
        screenIndicatorTimer = nil
        if active {
            // Safety net: a crashed plugin must not leave the system indicator on.
            screenIndicatorTimer = Timer.scheduledTimer(withTimeInterval: 7200, repeats: false) {
                [weak self] _ in
                self?.setScreenIndicator(false)
            }
        }
        let indicator = screenIndicator
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            if active {
                if let error = indicator.start() {
                    NSLog("screen indicator failed: %@", error)
                    DispatchQueue.main.async {
                        self?.screenIndicatorOn = false
                        self?.updateIcon()
                        // Publish the real outcome: the CLI reads this file to
                        // tell "the app closed the stream" from "nobody listened".
                        writeScreenIndicatorState(active: false)
                    }
                } else {
                    DispatchQueue.main.async { writeScreenIndicatorState(active: true) }
                }
            } else {
                indicator.stop()
                DispatchQueue.main.async { writeScreenIndicatorState(active: false) }
            }
        }
        updateIcon()
    }

    func applicationWillTerminate(_ notification: Notification) {
        screenIndicator.stop()
        writeScreenIndicatorState(active: false)
    }

    private func updateIcon() {
        let color: NSColor
        if !serviceRunning {
            color = .systemRed
        } else if !accessibility || !screenRecording {
            color = .systemOrange
        } else if pauseActive() {
            color = .systemYellow
        } else {
            color = .systemGreen
        }
        // A template SF Symbol loses its tint in the menu bar; a coloured dot in
        // the title keeps green/orange/red readable at a glance.
        item.button?.attributedTitle = NSAttributedString(
            string: screenIndicatorOn ? "● CU · REC" : "● CU",
            attributes: [.foregroundColor: color,
                         .font: NSFont.systemFont(ofSize: 12, weight: .semibold)])
        let recordingState = screenIndicatorOn ? "进行中（系统菜单栏显示隐私指示）" : "空闲"
        item.button?.toolTip = "Super Computer Use｜服务：\(serviceState)｜辅助功能 \(accessibility ? "✓" : "✗")｜屏幕录制 \(screenRecording ? "✓" : "✗")｜会话录屏 \(recordingState)"
    }

    private func menuLine(_ text: String, _ target: AnyObject? = nil, _ action: Selector? = nil) -> NSMenuItem {
        let entry = NSMenuItem(title: text, action: action, keyEquivalent: "")
        entry.target = target
        return entry
    }

    private func relativeTime(_ seconds: Int) -> String { CUI.relTime(seconds) }

    private func rebuildMenu() {
        let menu = NSMenu()
        menu.addItem(menuLine("服务：\(serviceState)"))
        menu.addItem(menuLine("辅助功能：\(accessibility ? "已授权" : "未授权")"))
        menu.addItem(menuLine("屏幕录制：\(screenRecording ? "已授权" : "未授权")"))
        menu.addItem(.separator())
        // Magpie-style: the agent list IS the main state. ● connected,
        // ◐ wired/running but not talking, ○ not linked yet.
        if agentRows.isEmpty {
            menu.addItem(menuLine("Agent：探测中…"))
        } else {
            for agent in agentRows {
                let state = agent["state"] as? String ?? "○ 未验证接入"
                var line = "\(agent["name"] as? String ?? "") · \(state)"
                if let tool = agent["lastTool"] as? String, !tool.isEmpty {
                    line += " · \(tool)（\(relativeTime(Int(agent["idleSeconds"] as? Int ?? 0)))）"
                }
                menu.addItem(menuLine(line))
            }
            menu.addItem(menuLine("一键连接未接入的 Agent", self, #selector(connectAgentsAction)))
        }
        menu.addItem(.separator())
        if pauseActive() {
            menu.addItem(menuLine("继续操作", self, #selector(resumeAction)))
        } else {
            menu.addItem(menuLine("暂停操作", self, #selector(pauseAction)))
        }
        menu.addItem(.separator())
        menu.addItem(menuLine("控制台…", self, #selector(showConsole(_:))))
        menu.addItem(menuLine("接入其他 agent…", self, #selector(showAgentSetupAction)))
        menu.addItem(menuLine("复制 MCP 配置", self, #selector(copyMCPConfiguration)))
        menu.addItem(menuLine("设置…", self, #selector(showSettings(_:))))
        menu.addItem(.separator())
        menu.addItem(menuLine("打开系统设置·辅助功能", self, #selector(openAXPrefs)))
        menu.addItem(menuLine("打开系统设置·屏幕录制", self, #selector(openScreenPrefs)))
        menu.addItem(menuLine("弹出授权窗口", self, #selector(requestPermissions)))
        menu.addItem(menuLine("重置失效授权", self, #selector(resetStalePermissions)))
        menu.addItem(menuLine("在访达中显示服务程序", self, #selector(revealBinary)))
        menu.addItem(.separator())
        menu.addItem(menuLine("重启服务", self, #selector(restartAction)))
        menu.addItem(menuLine("退出菜单栏", self, #selector(quitAction)))
        menu.delegate = self
        item.menu = menu
    }

    @objc private func pauseAction() { markPause(); rebuildMenu(); updateIcon(); applyModel() }
    @objc private func resumeAction() { clearPause(); rebuildMenu(); updateIcon(); applyModel() }
    @objc private func openAXPrefs() { openSystemSettings("Privacy_Accessibility") }
    @objc private func requestPermissions() { requestPermissionsIfMissing() }
    @objc private func openScreenPrefs() { openSystemSettings("Privacy_ScreenCapture") }
    @objc private func revealBinary() { revealServiceBinary() }
    @objc private func restartAction() { restartService(); refresh() }
    @objc private func quitAction() { NSApp.terminate(nil) }
    @objc private func connectAgentsAction() { connectAgents() }
    @objc private func showAgentSetupAction() { console?.show(page: .agentSetup) }
    @objc private func copyMCPConfiguration() { copyToPasteboard(mcpConfigurationText()) }

    @objc private func resetStalePermissions() {
        // Resetting a working grant would make the product stop working until the
        // user re-grants; only repair the grants that are actually missing.
        let missingAccessibility = !AXIsProcessTrusted()
        let missingScreen = !CGPreflightScreenCaptureAccess()
        guard missingAccessibility || missingScreen else {
            alert("权限当前正常", "辅助功能和屏幕录制都已授权，没有执行重置。只有授权反复失效时才需要重置。")
            return
        }
        if missingAccessibility { resetTCCPermission("Accessibility") }
        if missingScreen { resetTCCPermission("ScreenCapture") }
        requestPermissionsIfMissing()
        refresh()
    }

    private func togglePause() {
        if pauseActive() { clearPause() } else { markPause() }
        rebuildMenu()
        updateIcon()
        applyModel()
    }

    @objc private func showSettings(_ sender: Any?) { console?.show(page: .settings) }
    @objc private func showConsole(_ sender: Any?) { console?.show(page: .overview) }

    // MARK: agent connection

    private func setAgent(id: String, enabled: Bool) {
        guard !busyAgents.contains(id) else { return }
        busyAgents.insert(id)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let results = enabled ? agentsConnect(ids: [id]) : agentsDisconnect(ids: [id])
            DispatchQueue.main.async {
                guard let self else { return }
                self.busyAgents.remove(id)
                let row = results.first ?? [:]
                if let error = row["error"] as? String {
                    self.alert("未能更新 \(row["name"] as? String ?? id) 的连接", error)
                }
                self.refresh()
            }
        }
    }

    private func connectAgents() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let results = agentsConnect(ids: nil)
            DispatchQueue.main.async {
                self?.refresh()
                let summary = results.map { row -> String in
                    let name = row["name"] as? String ?? ""
                    switch row["status"] as? String {
                    case "wired": return "✓ \(name)：已写入配置（重启该 Agent 后生效）"
                    case "already": return "· \(name)：配置已存在；请重连 MCP 并在新会话验证调用"
                    case "managed": return "· \(name)：\(row["note"] as? String ?? "由该应用自身管理")"
                    default: return "✗ \(name)：失败（\(row["error"] as? String ?? "未知原因")）"
                    }
                }.joined(separator: "\n")
                let alert = NSAlert()
                alert.messageText = "一键连接结果"
                alert.informativeText = summary
                alert.alertStyle = .informational
                alert.runModal()
            }
        }
    }

    private func alert(_ title: String, _ detail: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.alertStyle = .warning
        if let window = console?.window, window.isVisible {
            alert.beginSheetModal(for: window)
        } else {
            alert.runModal()
        }
    }

    // MARK: settings

    private func saveSettings(_ settings: CUConsoleSettings) {
        var token = ""
        if let data = try? Data(contentsOf: URL(fileURLWithPath: serviceConfigPath)),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            token = object["token"] as? String ?? ""
        }
        var config: [String: Any] = [
            "port": settings.port,
            "token": token,
            "screenshotMaxDimension": settings.screenshotMaxDimension,
            "pauseOnUserActivity": settings.pauseOnUserActivity,
            "autoHalo": settings.autoHalo,
        ]
        if (config["token"] as? String ?? "").isEmpty {
            config["token"] = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        }
        if let data = try? JSONSerialization.data(withJSONObject: config,
                                                  options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: serviceConfigPath))
        }
        writeAllowedAppsFile(settings.allowedApps)
        restartService()
        refresh()
        console?.hide()
    }

    private func openConfigFile() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-t", serviceConfigPath]
        try? process.run()
    }

    private func openServiceLog() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-t", serviceLogPath]
        try? process.run()
    }

    private func relaunchApp() {
        let kick = Process()
        kick.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        kick.arguments = ["kickstart", "-k", "gui/\(getuid())/local.cu.menubar"]
        try? kick.run()
        kick.waitUntilExit()
        if kick.terminationStatus != 0 {
            let open = Process()
            open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            open.arguments = ["-g", "/Applications/Computer Use.app"]
            try? open.run()
        }
        exit(0)
    }

    // MARK: diagnostics

    private func diagnosticsText() -> String {
        let front = (statusCache["frontmost"] as? [String: Any])?["app"] as? String ?? "未知"
        var lines: [String] = [
            "服务：\(serviceState)（pid \(statusCache["pid"] as? Int ?? 0)｜端口 \(servicePort())）",
            "辅助功能：\(accessibility ? "已授权" : "未授权")｜屏幕录制：\(screenRecording ? "已授权" : "未授权")｜暂停：\(pauseActive() ? "是" : "否")",
            "前台应用：\(front)｜屏幕上的窗口：\(statusCache["windows"] as? Int ?? 0) 个",
        ]
        let age = Int(clientsCache["activityAge"] as? Int ?? 99_999)
        if let text = (clientsCache["activity"] as? [String: Any])?["text"] as? String,
           !text.isEmpty, age < 60 {
            lines.append("正在做：\(text)（\(relativeTime(age))）")
        } else {
            lines.append("正在做：空闲")
        }
        let aliveRows = clientRows.filter { $0["alive"] as? Bool ?? false }
        lines.append("客户端：\(aliveRows.count) 个在线（共 \(clientRows.count) 条记录）")
        for row in aliveRows.prefix(6) {
            lines.append("  · \(CUConnectionsPage.clientName(row))  pid \(row["mcpPid"] as? Int ?? 0)"
                + "  \(row["via"] as? String ?? "local")"
                + "  \(relativeTime(Int(row["idleSeconds"] as? Int ?? 0)))"
                + "  \(row["calls"] as? Int ?? 0) 次")
        }
        lines.append("")
        lines.append("配置文件：\(serviceConfigPath)")
        lines.append("服务日志：\(serviceLogPath)")
        lines.append("最近日志：")
        lines.append(contentsOf: tailLines(serviceLogPath, 18).map { "  " + $0 })
        return lines.joined(separator: "\n")
    }
}

extension MenuBarController: NSMenuDelegate {
    func menuWillOpen(_ menu: NSMenu) {
        // Refreshing here only affects the *next* open; the menu on screen was
        // already built, so the timer keeps it current instead of rebuilding it
        // mid-open (which would swap the instance being displayed).
        refresh()
    }
}
