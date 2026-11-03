# Claude CU Bridge — UI/UX reference audit vs. our Computer Use console

Status: complete · Captured 2026-11-03 · Author: ref-auditor (task-1)
Reference repo (READ-ONLY): `/Users/johnkwok/Downloads/work/claude cu/` @ `main`
Reference source: `src/Launcher.swift` (869 lines, AppKit programmatic UI, no storyboards/XIBs)
Our source: `engine/Sources/main.swift` — `MenuBarController` (L3899+), `buildConsoleWindow()` (L4191-4207)
Captures: `docs/ui/reference/` (all PNGs in this folder)

The reference app is **not installed** on this Mac. All reference renders were produced from a
temporary bundle built under `/tmp/ccu-ref/` from the repo sources (build recipe in §9), so the
renders are authentic AppKit output of the real code, not mockups.

---

## 1. Asset inventory

| File | What it shows | Pixels (@2x) | Logical pt |
|---|---|---|---|
| `claude-cu-main-window.png` | Main control window, permissions **granted** ("已允许"), engine loaded | 1040 × 1340 | 520 × 670 |
| `claude-cu-main-window-unauthorized.png` | Same window, permissions **missing** ("去授权" blue pill CTA, no green dot) | 1040 × 1340 | 520 × 670 |
| `claude-cu-other-agent.png` | "连接其他 agent" sub-page (numbered step, monospaced MCP config, copy CTA) | 1040 × 1340 | 520 × 670 |
| `claude-cu-permission-guide.png` | Floating drag-to-authorize guide `NSPanel` (360×136) | 720 × 272 | 360 × 136 |
| `claude-cu-main-window-cached-snapshot.png` | Output of the `--snapshot-ui` hook (in-app `cacheDisplay`), transient engine "检测中" state | 1040 × 1340 | 520 × 670 |
| `ours-console-before.png` | **Our current** console: titled 660×470 window, 5-tab `NSTabView` (代理/连接/使用/设置/诊断) | 1320 × 1004 | 660 × 502 (470 content + 32 titlebar) |
| `claude-cu-vs-ours.png` | Side-by-side composite: reference vs. current (for design reviews) | 2022 × 1024 | — |

All reference PNGs were captured at Retina @2x (window `screencapture -x -l <windowId> -o`, no
shadow, transparent rounded corners) except the permission guide, which is the in-app
`cacheDisplay` bitmap of the panel content view (720×272 @2x).

---

## 2. Design tokens (read from `Launcher.swift`)

### 2.1 Window shell

| Token | Value | Source |
|---|---|---|
| Control window size | **520 × 670 pt**, centered | L304 |
| Style | `.borderless`, `isReleasedWhenClosed = false`, `backgroundColor = .clear`, `isOpaque = false`, `hasShadow = true`, `isMovableByWindowBackground = true`, `canBecomeKey/Main = true` (subclass `ControlWindow`) | L102-105, L304-311 |
| Material | `NSVisualEffectView`, `.material = .underWindowBackground`, `.blendingMode = .behindWindow`, `.state = .active`, `wantsLayer` | L312-316 |
| Window corner radius | **25 pt**, `masksToBounds = true` | L317-318 |
| Window border | **0.7 pt**, `NSColor.separatorColor.withAlphaComponent(0.28)` | L319-320 |
| Root layout | `FlippedView` (top-left origin), absolute frames inside it | L33-35, L322-323 |
| Control-window close | 27×27 borderless button at **(478, 15)**, SF Symbol `xmark`, radius 13.5, bg `quaternaryLabelColor α0.18`, tint `.secondaryLabelColor` | L326-337 |
| Activation policy | `.regular` (Dock icon + app menu), menu-bar `NSStatusItem` also present | L868, L566 |
| Window lifecycle | content built once at launch; `applicationShouldTerminateAfterLastWindowClosed = false`; reopen shows console | L857-862 |

### 2.2 Surface / card / text palette

| Token | Value | Source |
|---|---|---|
| Card surface | `NSColor(calibratedWhite: 0.96, alpha: 0.64)` — translucent white | L120 |
| Card radius | **13 pt** | L119 |
| Card border | **0.7 pt**, `separatorColor.withAlphaComponent(0.16)` | L121-122 |
| Card internal separator | `NSBox` `.separator`, full width, at half height (1 pt) | L123-125 |
| Primary text | `NSColor(calibratedWhite: 0.08, alpha: 1)` | L111 |
| Secondary text | `NSColor(calibratedWhite: 0.34, alpha: 1)` | L111 |
| Page margin | 24 pt left/right; cards are `x=24, w=472` | L348-388 |
| Vertical rhythm | hero → header 23 pt gap; section title → card 19-22 pt; card → next header ~22-24 pt | L338-395 |
| Accent | `systemBlue` for actionable permission glyphs/CTA and step index; `systemGreen` for granted dot / engine loaded; `systemOrange` for engine unavailable | L141, L162-168, L501-508 |

