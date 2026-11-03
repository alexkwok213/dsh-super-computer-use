// ConsolePages — the six pages of the DSH Super Computer Use control panel.
//
// Layout mirrors the reference panel: 24 pt margins, 472 pt cards, hero lockup,
// permission CTA card, per-agent switches, a service card, and a copyable MCP
// configuration page. Every page is a CUFlippedView laid out with absolute
// frames inside the window's scroll host.

import AppKit

// MARK: - overview

final class CUOverviewPage: CUFlippedView {
    var onOpenPermission: ((String) -> Void)?
    var onConnectAll: (() -> Void)?
    var onToggleAgent: ((String, Bool) -> Void)?
    var onRestartService: (() -> Void)?
    var onRefreshRequested: (() -> Void)?
    var onShowPage: ((CUConsolePage) -> Void)?

    private let heroIcon = NSImageView()
    private let permissionCard = CUFlippedView()
    private let accessibilityRow = CUPermissionRow(
        width: CUI.cardWidth, symbol: "accessibility", title: "辅助功能",
        detail: "访问应用界面，进行点击、输入和滚动")
    private let screenRow = CUPermissionRow(
        width: CUI.cardWidth, symbol: "desktopcomputer", title: "屏幕录制",
        detail: "读取屏幕，识别需要操作的位置（开启后需重启应用）")
    private let addAgentButton = CUISubtleButton("＋ 其他 agent", target: nil, action: nil)
    private let agentCard = CUFlippedView()
    private let serviceCard = CUServiceCard(width: CUI.cardWidth)
    private var agentRows: [CUAgentRow] = []
    private var agentIds: [String] = []
    private var busyAgents: Set<String> = []

    private(set) var contentHeight: CGFloat = 736
    var agentRowCount: Int { agentRows.count }
    var switchCount: Int { agentRows.filter { !$0.isHidden && $0.hasSwitch }.count }
    var switchOnCount: Int { agentRows.filter { $0.isSwitchOn }.count }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        build()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private func build() {
        heroIcon.image = CUIAppIcon()
        heroIcon.imageScaling = .scaleProportionallyUpOrDown
        heroIcon.frame = CUIRect((CUI.width - 56) / 2, 22, 56, 56)
        heroIcon.wantsLayer = true
        heroIcon.layer?.cornerRadius = 13
        heroIcon.layer?.cornerCurve = .continuous
        heroIcon.layer?.masksToBounds = true
        heroIcon.layer?.borderWidth = 0.7
        heroIcon.layer?.borderColor = NSColor.white.withAlphaComponent(0.8).cgColor
        addSubview(heroIcon)

        let title = CUILabel("DSH Super Computer Use", size: 23, weight: .bold, align: .center)
        title.frame = CUIRect(CUI.inset, 90, CUI.cardWidth, 30)
        addSubview(title)
        let subtitle = CUILabel("让 agent 使用你的电脑", size: 14, color: CUI.secondary, align: .center)
        subtitle.frame = CUIRect(CUI.inset, 126, CUI.cardWidth, 18)
        addSubview(subtitle)

        let permissionsHeader = CUILabel("权限", size: 14, weight: .medium)
        permissionsHeader.frame = CUIRect(CUI.inset, 158, CUI.cardWidth, 20)
        addSubview(permissionsHeader)
        let permissionsDetail = CUILabel(
            "允许 agent 查看屏幕、点击、输入和滚动。\n系统设置中对应应用名为「DSH Super Computer Use」，开启后需重启应用生效。",
            size: 13, color: CUI.secondary)
        permissionsDetail.frame = CUIRect(CUI.inset, 181, CUI.cardWidth, 34)
        addSubview(permissionsDetail)

        permissionCard.frame = CUIRect(CUI.inset, 222, CUI.cardWidth, 118)
        CUIStyleCard(permissionCard)
        accessibilityRow.onRequest = { [weak self] in self?.onOpenPermission?("accessibility") }
        screenRow.onRequest = { [weak self] in self?.onOpenPermission?("screenRecording") }
        accessibilityRow.frame = CUIRect(0, 0, CUI.cardWidth, 59)
        screenRow.frame = CUIRect(0, 59, CUI.cardWidth, 59)
        permissionCard.addSubview(accessibilityRow)
        permissionCard.addSubview(screenRow)
        let separator = CUISeparator(width: CUI.cardWidth)
        separator.frame = CUIRect(0, 59, CUI.cardWidth, 1)
        permissionCard.addSubview(separator)
        addSubview(permissionCard)

        let agentHeader = CUILabel("本地 agent", size: 14, weight: .medium)
        agentHeader.frame = CUIRect(CUI.inset, 356, 280, 20)
        addSubview(agentHeader)
        let agentDetail = CUILabel("让这台 Mac 上的 AI 助手调用电脑操作功能", size: 13, color: CUI.secondary)
        agentDetail.frame = CUIRect(CUI.inset, 377, 320, 18)
        addSubview(agentDetail)

        addAgentButton.frame = CUIRect(375, 352, 121, 27)
        addAgentButton.target = self
        addAgentButton.action = #selector(showAgentSetup)
        addAgentButton.setAccessibilityLabel("接入其他 agent")
        addSubview(addAgentButton)

        agentCard.frame = CUIRect(CUI.inset, 404, CUI.cardWidth, 0)
        CUIStyleCard(agentCard)
        addSubview(agentCard)

        serviceCard.onCheck = { [weak self] in self?.onRefreshRequested?() }
        serviceCard.onRestart = { [weak self] in self?.onRestartService?() }
        addSubview(serviceCard)
    }

