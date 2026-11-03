// ConsoleKit — the visual language of the Computer Use control panel.
//
// Ported from the Claude CU Bridge control panel (see
// docs/superpowers/specs/2026-11-03-console-ui-claude-style-design.md and
// docs/ui/reference/claude-cu-ui-notes.md): borderless vibrancy window, 472 pt
// cards with 13 pt radii and hairline borders, 0.08/0.34 text ramp, 32 pt icon
// tiles, 7 pt status dots, blue pill CTAs and native switches.
//
// This file only holds tokens, small shared components and the console model.
// Page layouts live in ConsolePages.swift, the window/controller in
// ConsoleWindow.swift, and the menu-bar wiring in ConsoleApp.swift.

import AppKit

// MARK: - design tokens

enum CUI {
    static let width: CGFloat = 520
    static let height: CGFloat = 780
    static let footerHeight: CGFloat = 44
    static let pageHeight: CGFloat = height - footerHeight
    static let inset: CGFloat = 24
    static let cardWidth: CGFloat = 472
    static let cardRadius: CGFloat = 13
    static let controlWindowRadius: CGFloat = 25

    static let primary = NSColor(calibratedWhite: 0.08, alpha: 1)
    static let secondary = NSColor(calibratedWhite: 0.34, alpha: 1)
    static let cardFill = NSColor(calibratedWhite: 0.96, alpha: 0.64)

    /// The accent set used by the reference panel.
    static let accent = NSColor.systemBlue
    static let success = NSColor.systemGreen
    static let warning = NSColor.systemOrange
    static let danger = NSColor.systemRed

    static func relTime(_ seconds: Int) -> String {
        if seconds < 2 { return "刚才" }
        if seconds < 60 { return "\(seconds)s 前" }
        if seconds < 3600 { return "\(seconds / 60)m 前" }
        return "\(seconds / 3600)h 前"
    }
}

// MARK: - primitives

/// Top-left origin container: all layout in this console is absolute frames, like
/// the reference implementation, so the rendered result is deterministic.
class CUFlippedView: NSView {
    override var isFlipped: Bool { true }
}

func CUIRect(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ height: CGFloat) -> NSRect {
    NSRect(x: x, y: y, width: width, height: height)
}

func CUILabel(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular,
              color: NSColor = CUI.primary, align: NSTextAlignment = .left) -> NSTextField {
    let field = NSTextField(wrappingLabelWithString: text)
    field.font = .systemFont(ofSize: size, weight: weight)
    field.textColor = color
    field.alignment = align
    field.maximumNumberOfLines = 0
    return field
}

/// Single-line label that truncates instead of wrapping — for live state text.
func CUIInlineLabel(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular,
                    color: NSColor = CUI.secondary) -> NSTextField {
    let field = NSTextField(labelWithString: text)
    field.font = .systemFont(ofSize: size, weight: weight)
    field.textColor = color
    field.lineBreakMode = .byTruncatingTail
    field.maximumNumberOfLines = 1
    return field
}

func CUIStyleCard(_ view: NSView) {
    view.wantsLayer = true
    view.layer?.cornerRadius = CUI.cardRadius
    view.layer?.backgroundColor = CUI.cardFill.cgColor
    view.layer?.borderWidth = 0.7
    view.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.16).cgColor
}

func CUISeparator(width: CGFloat) -> NSBox {
    let box = NSBox(frame: CUIRect(0, 0, width, 1))
    box.boxType = .separator
    return box
}

/// Borderless "regular square" button with a subtle grey fill (the reference's
/// "+ 其他 agent" style).
func CUISubtleButton(_ title: String, target: AnyObject? = nil, action: Selector? = nil) -> NSButton {
    let button = NSButton(title: title, target: target, action: action)
    button.bezelStyle = .regularSquare
    button.isBordered = false
    button.wantsLayer = true
    button.layer?.cornerRadius = 9
    button.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.035).cgColor
    button.font = .systemFont(ofSize: 13, weight: .medium)
    button.contentTintColor = CUI.primary
    return button
}