Typography ramp (`textLabel(...)`, system fonts):

| Role | Size / weight | Source |
|---|---|---|
| Hero title "Claude Computer Use" | 23 pt bold, centered | L348 |
| Hero subtitle "让 agent 使用你的电脑" | 14 pt regular, secondary | L349 |
| Section header ("权限", "连接本地 agent") | 14 pt medium | L350, L358 |
| Section explanation | 13 pt regular, secondary | L351, L359 |
| Card row title (permission, agent) | 14 pt medium | L144, L251 |
| Card row detail | 12 pt regular, secondary | L145, L253 |
| Sub-page title "连接其他 agent" | 23 pt bold | L671 |
| Sub-page body | 14 pt regular, secondary | L672 |
| Permission CTA pill | 13 pt regular | L152 |
| "+ 其他 agent" | 13 pt medium | L367 |
| Engine status line | 13 pt medium | L379 |
| Engine detail | 11 pt secondary | L381 |
| Footer (version / pause) | 12 pt secondary, 12 pt regular right-aligned | L390-394 |
| Monospaced config | 12.5 pt regular, text inset 18×16 | L696-697 |
| Step index "01" | 12 pt semibold monospaced, systemBlue | L679-681 |
| Icon-button glyphs | 27 pt SF Symbol inside 27×27 (main close) / 27×27 (sub-page back/close) | L326-337, L658-670 |

### 2.3 Component tokens

**Permission row** (`PermissionRow`, 472×59, two rows stacked in one 118 pt card with a center separator): L129-170

| Element | Frame inside row | Style |
|---|---|---|
| Icon tile | (16, 12, 32, 32) | radius 9, bg `quaternaryLabelColor α0.06`; SF Symbol 22×22 at (5,5), tint `systemBlue` (symbols `accessibility` / `desktopcomputer`) |
| Title | (60, 9, 292, 21) | 14 medium, primary |
| Detail | (60, 30, 292, 17) | 12 regular, secondary |
| Granted dot | (width−100, 25, 7, 7) | radius 3.5, `systemGreen`, hidden when not granted |
| Status / CTA pill | (width−88, 15, 76, 26) | radius 13, borderless 13 pt; **denied**: bg `systemBlue α0.10`, text `去授权`, tint `systemBlue`, enabled; **granted**: clear bg, text `已允许`, tint `.secondaryLabelColor`, disabled |

**Agent connect row** (`AgentRow`, 472×60): L238-272

| Element | Frame | Style |
|---|---|---|
| App icon | (16, 14, 32, 32) | `NSWorkspace.shared.icon(forFile:)` of ChatGPT.app / DeepSeek Harness.app |
| Title | (60, 10, 320, 22) | 14 medium, primary |
| Detail/state | (60, 33, 320, 18) | 12 regular, secondary (e.g. 已配置，重启 Harness 后生效 / 已安装在这台 Mac / 未在这台 Mac 找到 / 暂时无法读取连接设置) |
| `NSSwitch` | (width−63, 18, 43, 25) | native switch; `setAccessibilityLabel("连接 " + title)`; enabled only when installed && !blocked |

**Hero lockup**: icon `NSImageView` 64×64 at (228, 30) — centered, radius **14**, `.continuous` corner curve, 0.7 pt white α0.8 border; title at (24,109,472,32); subtitle at (24,148,472,22). L338-349

**Pill / row buttons**:

| Component | Frame | Style |
|---|---|---|
| "+ 其他 agent" | (375, 374, 121, 29) | `.regularSquare`, borderless, radius **9**, bg `black α0.035`, 13 medium |
| "检测" (engine card) | (396, 8, 60, 25) | default rounded bezel button |
| "复制配置指令" | (30, 345, 154, 31) | `.inline` bezel, 13 medium, SF Symbol `doc.on.doc` image-leading |
| "重启生效" (guide panel) | (232, 9, 88, 26) | rounded bezel, 11 pt |