    @objc private func showAgentSetup() { onShowPage?(.agentSetup) }

    func refresh(_ model: CUConsoleModel) {
        // A fresh model supersedes the optimistic "writing config…" state; the
        // menu-bar controller separately guards against double toggles.
        busyAgents.removeAll()
        accessibilityRow.update(allowed: model.accessibility)
        screenRow.update(allowed: model.screenRecording)
        rebuildAgentsIfNeeded(model.agents)
        for (index, row) in agentRows.enumerated() where index < model.agents.count {
            let agent = model.agents[index]
            let id = agent["id"] as? String ?? ""
            let managed = !(agent["configurable"] as? Bool ?? true)
            row.update(wired: agent["wired"] as? Bool ?? false,
                       detail: CUOverviewPage.agentDetail(agent),
                       enabled: agent["installed"] as? Bool ?? true,
                       managed: managed,
                       busy: busyAgents.contains(id))
        }
        serviceCard.update(running: model.serviceRunning, paused: model.paused,
                           summary: model.serviceSummary)
        layOutSections(agentCount: agentRows.count)
    }

    private func rebuildAgentsIfNeeded(_ agents: [[String: Any]]) {
        let ids = agents.compactMap { $0["id"] as? String }
        guard ids != agentIds else { return }
        agentIds = ids
        for old in agentRows { old.removeFromSuperview() }
        agentRows = []
        for (index, agent) in agents.enumerated() {
            let id = agent["id"] as? String ?? "agent-\(index)"
            let name = agent["name"] as? String ?? id
            let row = CUAgentRow(width: CUI.cardWidth, name: name, icon: CUIAgentIcon(id))
            row.frame = CUIRect(0, CGFloat(index) * 52, CUI.cardWidth, 52)
            row.onToggle = { [weak self, weak row] enabled in
                guard let self, let row else { return }
                self.busyAgents.insert(id)
                row.update(wired: false, detail: enabled ? "正在写入配置…" : "正在移除配置…",
                           enabled: false, managed: false, busy: true)
                self.onToggleAgent?(id, enabled)
            }
            agentCard.addSubview(row)
            agentRows.append(row)
        }
        for view in agentCard.subviews where view is NSTextField {
            view.removeFromSuperview()
        }
        if agents.isEmpty {
            let empty = CUILabel("没有可接入的 agent。", size: 12, color: CUI.secondary)
            empty.frame = CUIRect(16, 14, CUI.cardWidth - 32, 18)
            agentCard.addSubview(empty)
        }
    }

    private func layOutSections(agentCount: Int) {
        let cardHeight = max(52, CGFloat(agentCount) * 52)
        agentCard.frame = CUIRect(CUI.inset, 404, CUI.cardWidth, cardHeight)
        serviceCard.frame = CUIRect(CUI.inset, agentCard.frame.maxY + 16, CUI.cardWidth, 86)
        contentHeight = serviceCard.frame.maxY + 22
        frame = CUIRect(0, 0, CUI.width, contentHeight)
    }