/// 27 pt circular icon button used for close / back / footer navigation.
func CUIIconButton(_ symbol: String, label: String, target: AnyObject? = nil, action: Selector? = nil) -> NSButton {
    let button = NSButton(frame: CUIRect(0, 0, 27, 27))
    button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
    button.imagePosition = .imageOnly
    button.isBordered = false
    button.contentTintColor = .secondaryLabelColor
    button.wantsLayer = true
    button.layer?.cornerRadius = 13.5
    button.layer?.backgroundColor = NSColor.quaternaryLabelColor.withAlphaComponent(0.10).cgColor
    button.target = target
    button.action = action
    button.setAccessibilityLabel(label)
    return button
}

func CUIConfigurePill(_ button: NSButton, title: String, active: Bool) {
    button.isBordered = false
    button.wantsLayer = true
    button.layer?.cornerRadius = 13
    button.layer?.backgroundColor = (active ? NSColor.clear
        : CUI.accent.withAlphaComponent(0.10)).cgColor
    button.attributedTitle = NSAttributedString(
        string: title,
        attributes: [.foregroundColor: active ? NSColor.secondaryLabelColor : CUI.accent,
                     .font: NSFont.systemFont(ofSize: 13)])
    button.isEnabled = !active
}

/// The app icon, with fallbacks for the CLI (`cu menubar`) and a bare checkout.
func CUIAppIcon() -> NSImage {
    if let url = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
       let image = NSImage(contentsOf: url) {
        return image
    }
    let candidates = ["/Applications/Computer Use.app",
                      NSHomeDirectory() + "/Applications/Computer Use.app"]
    for path in candidates where FileManager.default.fileExists(atPath: path) {
        return NSWorkspace.shared.icon(forFile: path)
    }
    return NSImage(systemSymbolName: "cursorarrow.click", accessibilityDescription: "Computer Use")
        ?? NSImage(size: NSSize(width: 64, height: 64))
}

func CUIAgentIcon(_ id: String) -> NSImage {
    let paths: [String: [String]] = [
        "dsh": ["/Applications/DeepSeek Harness.app"],
        "workbuddy": ["/Applications/WorkBuddy.app"],
        "qoder": ["/Applications/Qoder.app", "/Applications/Qoder CN.app"],
        "claude-desktop": ["/Applications/Claude.app"],
    ]
    for path in paths[id] ?? [] where FileManager.default.fileExists(atPath: path) {
        return NSWorkspace.shared.icon(forFile: path)
    }
    let symbol = id == "claude-code" ? "terminal" : "app.badge"
    if let image = NSImage(systemSymbolName: symbol, accessibilityDescription: id) {
        return image
    }
    return NSImage(size: NSSize(width: 32, height: 32))
}

// MARK: - model

struct CUConsoleModel {
    var serviceRunning = false
    var port = 47777
    var pid = 0
    var clientCount = 0
    var activityText: String?
    var activityAge = 99_999
    var accessibility = false
    var screenRecording = false
    var paused = false
    var agents: [[String: Any]] = []
    var clients: [[String: Any]] = []
    var usage: [[String: Any]] = []
    var diagnostics = ""
    var version = "0.1.0"
    var frontmost = "—"
    var windowCount = 0

    var serviceSummary: String {
        guard serviceRunning else { return "服务没有运行。重启服务后，agent 才能调用电脑操作。" }
        var parts = ["端口 \(port)"]
        if pid > 0 { parts.append("pid \(pid)") }
        parts.append(clientCount == 0 ? "还没有客户端在线" : "\(clientCount) 个客户端在线")
        if let text = activityText, !text.isEmpty, activityAge < 90 {
            parts.append("正在做：\(text)（\(CUI.relTime(activityAge))）")
        } else {
            parts.append("空闲")
        }
        return parts.joined(separator: " · ")
    }
}

struct CUConsoleSettings {
    var port = 47777
    var screenshotMaxDimension = 1600
    var pauseOnUserActivity = true
    var autoHalo = true
    var allowedApps = ""
}

enum CUConsolePage: String, CaseIterable {
    case overview
    case connections
    case settings
    case diagnostics
    case agentSetup

    var title: String {
        switch self {
        case .overview: return "概览"
        case .connections: return "连接与使用"
        case .settings: return "设置"
        case .diagnostics: return "诊断"
        case .agentSetup: return "接入其他 agent"
        }
    }
}

// MARK: - rows and cards

/// One permission row: icon tile, title/detail, and either a green "granted" dot
/// or the blue 去授权 pill that deep-links the privacy pane.
final class CUPermissionRow: CUFlippedView {
    var onRequest: (() -> Void)?
    private let dot = NSView()
    private let statusButton = NSButton()
    private let width: CGFloat