**Floating permission-guide panel**: `NSPanel` **360 × 136**, styleMask `[.borderless, .nonactivatingPanel]`, `.level = .floating`, `hidesOnDeactivate = false`, `isReleasedWhenClosed = false`, `isOpaque = false`, clear bg, `hasShadow`, `isMovableByWindowBackground`; material `.popover`, radius **16**; positioned bottom-center of visible frame at `midX−180, minY+90`. L46-100

| Element | Frame | Style |
|---|---|---|
| "↑" arrow | (16, 16, 24, 26) | 22 pt |
| Title | (48, 14, 270, 20) | 13 semibold ("辅助功能授权" / "屏幕录制授权") |
| Detail | (48, 35, 275, 34) | 11 secondary, 2-line label |
| Close | (330, 8, 22, 22) | borderless `xmark` |
| App drag row | (16, 78, 328, 44) | radius 9, bg white α0.6, border 0.5 separator α0.2; app icon 20×20 at (10,12); name 12 medium at (36,12,180,20); "重启生效" button; full-row invisible `AppDragView` (NSDraggingSource) at (0,0,225,44) — user drags the app bundle into the System Settings pane |

**Status menu** (`installStatusMenu`, L565-591): `NSStatusItem` `.squareLength`, template SF Symbol `cursorarrow.click`, tooltip "Claude 原生 Computer Use", menu delegate = self (refresh on open). Items in order:
`Claude CU Bridge` (disabled header) · — · 显示控制台 · 复制 MCP 配置 · 暂停新调用/恢复调用 · — · 辅助功能授权 · 屏幕录制授权 · 重置失效授权 · 刷新状态 · 重启应用 · — · 退出应用.

**Application menu** (`installApplicationMenu`, L526-563):
`Claude CU Bridge`: 关于 Claude CU Bridge · — · 显示控制台 ⌘0 · 复制 MCP 配置 · 暂停新调用/恢复调用 · — · 隐藏 Claude CU Bridge ⌘H · — · 退出 Claude CU Bridge ⌘Q;
`编辑`: 复制 ⌘C · 全选 ⌘A;
`窗口`: 显示控制台 · 最小化 ⌘M (`NSApp.windowsMenu` set).

### 2.4 Toolbar/status colors (state semantics)

| State | Semantics in the reference | Color |
|---|---|---|
| Permission granted | dot visible + "已允许" disabled pill | `systemGreen` dot, tertiary text |
| Permission missing | pill "去授权" (one click opens the right privacy pane + floating guide) | `systemBlue` bg α0.10 + text |
| Engine loaded | "● Claude 执行引擎 · 已加载" + "Claude <ver> · <N> 个原生接口 · HH:mm 检测" | `systemGreen` |
| Engine unavailable | "● … · 不可用" + "请检查 Claude 安装及组件兼容性 · HH:mm 检测" | `systemOrange` |
| Agent blocked (same-name foreign config) | grayed switch + explanatory detail | secondary text |
| Pause active | footer right label "已暂停新调用" + menu item flips to "恢复调用" | secondary text |

---

## 3. Region-by-region layout map (main page, flipped/top-left coordinates)

All frames are `(x, y, w, h)` inside the 520×670 `FlippedView`, exactly as coded in `Launcher.swift` L302-419:

| Region | Frame | Notes |
|---|---|---|
| Close control | (478, 15, 27, 27) | icon-only `xmark`, radius 13.5 circle |
| Hero app icon | (228, 30, 64, 64) | centered 64 pt, radius 14 |
| Hero title | (24, 109, 472, 32) | 23 bold centered |
| Hero subtitle | (24, 148, 472, 22) | 14 secondary centered |
| Section "权限" | (24, 178, 472, 20) | 14 medium |
| Permission explainer (2 lines) | (24, 199, 472, 36) | 13 secondary |
| Permission card | (24, 237, 472, 118) | radius-13 card, center `NSBox` separator |
| — 辅助功能 row | (0, 0, 472, 59) inside card | pill/dot as §2.3 |
| — 屏幕录制 row | (0, 59, 472, 59) inside card | pill/dot as §2.3 |
| Section "连接本地 agent" | (24, 376, 315, 22) | 14 medium |
| Section subtitle | (24, 397, 335, 20) | 13 secondary |
| "+ 其他 agent" button | (375, 374, 121, 29) | top-right of section, not inside card |
| Agent card | (24, 419, 472, 120) | radius-13 card, center separator |
| — DeepSeek Harness row | (0, 0, 472, 60) | icon + title/detail + NSSwitch |
| — Codex row | (0, 60, 472, 60) | ditto |
| Engine status card | (24, 553, 472, 64) | card with separator removed (L377) |
| — status line | (16, 10, 370, 22) | 13 medium, colored dot prefix in string |
| — status detail | (16, 35, 430, 19) | 11 secondary |
| — "检测" button | (396, 8, 60, 25) | re-runs engine probe |
| Footer version | (24, 638, 160, 18) | "v0.1.7" 12 secondary |
| Footer pause state | (260, 638, 236, 18) | right-aligned 12 regular |
| Remaining bottom inset | 670 − 656 = 14 | breathing room |