    static func agentDetail(_ agent: [String: Any]) -> String {
        let note = agent["note"] as? String ?? ""
        let state = agent["state"] as? String ?? ""
        let wired = agent["wired"] as? Bool ?? false
        let running = agent["running"] as? Bool ?? false
        let connected = agent["connected"] as? Bool ?? false
        let configurable = agent["configurable"] as? Bool ?? true
        if !configurable { return note.isEmpty ? "由该应用自身的连接器管理" : note }
        if state.contains("调用已验证") {
            return running ? "已接入 · 最近调用成功" : "已接入（调用已验证）"
        }
        if state.contains("已请求工具清单") { return "已请求工具清单 · 在新会话验证调用" }
        if state.contains("已握手") { return "已握手 · 尚未请求工具清单" }
        if wired { return running ? "已配置 · 应用正在运行" : "已配置 · 重启客户端后生效" }
        if connected { return "正在连接 · 尚未验证调用" }
        if running { return "应用已打开 · 尚未接入" }
        return "未接入 · 打开开关即可配置"
    }
}

// MARK: - connections & usage

final class CUConnectionsPage: CUFlippedView {
    var onRefreshRequested: (() -> Void)?
    private let clientsCard = CUFlippedView()
    private let usageCard = CUFlippedView()
    private let usageHeader = CUILabel("使用", size: 14, weight: .medium)
    private let clientsEmpty = CUILabel(
        "还没有客户端连接。\n在 agent 中配置 MCP 后，这里会显示它最近调用过什么。",
        size: 12, color: CUI.secondary)
    private let usageEmpty = CUILabel("还没有工具调用记录。", size: 12, color: CUI.secondary)
    private(set) var contentHeight: CGFloat = 700

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        let title = CUILabel("连接与使用", size: 23, weight: .bold)
        title.frame = CUIRect(60, 38, 400, 34)
        addSubview(title)
        let subtitle = CUILabel("看谁正连着 CU、它最近做了什么，以及每个工具花了多少时间。",
                                size: 14, color: CUI.secondary)
        subtitle.frame = CUIRect(60, 83, 412, 38)
        addSubview(subtitle)

        let clientsHeader = CUILabel("连接", size: 14, weight: .medium)
        clientsHeader.frame = CUIRect(CUI.inset, 140, CUI.cardWidth, 20)
        addSubview(clientsHeader)
        clientsCard.frame = CUIRect(CUI.inset, 164, CUI.cardWidth, 60)
        CUIStyleCard(clientsCard)
        addSubview(clientsCard)
        clientsEmpty.frame = CUIRect(16, 14, CUI.cardWidth - 32, 34)
        clientsEmpty.isHidden = true
        clientsCard.addSubview(clientsEmpty)

        usageHeader.frame = CUIRect(CUI.inset, 252, CUI.cardWidth, 20)
        addSubview(usageHeader)
        usageCard.frame = CUIRect(CUI.inset, 276, CUI.cardWidth, 56)
        CUIStyleCard(usageCard)
        addSubview(usageCard)
        usageEmpty.frame = CUIRect(16, 14, CUI.cardWidth - 32, 18)
        usageEmpty.isHidden = true
        usageCard.addSubview(usageEmpty)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func refresh(_ model: CUConsoleModel) {
        rebuildRows()
        let clientsHeight = max(60, CGFloat(max(1, model.clients.count)) * 52)
        clientsCard.frame = CUIRect(CUI.inset, 164, CUI.cardWidth, clientsHeight)
        clientsEmpty.isHidden = !model.clients.isEmpty
        for (index, client) in model.clients.enumerated() {
            clientsCard.addSubview(clientRow(client, index: index))
        }

        usageHeader.frame = CUIRect(CUI.inset, clientsCard.frame.maxY + 22, CUI.cardWidth, 20)
        let usageHeight = max(56, CGFloat(max(1, model.usage.count)) * 44)
        usageCard.frame = CUIRect(CUI.inset, usageHeader.frame.maxY + 12, CUI.cardWidth, usageHeight)
        usageEmpty.isHidden = !model.usage.isEmpty
        for (index, usage) in model.usage.enumerated() {
            usageCard.addSubview(usageRow(usage, index: index))
        }
        contentHeight = usageCard.frame.maxY + 22
        frame = CUIRect(0, 0, CUI.width, contentHeight)
    }