    init(width: CGFloat, symbol: String, title: String, detail: String) {
        self.width = width
        super.init(frame: CUIRect(0, 0, width, 59))
        let tile = NSView(frame: CUIRect(16, 12, 32, 32))
        tile.wantsLayer = true
        tile.layer?.cornerRadius = 9
        tile.layer?.backgroundColor = NSColor.quaternaryLabelColor.withAlphaComponent(0.06).cgColor
        let icon = NSImageView(frame: CUIRect(5, 5, 22, 22))
        icon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)
        icon.contentTintColor = CUI.accent
        tile.addSubview(icon)
        addSubview(tile)

        let titleLabel = CUILabel(title, size: 14, weight: .medium)
        titleLabel.frame = CUIRect(60, 9, 292, 21)
        addSubview(titleLabel)
        let detailLabel = CUILabel(detail, size: 12, color: CUI.secondary)
        detailLabel.frame = CUIRect(60, 30, 292, 17)
        addSubview(detailLabel)

        dot.frame = CUIRect(width - 100, 25, 7, 7)
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 3.5
        dot.layer?.backgroundColor = CUI.success.cgColor
        dot.isHidden = true
        addSubview(dot)

        statusButton.frame = CUIRect(width - 88, 15, 76, 26)
        statusButton.target = self
        statusButton.action = #selector(request)
        addSubview(statusButton)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    @objc private func request() { onRequest?() }

    func update(allowed: Bool) {
        dot.isHidden = !allowed
        CUIConfigurePill(statusButton, title: allowed ? "已允许" : "去授权", active: allowed)
        statusButton.setAccessibilityLabel(allowed ? "已允许" : "去授权")
    }
}

/// One agent row: app icon, name, live connection sentence and the connect switch.
/// The switch writes/removes the real MCP config entry; managed agents (whose
/// connectors live in their own UI) get an informational row instead.
final class CUAgentRow: CUFlippedView {
    var onToggle: ((Bool) -> Void)?
    private let toggle = NSSwitch()
    private let detailLabel: NSTextField
    private let width: CGFloat
    private var managed = false
    private var busy = false

    init(width: CGFloat, name: String, icon: NSImage) {
        self.width = width
        detailLabel = CUIInlineLabel("正在读取…", size: 12)
        super.init(frame: CUIRect(0, 0, width, 52))
        let iconView = NSImageView(frame: CUIRect(16, 10, 32, 32))
        iconView.image = icon
        iconView.imageScaling = .scaleProportionallyUpOrDown
        addSubview(iconView)

        let titleLabel = CUIInlineLabel(name, size: 14, weight: .medium, color: CUI.primary)
        titleLabel.frame = CUIRect(60, 8, width - 140, 20)
        addSubview(titleLabel)
        detailLabel.frame = CUIRect(60, 27, width - 140, 17)
        addSubview(detailLabel)

        toggle.frame = CUIRect(width - 63, 13, 43, 25)
        toggle.target = self
        toggle.action = #selector(toggled)
        toggle.setAccessibilityLabel("连接 " + name)
        addSubview(toggle)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    @objc private func toggled() {
        guard !busy else { return }
        onToggle?(toggle.state == .on)
    }

    /// Whether this row has a connect switch (managed agents do not).
    var hasSwitch: Bool { !toggle.isHidden }
    var isSwitchOn: Bool { toggle.state == .on }

    func update(wired: Bool, detail: String, enabled: Bool, managed: Bool, busy: Bool) {
        detailLabel.stringValue = detail
        detailLabel.toolTip = detail
        toggle.isHidden = managed
        if managed { return }
        self.busy = busy
        toggle.state = wired ? .on : .off
        toggle.isEnabled = enabled && !busy
    }
}

/// Service status card: colored state line, live detail sentence, 检测 / 重启.
final class CUServiceCard: CUFlippedView {
    var onCheck: (() -> Void)?
    var onRestart: (() -> Void)?
    private let stateLabel = CUIInlineLabel("正在检测服务…", size: 13, weight: .medium, color: CUI.primary)
    private let detailLabel = CUIInlineLabel("", size: 11)
    private let checkButton: NSButton
    private let restartButton: NSButton
    private let width: CGFloat