### Other-agent sub-page (added as a sibling of the main page in the window contentView, same 520×670): L655-715

| Region | Frame | Notes |
|---|---|---|
| Back control | (16, 16, 27, 27) | `chevron.left`, radius 13.5, bg quaternary α0.08 |
| Close control | (478, 16, 27, 27) | `xmark`, same style |
| Title "连接其他 agent" | (60, 38, 400, 34) | 23 bold |
| Subtitle (3 lines) | (60, 83, 412, 64) | 14 secondary: "将下面的配置指令发送给本地 agent，让它完成 MCP 接入。设置后重新加载 MCP，或开始新的聊天即可使用。" |
| Config panel | (20, 175, 480, 397) | radius 14, bg `controlBackgroundColor α0.55`, border 0.7 separator α0.12 |
| — Step index "01" | (16, 18, 24, 24) | monospaced 12 semibold, `systemBlue` |
| — "配置指令" | (42, 15, 360, 26) | 16 semibold |
| — Config scroll view | (16, 57, 448, 270) | radius 11, bg quaternary α0.04, vertical scroller |
| — Config text | inset (18, 16) in scroller | 12.5 mono, read-only, `setupInstructions()` |
| — "复制配置指令" | (30, 345, 154, 31) | inline bezel + `doc.on.doc` leading icon |
| Page switch | `mainPage.isHidden = true` when sub-page shown; back restores | L713-720 |

### Permission-guide floating panel — see §2.3 for exact sub-frames

---

## 4. Visual inventory (state transitions)

1. **Permission granted** — row shows green 7 pt dot + gray disabled "已允许" pill (see `claude-cu-main-window.png`; granted because the temp binary inherited AX/SC trust from its launching shell).
2. **Permission missing** — row hides dot and shows blue-tinted "去授权" pill (`claude-cu-main-window-unauthorized.png`; captured by launching via LaunchServices so the bundle is untrusted).
3. **Agent connected / not connected / blocked / not installed** — four detail strings (`已配置，重启 Harness 后生效` / `已安装在这台 Mac` / `同名连接需检查…` / `未在这台 Mac 找到`); switch enabled only when installed && !blocked. L215-236, L267-271.
4. **Engine checking → loaded / unavailable** — status line starts "检测中", then green/orange with timestamp; "检测" button re-runs. L475-512.
5. **Copy feedback** — copy button title flips to "已复制" for 1.8 s then back. L722-729.
6. **Pause** — footer right label + status/app menu item title flip. L792-798, L845-855.
7. **Failed toggle** — `NSAlert` sheet ("未能更新 <Agent> 的连接") over the control window. L641-646.

---

## 5. Interaction inventory (reference behavior worth matching)