    private func rebuildRows() {
        for view in clientsCard.subviews where !(view is NSTextField) {
            view.removeFromSuperview()
        }
        for view in usageCard.subviews where !(view is NSTextField) {
            view.removeFromSuperview()
        }
    }

    private func clientRow(_ client: [String: Any], index: Int) -> NSView {
        let row = CUFlippedView(frame: CUIRect(0, CGFloat(index) * 52, CUI.cardWidth, 52))
        let alive = client["alive"] as? Bool ?? true
        let name = CUConnectionsPage.clientName(client)
        let nameLabel = CUIInlineLabel(name, size: 14, weight: .medium, color: CUI.primary)
        nameLabel.frame = CUIRect(16, 8, 300, 20)
        row.addSubview(nameLabel)

        let tool = client["lastTool"] as? String ?? ""
        let via = client["via"] as? String ?? "local"
        let idle = Int(client["idleSeconds"] as? Int ?? 0)
        let detail: String
        if !alive {
            detail = "已退出 · " + CUI.relTime(idle)
        } else if tool.isEmpty {
            detail = "在线 · \(via) 通道 · 刚连接"
        } else {
            detail = "在线 · \(via) 通道 · \(tool) · \(CUI.relTime(idle))"
        }
        let detailLabel = CUIInlineLabel(detail, size: 12)
        detailLabel.frame = CUIRect(16, 28, 330, 17)
        row.addSubview(detailLabel)

        let calls = client["calls"] as? Int ?? 0
        let lastMs = client["lastMs"] as? Int ?? 0
        let right = calls == 0 ? "—" : "\(calls) 次 · \(lastMs)ms"
        let rightLabel = CUIInlineLabel(right, size: 12)
        rightLabel.alignment = .right
        rightLabel.frame = CUIRect(CUI.cardWidth - 166, 18, 150, 18)
        row.addSubview(rightLabel)
        return row
    }

    private func usageRow(_ usage: [String: Any], index: Int) -> NSView {
        let row = CUFlippedView(frame: CUIRect(0, CGFloat(index) * 44, CUI.cardWidth, 44))
        let tool = usage["tool"] as? String ?? "—"
        let toolLabel = CUIInlineLabel(tool, size: 13, weight: .medium, color: CUI.primary)
        toolLabel.font = .monospacedSystemFont(ofSize: 12.5, weight: .medium)
        toolLabel.frame = CUIRect(16, 13, 240, 18)
        row.addSubview(toolLabel)
        let calls = max(1, usage["calls"] as? Int ?? 1)
        let ms = usage["ms"] as? Int ?? 0
        let rightLabel = CUIInlineLabel("\(calls) 次 · 平均 \(max(1, ms / calls))ms · 共 \(ms)ms",
                                        size: 12)
        rightLabel.alignment = .right
        rightLabel.frame = CUIRect(CUI.cardWidth - 286, 13, 270, 18)
        row.addSubview(rightLabel)
        return row
    }

    static func clientName(_ client: [String: Any]) -> String {
        let raw = client["client"] as? String ?? "未知客户端"
        let info = client["clientInfo"] as? [String: Any] ?? [:]
        let reported = info["name"] as? String ?? ""
        let lower = (raw + " " + reported).lowercased()
        if lower.contains("dsh-computer-use") || lower.contains("deepseek") { return "DeepSeek Harness" }
        if lower.contains("workbuddy") { return "WorkBuddy" }
        if lower.contains("claude-code") || lower == "claude" { return "Claude Code" }
        if lower.contains("claude") { return "Claude Desktop" }
        if lower.contains("qoder") { return "Qoder" }
        return raw
    }
}

// MARK: - settings