    init(width: CGFloat) {
        self.width = width
        checkButton = CUISubtleButton("检测", target: nil, action: nil)
        restartButton = CUISubtleButton("重启", target: nil, action: nil)
        super.init(frame: CUIRect(0, 0, width, 86))
        CUIStyleCard(self)
        stateLabel.frame = CUIRect(16, 10, width - 32, 20)
        addSubview(stateLabel)
        detailLabel.frame = CUIRect(16, 32, width - 32, 17)
        addSubview(detailLabel)
        checkButton.frame = CUIRect(16, 54, 58, 24)
        restartButton.frame = CUIRect(80, 54, 58, 24)
        checkButton.target = self
        checkButton.action = #selector(check)
        restartButton.target = self
        restartButton.action = #selector(restart)
        addSubview(checkButton)
        addSubview(restartButton)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    @objc private func check() { onCheck?() }
    @objc private func restart() { onRestart?() }

    func update(running: Bool, paused: Bool, summary: String) {
        let text = running ? "● CU 服务 · 运行中" : "● CU 服务 · 未运行"
        stateLabel.attributedStringValue = NSAttributedString(
            string: text,
            attributes: [.foregroundColor: running ? CUI.success : CUI.danger,
                         .font: NSFont.systemFont(ofSize: 13, weight: .medium)])
        var detail = summary
        if paused { detail = "已暂停新调用 · " + detail }
        detailLabel.stringValue = detail
        detailLabel.toolTip = detail
    }
}

/// Persistent footer: version left, pause state + navigation icons right.
final class CUFooter: CUFlippedView {
    var onShowPage: ((CUConsolePage) -> Void)?
    var onPauseToggle: (() -> Void)?
    private let versionLabel = CUIInlineLabel("", size: 12)
    private let pauseLabel = CUIInlineLabel("", size: 12, color: CUI.secondary)
    private let pauseButton: NSButton
    private let connectionsButton: NSButton
    private let diagnosticsButton: NSButton
    private let settingsButton: NSButton

    init(width: CGFloat) {
        pauseButton = CUIIconButton("pause.fill", label: "暂停", target: nil, action: nil)
        connectionsButton = CUIIconButton("antenna.radiowaves.left.and.right",
                                          label: "连接与使用", target: nil, action: nil)
        diagnosticsButton = CUIIconButton("stethoscope", label: "诊断", target: nil, action: nil)
        settingsButton = CUIIconButton("gearshape", label: "设置", target: nil, action: nil)
        super.init(frame: CUIRect(0, 0, width, CUI.footerHeight))
        versionLabel.frame = CUIRect(CUI.inset, 13, 140, 18)
        addSubview(versionLabel)
        pauseLabel.frame = CUIRect(140, 13, 215, 18)
        pauseLabel.alignment = .right
        addSubview(pauseLabel)
        let buttons = [pauseButton, connectionsButton, diagnosticsButton, settingsButton]
        for (index, button) in buttons.enumerated() {
            button.frame = CUIRect(width - CUI.inset - 27 - CGFloat(index) * 33, 8, 27, 27)
            addSubview(button)
        }
        pauseButton.target = self
        pauseButton.action = #selector(pauseTapped)
        connectionsButton.target = self
        connectionsButton.action = #selector(connectionsTapped)
        diagnosticsButton.target = self
        diagnosticsButton.action = #selector(diagnosticsTapped)
        settingsButton.target = self
        settingsButton.action = #selector(settingsTapped)
        pauseButton.toolTip = "暂停 / 继续电脑操作"
        connectionsButton.toolTip = "连接与使用"
        diagnosticsButton.toolTip = "诊断"
        settingsButton.toolTip = "设置"
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    @objc private func pauseTapped() { onPauseToggle?() }
    @objc private func connectionsTapped() { onShowPage?(.connections) }
    @objc private func diagnosticsTapped() { onShowPage?(.diagnostics) }
    @objc private func settingsTapped() { onShowPage?(.settings) }

    func update(version: String, paused: Bool) {
        versionLabel.stringValue = "v" + version
        pauseLabel.stringValue = paused ? "已暂停新调用" : ""
        pauseButton.image = NSImage(systemSymbolName: paused ? "play.fill" : "pause.fill",
                                    accessibilityDescription: paused ? "继续" : "暂停")
        pauseButton.setAccessibilityLabel(paused ? "继续电脑操作" : "暂停电脑操作")
    }
}