| # | Interaction | Implementation detail | Source |
|---|---|---|---|
| 1 | Live state refresh | 1.5 s repeating `Timer` on `.common` run loop calling `refresh()`; also `applicationDidBecomeActive`, `menuWillOpen`, and every successful agent-state refresh | L414-418, L731-733, L735, L398 |
| 2 | Permission CTA flow | Button → `AXIsProcessTrustedWithOptions(prompt)` (AX) or `CGRequestScreenCaptureAccess()` (screen) → opens correct System Settings pane (`x-apple.systempreferences:…?Privacy_Accessibility` / `Privacy_ScreenCapture`) → shows floating guide panel → refresh | L827-838, L46-100 |
| 3 | Drag-app-into-Settings guide | Borderless non-activating floating `NSPanel`; app row content is an `NSDraggingSource` that starts a drag with the bundle URL + app icon so the user drops it into the privacy list | L37-44, L79-95 |
| 4 | Copy MCP config (menu/status menu) | `configuration()` JSON (`mcpServers.claude-native-cu.command/args` prettyPrinted sortedKeys without escaping slashes) to pasteboard | L786-790, L840-843 |
| 5 | Copy setup instructions (sub-page) | `setupInstructions()` includes name/type/command/args + JSON + "reload MCP or new chat" line; copy button flips to "已复制" 1.8 s | L651-653, L722-729 |
| 6 | Per-agent connect toggle | optimistic switch disable → background `mcp add/remove` (codex) / `node deepseek-connection.mjs add/remove` (dsh) → re-read config → verify managed command+args → alert on drift | L619-649, L201-236 |
| 7 | Pause | Toggle `~/Library/Application Support/ClaudeNativeCUBridge/paused` marker file, refreshed into footer + menus | L845-855, L792-798 |
| 8 | Engine check | Re-entrancy guard + `node bridge.mjs --status` on background queue + **10 s terminate watchdog**; parses `claudeVersion`, `nativeMethodCount`; shows timestamp | L475-512 |
| 9 | TCC stale-permission healing | On launch only: scans `log show --last 3m` for tccd "Failed to match existing code requirement for subject local.claude-native-cu-bridge"; if accessibility/screen-capture service appears, `tccutil reset <Service> <bundle-id>` + re-prompt. Explicit "重置失效授权" menu item does the same on demand | L432-473, L809-821 |
| 10 | Daemon bootstrap | On real launch (not selftest/snapshot): spawn `node bridge.mjs --daemon`; terminate on quit/relaunch | L421-430, L823-825, L800-807 |
| 11 | Reopen/handling | Dock reopen shows console; closing window keeps app alive; `showControl()` = makeKeyAndOrderFront + `NSApp.activate(ignoringOtherApps: true)` | L593-596, L857-862 |
| 12 | Snapshot hook | `--snapshot-ui <path>`: after agent states load, `cacheDisplay` of `window.contentView` → PNG, once (`snapshotWritten`), and **skips daemon start + TCC prompts**. Combines with `--show-connection` to snapshot the sub-page | L402-412, L737-746, L600-617 |
| 13 | Self-test hook | `--selftest-ui`: closes window, replays "显示控制台" menu action, asserts reopen, opens/closes sub-page, checks configuration visibility, dumps agent states; emits **JSON to stdout** then terminates. `--selftest-agent-commands` dumps enable/disable argv per agent | L748-780, L274-278 |
| 14 | Live sub-page navigation | Page created lazily on first "＋ 其他 agent", cached and toggled hidden/hidden; back button restores | L655-720 |

---

## 6. Comparison table — reference highlight → our current console → port recommendation

Our console today (`engine/Sources/main.swift`): `NSStatusItem` with attributed "● CU" title + rich rebuild-every-3 s menu (L4065-4130); console is a standard titled 660×470 window (L4191-4207) with a 644×454 5-tab `NSTabView`: 代理/连接/使用/设置/诊断 (tables built in L4241-4365, data sources L4461-4504). Window opens via menu/notification (L4182-4189), tables refresh from `/v1/status` + client/agent reports every 3 s (L4042-4063); close returns focus to the previous app (L4030-4036).