final class CUSettingsPage: CUFlippedView {
    var onSave: ((CUConsoleSettings) -> Void)?
    var onOpenConfigFile: (() -> Void)?
    var onOpenSystemSettings: (() -> Void)?
    private let portField = NSTextField(frame: .zero)
    private let dimensionField = NSTextField(frame: .zero)
    private let pauseSwitch = NSButton(checkboxWithTitle: "你一动键鼠就暂停", target: nil, action: nil)
    private let haloSwitch = NSButton(checkboxWithTitle: "操作时显示窗口光环", target: nil, action: nil)
    private let allowTextView = NSTextView()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        build()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private func build() {
        let title = CUILabel("设置", size: 23, weight: .bold)
        title.frame = CUIRect(60, 38, 400, 34)
        addSubview(title)
        let subtitle = CUILabel("改完保存后服务会重启一次，配置才生效。", size: 14, color: CUI.secondary)
        subtitle.frame = CUIRect(60, 83, 412, 22)
        addSubview(subtitle)

        let serviceHeader = CUILabel("服务", size: 14, weight: .medium)
        serviceHeader.frame = CUIRect(CUI.inset, 126, CUI.cardWidth, 20)
        addSubview(serviceHeader)
        let serviceCard = CUFlippedView(frame: CUIRect(CUI.inset, 150, CUI.cardWidth, 116))
        CUIStyleCard(serviceCard)
        addSubview(serviceCard)

        let portLabel = CUILabel("服务端口", size: 14)
        portLabel.frame = CUIRect(16, 16, 200, 20)
        serviceCard.addSubview(portLabel)
        configureField(portField)
        portField.frame = CUIRect(CUI.cardWidth - 172, 12, 156, 26)
        serviceCard.addSubview(portField)
        let separator = CUISeparator(width: CUI.cardWidth)
        separator.frame = CUIRect(0, 58, CUI.cardWidth, 1)
        serviceCard.addSubview(separator)
        let dimensionLabel = CUILabel("截图长边上限（像素）", size: 14)
        dimensionLabel.frame = CUIRect(16, 74, 240, 20)
        serviceCard.addSubview(dimensionLabel)
        configureField(dimensionField)
        dimensionField.frame = CUIRect(CUI.cardWidth - 172, 70, 156, 26)
        serviceCard.addSubview(dimensionField)

        let behaviorHeader = CUILabel("行为", size: 14, weight: .medium)
        behaviorHeader.frame = CUIRect(CUI.inset, 288, CUI.cardWidth, 20)
        addSubview(behaviorHeader)
        let behaviorCard = CUFlippedView(frame: CUIRect(CUI.inset, 312, CUI.cardWidth, 92))
        CUIStyleCard(behaviorCard)
        addSubview(behaviorCard)
        for (index, toggle) in [pauseSwitch, haloSwitch].enumerated() {
            toggle.frame = CUIRect(16, 14 + CGFloat(index) * 34, CUI.cardWidth - 32, 22)
            toggle.font = .systemFont(ofSize: 13)
            behaviorCard.addSubview(toggle)
        }

        let allowHeader = CUILabel("允许控制的应用", size: 14, weight: .medium)
        allowHeader.frame = CUIRect(CUI.inset, 426, CUI.cardWidth, 20)
        addSubview(allowHeader)
        let allowCard = CUFlippedView(frame: CUIRect(CUI.inset, 450, CUI.cardWidth, 170))
        CUIStyleCard(allowCard)
        addSubview(allowCard)
        let hint = CUILabel("每行一个 bundle id 或名称；留空 = 全部允许。", size: 12, color: CUI.secondary)
        hint.frame = CUIRect(16, 12, CUI.cardWidth - 32, 17)
        allowCard.addSubview(hint)
        let allowScroll = NSScrollView(frame: CUIRect(16, 34, CUI.cardWidth - 32, 124))
        styleEditorScroll(allowScroll)
        allowTextView.frame = allowScroll.bounds
        allowTextView.isEditable = true
        allowTextView.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        allowTextView.textContainerInset = NSSize(width: 6, height: 6)
        allowTextView.drawsBackground = false
        allowTextView.isRichText = false
        allowScroll.documentView = allowTextView
        allowCard.addSubview(allowScroll)

        let save = NSButton(title: "保存并重启服务", target: self, action: #selector(saveTapped))
        save.frame = CUIRect(CUI.inset, 644, 150, 30)
        save.bezelStyle = .rounded
        save.font = .systemFont(ofSize: 13, weight: .medium)
        addSubview(save)
        let openConfig = NSButton(title: "打开配置文件", target: self, action: #selector(openConfigTapped))
        openConfig.frame = CUIRect(CUI.inset + 160, 644, 130, 30)
        openConfig.bezelStyle = .rounded
        openConfig.font = .systemFont(ofSize: 13)
        addSubview(openConfig)
        let openSystem = NSButton(title: "打开系统设置", target: self, action: #selector(openSystemTapped))
        openSystem.frame = CUIRect(CUI.inset + 300, 644, 130, 30)
        openSystem.bezelStyle = .rounded
        openSystem.font = .systemFont(ofSize: 13)
        addSubview(openSystem)

        frame = CUIRect(0, 0, CUI.width, 700)
    }

    private func configureField(_ field: NSTextField) {
        field.isEditable = true
        field.isBezeled = true
        field.font = .systemFont(ofSize: 13)
        field.alignment = .right
    }

    private func styleEditorScroll(_ scroll: NSScrollView) {
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.borderType = .noBorder
        scroll.wantsLayer = true
        scroll.layer?.cornerRadius = 8
        scroll.layer?.borderWidth = 0.5
        scroll.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.22).cgColor
    }

    func load(_ settings: CUConsoleSettings) {
        portField.stringValue = String(settings.port)
        dimensionField.stringValue = String(settings.screenshotMaxDimension)
        pauseSwitch.state = settings.pauseOnUserActivity ? .on : .off
        haloSwitch.state = settings.autoHalo ? .on : .off
        allowTextView.string = settings.allowedApps
    }

    func currentSettings() -> CUConsoleSettings {
        var settings = CUConsoleSettings()
        settings.port = Int(portField.stringValue) ?? 47777
        settings.screenshotMaxDimension = Int(dimensionField.stringValue) ?? 1600
        settings.pauseOnUserActivity = pauseSwitch.state == .on
        settings.autoHalo = haloSwitch.state == .on
        settings.allowedApps = allowTextView.string
        return settings
    }

    @objc private func saveTapped() { onSave?(currentSettings()) }
    @objc private func openConfigTapped() { onOpenConfigFile?() }
    @objc private func openSystemTapped() { onOpenSystemSettings?() }
}

// MARK: - diagnostics

final class CUDiagnosticsPage: CUFlippedView {
    var onRefreshRequested: (() -> Void)?
    var onOpenServiceLog: (() -> Void)?
    var onCopyDiagnostics: (() -> Void)?
    private let reportView = NSTextView()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        let title = CUILabel("诊断", size: 23, weight: .bold)
        title.frame = CUIRect(60, 38, 400, 34)
        addSubview(title)
        let subtitle = CUILabel("服务与权限状态、配置和日志位置，以及最近的日志。可整段复制求助。",
                                size: 14, color: CUI.secondary)
        subtitle.frame = CUIRect(60, 83, 412, 38)
        addSubview(subtitle)

        let card = CUFlippedView(frame: CUIRect(CUI.inset, 140, CUI.cardWidth, 480))
        CUIStyleCard(card)
        addSubview(card)
        let scroll = NSScrollView(frame: CUIRect(12, 12, CUI.cardWidth - 24, 456))
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.borderType = .noBorder
        reportView.frame = scroll.bounds
        reportView.isEditable = false
        reportView.isRichText = false
        reportView.drawsBackground = false
        reportView.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        reportView.textContainerInset = NSSize(width: 6, height: 6)
        scroll.documentView = reportView
        card.addSubview(scroll)

        let refresh = NSButton(title: "刷新", target: self, action: #selector(refreshTapped))
        refresh.frame = CUIRect(CUI.inset, 636, 90, 30)
        refresh.bezelStyle = .rounded
        refresh.font = .systemFont(ofSize: 13)
        addSubview(refresh)
        let log = NSButton(title: "打开服务日志", target: self, action: #selector(logTapped))
        log.frame = CUIRect(CUI.inset + 100, 636, 130, 30)
        log.bezelStyle = .rounded
        log.font = .systemFont(ofSize: 13)
        addSubview(log)
        let copy = NSButton(title: "复制诊断信息", target: self, action: #selector(copyTapped))
        copy.frame = CUIRect(CUI.inset + 240, 636, 130, 30)
        copy.bezelStyle = .rounded
        copy.font = .systemFont(ofSize: 13)
        addSubview(copy)

        frame = CUIRect(0, 0, CUI.width, 700)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func refresh(_ model: CUConsoleModel) {
        if reportView.string != model.diagnostics {
            reportView.string = model.diagnostics
        }
    }

    @objc private func refreshTapped() { onRefreshRequested?() }
    @objc private func logTapped() { onOpenServiceLog?() }
    @objc private func copyTapped() { onCopyDiagnostics?() }
}

// MARK: - MCP setup for other agents

final class CUAgentSetupPage: CUFlippedView {
    var configurationTextProvider: (() -> String)?
    var onCopyConfiguration: (() -> Void)?
    private let textView = NSTextView()
    private let copyButton: NSButton

    override init(frame frameRect: NSRect) {
        copyButton = NSButton(title: "复制配置指令", target: nil, action: nil)
        super.init(frame: frameRect)
        let title = CUILabel("接入其他 agent", size: 23, weight: .bold)
        title.frame = CUIRect(60, 38, 400, 34)
        addSubview(title)
        let subtitle = CUILabel(
            "把下面的配置发给本地 agent，让它完成 MCP 接入。\n设置后重新加载 MCP，或开始新的会话即可使用。",
            size: 14, color: CUI.secondary)
        subtitle.frame = CUIRect(60, 83, 412, 52)
        addSubview(subtitle)

        let panel = CUFlippedView(frame: CUIRect(20, 175, 480, 397))
        panel.wantsLayer = true
        panel.layer?.cornerRadius = 14
        panel.layer?.backgroundColor = NSColor.controlBackgroundColor.withAlphaComponent(0.55).cgColor
        panel.layer?.borderWidth = 0.7
        panel.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.12).cgColor
        addSubview(panel)

        let step = CUILabel("01", size: 12, weight: .semibold)
        step.font = .monospacedSystemFont(ofSize: 12, weight: .semibold)
        step.textColor = CUI.accent
        step.frame = CUIRect(16, 18, 24, 24)
        panel.addSubview(step)
        let panelTitle = CUILabel("配置指令", size: 16, weight: .semibold)
        panelTitle.frame = CUIRect(42, 15, 360, 26)
        panel.addSubview(panelTitle)

        let scroll = NSScrollView(frame: CUIRect(16, 57, 448, 270))
        scroll.drawsBackground = true
        scroll.backgroundColor = NSColor.quaternaryLabelColor.withAlphaComponent(0.04)
        scroll.hasVerticalScroller = true
        scroll.wantsLayer = true
        scroll.layer?.cornerRadius = 11
        scroll.layer?.masksToBounds = true
        textView.frame = NSRect(x: 0, y: 0, width: 430, height: 270)
        textView.isEditable = false
        textView.isRichText = false
        textView.drawsBackground = false
        textView.textContainerInset = NSSize(width: 18, height: 16)
        textView.font = .monospacedSystemFont(ofSize: 12.5, weight: .regular)
        scroll.documentView = textView
        panel.addSubview(scroll)

        copyButton.frame = CUIRect(30, 345, 154, 31)
        copyButton.bezelStyle = .inline
        copyButton.font = .systemFont(ofSize: 13, weight: .medium)
        copyButton.image = NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: "复制")
        copyButton.imagePosition = .imageLeading
        copyButton.target = self
        copyButton.action = #selector(copyTapped)
        panel.addSubview(copyButton)

        let note = CUILabel("已经能自动写入的 agent 会显示在概览里；任何支持 MCP 的客户端都可以用上面的配置。",
                            size: 12, color: CUI.secondary)
        note.frame = CUIRect(CUI.inset, 592, CUI.cardWidth, 36)
        addSubview(note)

        frame = CUIRect(0, 0, CUI.width, 660)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    var configuredText: String { textView.string }

    func refresh() {
        let text = configurationTextProvider?() ?? ""
        if textView.string != text { textView.string = text }
    }

    @objc private func copyTapped() {
        onCopyConfiguration?()
        copyButton.title = "已复制"
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { [weak self] in
            self?.copyButton.title = "复制配置指令"
        }
    }
}

// MARK: - floating permission guide

/// Draggable app-bundle row: drag the app into the System Settings privacy list.
final class CUAppDragView: NSView, NSDraggingSource {
    override func mouseDown(with event: NSEvent) {
        let item = NSDraggingItem(pasteboardWriter: Bundle.main.bundleURL as NSURL)
        item.setDraggingFrame(bounds, contents: CUIAppIcon())
        beginDraggingSession(with: [item], event: event, source: self)
    }

    func draggingSession(_ session: NSDraggingSession,
                         sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        .copy
    }
}

/// Non-activating floating guide shown when the user clicks 去授权. Mirrors the
/// reference panel (360 pt wide, `.popover` material) and fixes its clipped
/// detail label.
final class CUGuidePanel: NSPanel {
    var onRelaunch: (() -> Void)?
    private let titleLabel = CUIInlineLabel("", size: 13, weight: .semibold, color: CUI.primary)
    private let detailLabel = CUILabel("", size: 11, color: CUI.secondary)
    private let row = CUFlippedView()

    init() {
        super.init(contentRect: CUIRect(0, 0, 360, 172),
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        level = .floating
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        isMovableByWindowBackground = true
        let material = NSVisualEffectView(frame: CUIRect(0, 0, 360, 172))
        material.material = .popover
        material.state = .active
        material.wantsLayer = true
        material.layer?.cornerRadius = 16
        material.layer?.masksToBounds = true
        contentView = material
        let root = CUFlippedView(frame: material.bounds)
        material.addSubview(root)

        let arrow = CUILabel("↑", size: 22)
        arrow.frame = CUIRect(16, 14, 24, 26)
        root.addSubview(arrow)
        titleLabel.frame = CUIRect(48, 12, 270, 20)
        root.addSubview(titleLabel)
        detailLabel.frame = CUIRect(48, 33, 288, 52)
        root.addSubview(detailLabel)
        let close = NSButton(frame: CUIRect(330, 8, 22, 22))
        close.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "关闭授权引导")
        close.isBordered = false
        close.target = self
        close.action = #selector(closeGuide)
        close.setAccessibilityLabel("关闭授权引导")
        root.addSubview(close)

        row.frame = CUIRect(16, 116, 328, 44)
        row.wantsLayer = true
        row.layer?.cornerRadius = 9
        row.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.6).cgColor
        row.layer?.borderWidth = 0.5
        row.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.2).cgColor
        let icon = NSImageView(frame: CUIRect(10, 12, 20, 20))
        icon.image = CUIAppIcon()
        row.addSubview(icon)
        let name = CUIInlineLabel("DSH Super Computer Use", size: 12, weight: .medium, color: CUI.primary)
        name.frame = CUIRect(36, 12, 180, 20)
        row.addSubview(name)
        let relaunch = NSButton(title: "重启生效", target: self, action: #selector(relaunchTapped))
        relaunch.frame = CUIRect(232, 9, 88, 26)
        relaunch.bezelStyle = .rounded
        relaunch.font = .systemFont(ofSize: 11)
        row.addSubview(relaunch)
        row.addSubview(CUAppDragView(frame: CUIRect(0, 0, 225, 44)))
        root.addSubview(row)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func present(screenRecording: Bool) {
        titleLabel.stringValue = screenRecording ? "屏幕录制授权" : "辅助功能授权"
        detailLabel.stringValue = screenRecording
            ? "在系统设置中允许 DSH Super Computer Use。\n如没自动出现，把下方应用卡片拖进列表，\n打开开关后点「重启生效」。"
            : "在系统设置中允许 DSH Super Computer Use。\n如没自动出现，把下方应用卡片拖进列表，\n打开开关后点「重启生效」。"
        if let target = NSScreen.main {
            setFrameOrigin(NSPoint(x: target.visibleFrame.midX - 180,
                                   y: target.visibleFrame.minY + 90))
        }
        orderFrontRegardless()
    }

    @objc private func closeGuide() { orderOut(nil) }
    @objc private func relaunchTapped() { onRelaunch?() }
}