| # | Claude-CU highlight | Our engine currently | Port recommendation |
|---|---|---|---|
| 1 | **Borderless floating material window** 520×670, radius 25, 0.7 pt separator border, shadow, `FlippedView` absolute layout | Standard `.titled/.closable/.miniaturizable` window 660×470; `NSTabView` fills it; system chrome/shadows | **Port.** Rebuild the console as borderless, clear, non-opaque window with `NSVisualEffectView(.underWindowBackground / .behindWindow)` + radius 25 + hairline border; `FlippedView` root and absolute frames. Keep window movable by background and `.regular`-style activation behavior optional (our app is accessory-only). |
| 2 | **Hero lockup**: 64 pt rounded app icon + 23 pt bold title + 14 pt secondary tagline | No branding: window title bar says "Computer Use 控制台"; tab strip at top | **Port.** 64×64 icon (radius 14, continuous, white hairline), centered 23 pt bold title, 14 pt tagline; then the content sections. |
| 3 | **Permission card**: 2 rows with icon tiles, green granted dot, blue "去授权" CTA pill, helper explainer text | Permissions only appear as (a) menu lines "辅助功能：已授权/未授权", (b) buttons "打开系统设置·辅助功能/屏幕录制", (c) settings-tab hint paragraph | **Port priority #1.** Dedicated 权限 card with two rows and a pill CTA; clicking CTA opens the security pane + floating guide. This is the single biggest UX upgrade a new user needs. |
| 4 | **Per-agent connect rows with NSSwitch** (DeepSeek Harness, Codex) + app icons + status detail; blocked/not-installed states visible inline; alert sheet on failure | 代理 tab: read-only `NSTableView` of agents with ○/◐/● glyph states; bulk "一键连接未接入的 Agent" button opens a modal alert with results; no per-agent toggle, no app icons, no per-row action | **Port.** Make agent connection a first-class list of rows with switch control (or row-level "连接/断开" button) + app icon + detail; keep our richer 6-state glyph semantics in the detail text. Rewrite config per agent and verify by re-reading; alert on drift. |
| 5 | **"连接其他 agent" dedicated sub-page** with back/close, step "01", scrollable monospaced config, "复制配置指令" + 1.8 s "已复制" feedback | No sub-page; no copyable MCP config anywhere; settings tab only edits our own service config; "一键连接" writes configs directly and reports via modal alert | **Port.** Add a sub-page (slide/swap in same window) for MCP setup instructions: JSON + per-agent command lines, monospaced read-only scroll, copy button with feedback. Keep the direct-write path as the one-click option. |
| 6 | **Engine/service status card** with colored dot status line, detail (version, native method count, check time), and "检测" button with 10 s watchdog + re-entrancy guard | Service/permissions state lives only in the menu bar title/tooltip and menu lines; diagnostics tab has detailed text; no in-window status card, no check button | **Port.** Status card in-window: "● CU 服务 · 运行中/未运行", permissions summary, MCP endpoint, last check time, "检测" button (background probe + timeout + re-entrancy guard). This is the replacement for the menu's state lines and gives the window a reason to exist. |
| 7 | **Footer**: version left + pause state right | None (window ends with tab content) | **Port.** Add footer with version and pause state; make pause reachable in-window, not only menu/settings. |
| 8 | **Refresh cadence**: 1.5 s timer + activate + menu-open + post-action refresh | 3 s timer + menu-open refresh; console tables refreshed in the same pass (L3938-3940, L4506-4513) | **Port partially.** 1.5 s is smooth; for us 2 s when console visible (and stop refreshing when hidden) is enough — our `/v1/status` + clients report is heavier than the reference's local probes. Refresh on activate + after any in-window action. |
| 9 | **Design tokens**: 0.96 α0.64 cards radius 13 hairline; 0.08/0.34 text; 32 pt icon tiles radius 9; 7 pt green dot; systemBlue pill CTA; 13 pt component rhythm | Default AppKit: bezel-bordered `NSScrollView`, alternating-row `NSTableView`, standard rounded buttons, default label colors | **Port the token set** into a small `ConsoleUI.swift` helper layer (card/label/pill/iconTile/switchRow) so the console and any future panel share one visual language. Don't fight AppKit table styling unless needed — for dense tables keep native tables but restyle container surfaces and row heights (44-52 pt instead of 24 pt). |
| 10 | **Status menu** offers permission shortcuts, copy config, reset stale permissions, refresh, restart in one compact menu | Our menu already has state lines + agent states + 一键连接 + pause + 控制台/设置 + 打开系统设置 + 弹出授权窗口 + 访达显示 + 重启服务 + 退出 | **Port selectively.** Add: "复制 MCP 配置", "连接其他 agent…", "重置失效授权" (TCC heal). Keep our agent-state lines (they're better diagnostics than the reference's). |
| 11 | **App menu** with 显示控制台 ⌘0 / 复制 MCP 配置 / 暂停 / 隐藏 ⌘H / 退出 ⌘Q + 编辑/窗口 menus | Accessory app: no app menu (correct for menu-bar helper); the reference is `.regular` with Dock icon | **Skip** for a menu-bar-only product (optional if we ever ship a Dock-mode variant). |
| 12 | **Lazy window build + tab/state preservation** | Same pattern already | Keep (match the reference's lazy `buildConsoleWindow()` + `showConsole(tab:)`). |

---

## 7. Non-UI highlights worth porting

1. **`--snapshot-ui <path>` hook** — deterministic UI snapshot without daemon/TCC side effects (`cacheDisplay` → PNG). Lets us build a regression loop for console rendering: CI/agent runs `Computer Use app --snapshot-console /tmp/console.png` and inspects the PNG. The reference combines it with `--show-connection` to snapshot the sub-page; we should support `--snapshot-console --tab agents|connection|usage|settings|diagnostics|other-agent`.
2. **`--selftest-ui` JSON assertions** — machine-readable checks: mainMenuInstalled, statusMenuInstalled, statusImagePresent, statusMenuItems, reopenedAfterClose, terminateWhenWindowClosed, otherAgentSheetOpened, connectionPageNavigationPassed, configuration visible, agentStates; exits after printing. A test harness asserts keys/values. Reference also has `--selftest-agent-commands`. We have no UI self-test today (only engine/service tests in `engine/tests/`).
3. **TCC stale-permission healing** — detect "Failed to match existing code requirement for subject <bundle-id>" in `log show --last 3m`, then `tccutil reset <Service> <bundle-id>` and re-prompt; also a manual "重置失效授权" action. We rely on a stable signing identity instead, but the healing path is the right fallback when the cdhash changes (ad-hoc rebuilds).
4. **Copyable MCP config** — always give users the exact JSON + argv, not just an automatic write. Essential for third-party agents we don't know how to configure; complements our one-click writers.
5. **Per-agent connect with verification** — write → re-read → compare managed command/args → alert on mismatch; refuse to overwrite a same-name foreign config (blocked state). Our `agentsConnect` writes configs; add read-back verification + blocked detection.
6. **Drag-app-into-Settings permission guide** — a non-activating floating panel that survives while System Settings is frontmost and lets the user drag the app bundle into the privacy list. Big first-run UX win; also gives the correct pane deep-link.
7. **Pause as a first-class file marker** checked by the bridge (`~/Library/Application Support/…/paused`) — we have `pauseActive()`/`markPause()`; expose it in-window with the same footer/menu unification.
8. **Engine/service check watchdog** — 10 s timeout + re-entrancy guard on the background probe; prevents double-spawned checks and hung UI.
9. **Lazy, cached sub-pages** — build once, toggle `isHidden`; cheap navigation, no layout churn.
10. **Accessibility labels** — `setAccessibilityLabel` on icon-only buttons and switches ("关闭控制台", "连接 <agent>") — cheap and worth copying.

---

## 8. Capture caveats / what is not the real product state

1. **Temp bundle, not installed app.** The app was not installed under `/Applications`, so the other-agent page renders the temp executable path `…/tmp/ccu-ref/Claude CU Bridge.app/Contents/MacOS/Claude CU Bridge` as the MCP `Command`. On a real install `managedExecutable` resolves to `/Applications/Claude CU Bridge.app/Contents/MacOS/Claude CU Bridge` (`Launcher.swift` L191-192). Look at the layout/tokens, not that string.
2. **DeepSeek Harness row shows "暂时无法读取连接设置".** This Mac's `~/.dsh/profiles/desktop/cordis.patch.yml` already contains a `claude-native-cu` managed block whose exact text does not match the reference helper's owned block (`args: [ '--mcp' ]` with spaces vs. the helper's `args: ['--mcp']`), so `deepseek-connection.mjs` exits 1 with "同名连接已存在或已修改"; the UI maps that to the generic blocked detail. This is honest app behavior, and the read path is read-only — **no config files were modified**. Codex row shows "未在这台 Mac 找到" (`agent-paths.json` has no codex; codex is not installed).
3. **Two permission states were captured.** Granted state comes from launching the binary from the shell (the temp binary inherits AX/SC trust from the responsible process); the unauthorized state comes from launching through LaunchServices (`open -n`), which gives the ad-hoc bundle no TCC grant. Neither is a true "first run with TCC dialog" state — the permission dialog itself was not captured (we avoided TCC prompts entirely).
4. **Permission-guide panel was captured from a patched /tmp copy.** A copy of `Launcher.swift` under `/tmp/ccu-ref-guide/` got a `--snapshot-guide` hook that calls `showPermissionGuide(screen:false)` with the `NSWorkspace.open(System Settings)` call suppressed, then snapshots the panel's contentView. The repo copy was not touched. Also the guide's drag-row app icon is loaded from `AppIcon.icns` directly in the patched copy (an unregistered /tmp bundle's `NSWorkspace` icon may differ). Note the guide's detail label is only 34 pt tall / 275 pt wide: the intended second sentence ("如未自动添加，可将下方应用卡片拖入列表。") clips — a real design bug to fix when porting (height ≈ 48 pt, or shorter copy).
5. **Status menu and app menu are mapped from source, not screenshots** — the temp app's menu-bar extra was never opened (capturing menu bar extras of a foreign process was out of scope). Their content/order is exact from `Launcher.swift` L526-591.
6. **Cached snapshot = transient state.** `claude-cu-main-window-cached-snapshot.png` is the actual `--snapshot-ui` output; it fires after agent states load but before the engine probe returns, so the card reads "执行引擎 · 检测中". The screen captures show the settled "已加载 · 66 个原生接口" state.
7. **Our console was captured on a live machine.** `ours-console-before.png` was obtained by posting `local.cu.showConsole` to the running `/Applications/Computer Use.app` (`--quiet`), then closing the window via its close button. No settings changed; the app's pre-existing 3 s refresh timer keeps writing its own runtime state (`~/.cu/…`) as usual.
8. **Not captured:** TCC system dialogs, live copy "已复制" feedback, toggle failure alert sheet, pause footer state, status-menu popup, menu-bar item rendering.
9. **Fonts:** reference uses system UI fonts (PingFang SC for Chinese at these sizes); captures were taken at Retina scale, so text rasterization is identical to the real app on this OS version.
10. **No leftover state:** temp bundles live only under `/tmp/ccu-ref/`, `/tmp/ccu-ref-guide/`; all temp app processes were terminated; the `claude cu` repo git status is clean (see §10).

---

## 9. Build & capture recipe (reproducible)

```sh
REF="/Users/johnkwok/Downloads/work/claude cu/src"
APP="/tmp/ccu-ref/Claude CU Bridge.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
xcrun swiftc "$REF/Launcher.swift" -target arm64-apple-macosx15.0 -O \
  -o "$APP/Contents/MacOS/Claude CU Bridge" \
  -framework AppKit -framework ApplicationServices -framework CoreGraphics \
  -Xcc -fmodules-cache-path=/tmp/clang-cache
cp "$REF/bridge.mjs" "$REF/deepseek-connection.mjs" "$APP/Contents/Resources/"
printf '/opt/homebrew/bin/node\n' > "$APP/Contents/Resources/node-path.txt"
printf '{}\n' > "$APP/Contents/Resources/agent-paths.json"      # codex not installed
iconutil -c icns "$REF/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"
# minimal Info.plist: CFBundleIdentifier local.claude-native-cu-bridge, CFBundleExecutable
#   "Claude CU Bridge", CFBundleIconFile AppIcon, LSMinimumSystemVersion 15.0,
#   CFBundlePackageType APPL, NSHighResolutionCapable
codesign --force --sign - --identifier local.claude-native-cu-bridge "$APP"

# main window, granted/loaded state (launched from shell), real-window PNG:
"$APP/Contents/MacOS/Claude CU Bridge" --snapshot-ui /tmp/ccu-ref/main-cached.png &
screencapture -x -l <windowId> -o /tmp/ccu-ref/main-screen.png

# main window, unauthorized CTA state (launched via LaunchServices):
open -n -a "$APP" --args --snapshot-ui /tmp/ccu-ref/main-ungranted.png

# other-agent page:
"$APP/Contents/MacOS/Claude CU Bridge" --show-connection --snapshot-ui /tmp/ccu-ref/other-agent-cached.png &

# permission guide: patched /tmp copy, --snapshot-guide hook (System Settings open suppressed)
# → /tmp/ccu-ref/permission-guide-cached.png

# our current console:
swiftc -O -o /tmp/ccu-ref/post-notif - <<'SWIFT'
import Foundation
DistributedNotificationCenter.default().postNotificationName(
  NSNotification.Name("local.cu.showConsole"), object: nil, userInfo: nil, deliverImmediately: true)
SWIFT
/tmp/ccu-ref/post-notif   # then screencapture -x -l <windowId> -o ours-console-before.png
```

`--snapshot-ui` writes a `cacheDisplay` PNG and, per `Launcher.swift` L402-412, skips daemon start
and all TCC prompts — safe to run on a live machine (window flashes, takes focus briefly).

---

## 10. Cleanup verification

- Temp app / helper processes: `pgrep -fl "MacOS/Claude CU Bridge"` → none after capture; guide app
  terminated itself via `NSApp.terminate`; helper `post-notif` is a short-lived one-shot.
- Reference repo: `cd "/Users/johnkwok/Downloads/work/claude cu" && git status --short` → **empty**
  (verified before and after; only pre-existing `src/` build artifacts were read, nothing written).
- Our repo: only `docs/ui/reference/` was written by this task; no commits.
- Agent configs: nothing written (`~/.dsh` untouched; the reference read path `get` is read-only).
