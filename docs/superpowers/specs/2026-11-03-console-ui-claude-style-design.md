# Console UI refresh — porting Claude CU Bridge's control panel

Date: 2026-11-03
Status: proposed (awaiting user approval)
Author: Lead
Reference implementation: `/Users/johnkwok/Downloads/work/claude cu/src/Launcher.swift` (869 lines, AppKit, programmatic)
Reference renders: `docs/ui/reference/` (produced by task-1)

## Intent

`dsh-super-computer-use` already has the better engine, the better agent surface
(12 `cu_*` tools + skill + capsule/halo/cursor overlay) and measured performance.
What it does not have is a control panel that a normal person would call good-looking.
The Claude CU Bridge (our old bridge to Claude's own engine) does, and the user wants
that quality learned from it.

This design ports Claude CU Bridge's **control-panel design language and interaction
model** into the native engine's menu-bar app (`Computer Use.app` →
`MenuBarController` in `engine/Sources/main.swift`), without giving up any of our
existing functionality.

The bridge itself is redundant: it depended on binaries inside `/Applications/Claude.app`
(`computer_use.node`, `claude-native-binding.node`, `app-cu-helper`) and on Claude's
internal, undocumented interfaces; it is no longer installed on this Mac. Nothing in
this work re-introduces a dependency on Claude.

## What Claude CU Bridge does well (audited)

Visual system
- Borderless rounded vibrancy window (520×670, material `.underWindowBackground`,
  cornerRadius 25, 0.7 pt separator border, movable by background, no title bar).
- Hero header: 64 pt app icon (continuous radius 14, white hairline border),
  23 pt bold title, 14 pt secondary subtitle, all centered.
- Section headers 14 pt medium + 13 pt secondary explainer; 472 pt-wide translucent
  cards (radius 13, 0.7 pt border, internal hairline separator).
- Permission rows: 32 pt icon tile with blue SF Symbol, 14 pt title / 12 pt detail,
  7 pt green status dot when allowed, and a blue pill "去授权" CTA when not.
- Agent rows: real app icon from `NSWorkspace`, live state sentence, `NSSwitch` that
  writes/removes the real MCP config, disabled when the agent is absent.
- Engine status card: green/orange state line, version + native-interface count +
  check time, "检测" button with timeout and re-entrancy guard.
- Footer: version left, pause state right.
- In-window page navigation (no tab bar): back chevron + close pill; a numbered "01"
  card with read-only monospaced MCP JSON and a copy button that flips to "已复制".
- Floating permission guide: borderless non-activating `.popover` panel with "↑",
  a draggable app-card row (drag the app into the System Settings list), "重启生效".
- Menu-bar item + rich status menu (console, copy MCP config, pause, permission
  shortcuts, reset stale permission, refresh, restart, quit).

Interaction
- Live state on a 1.5 s timer, on app activation and on menu open.
- Permission CTA opens the exact System Settings pane and shows the floating guide.
- TCC stale-grant self-heal: when a grant is missing, scan `tccd` log for a failed
  code-requirement match for our identifier, `tccutil reset` that service, re-prompt.
- Machine-checkable UI hooks: `--selftest-ui` emits JSON assertions, `--snapshot-ui`
  writes a PNG of the window. Tests drive those instead of eyeballing.

## Goals

1. The menu-bar console looks and feels like the Claude CU Bridge control panel:
   same visual language, same calm one-page hierarchy, same quality bar.
2. Every existing capability survives: agents table + one-click connect, live clients,
   tool usage, settings (port / screenshot size / pause-on-input / halo / allow-list),
   diagnostics (status, paths, log tail, copy), pause, permission shortcuts, restart.
3. New UX the bridge had and we lacked:
   - per-agent connect **toggles** (write *and remove* our MCP entry),
   - a "连接其他 agent" page with the exact MCP JSON and a copy button,
   - a floating "drag the app into the privacy list" permission guide,
   - "复制 MCP 配置" and "重置失效授权" in the status menu,
   - copy feedback ("已复制"), section explainers, live status sentences,
   - `--snapshot-console` and `--selftest-ui` hooks so this UI is testable,
   - TCC stale-grant self-heal (only when a grant is missing *and* the log proves it).
4. Keep the native engine's hard-won properties: no Dock icon, no focus stealing when
   idle, single menu-bar instance, same code-signing identity (TCC must survive).

## Non-goals

- No dependency on Claude.app, Codex, Kimi or any third-party binary.
- No new launchd agents, no new background processes, no network listeners.
- No redesign of the capsule / halo / cursor overlay (that is our own product's
  execution-time feedback and is already ahead of the bridge).
- No change to the 12 `cu_*` plugin tools or their output shapes.
- No dark-mode-specific artwork pass beyond what system materials give us for free.

## Anti-goals (this would be a failure even if it technically works)

- The console steals focus or appears unbidden while the user is typing.
- Settings no longer write `~/.cu/config.json`, or saving breaks the service.
- Menu-bar state colors stop meaning "service/permission/pause" at a glance.
- Porting the look at the cost of removing a working function (usage table, log tail).
- The TCC heal resets a working grant.

## Design

### Window
One borderless `CUConsoleWindow` (subclass: `canBecomeKey/canBecomeMain = true`):
520 pt wide × 780 pt tall, `NSVisualEffectView(.underWindowBackground, .behindWindow)`
with cornerRadius 25 and 0.7 pt separator border, `isMovableByWindowBackground`,
transparent background, no title bar. Close pill 27 pt top-right. Content pages are
`CUFlippedView` (top-left origin) inside a vertical `NSScrollView` when a page exceeds
the window; footer (version + pause state + pause button) is pinned, outside the scroll.

### Pages (in-window navigation, back chevron, no tab bar)

1. **概览 overview** (default)
   - hero icon + "Computer Use" + "让 agent 使用你的电脑"
   - 权限: explainer + card with 辅助功能 / 屏幕录制 rows (status dot + 去授权 pill)
   - 本地 agent: explainer + "＋ 其他 agent" subtle button + card of agent rows.
     Each row: app icon, name, live detail sentence from `agentsCatalog()`, and a
     switch (on = our MCP entry present). Managed agents (Qoder) show "由应用自身管理"
     and no switch. Switching off removes our entry (with `.bak-cu` backup).
   - 服务 card: colored state line ("● CU 服务 · 运行中" / "未运行"), detail
     "端口 47777 · N 个客户端 · 正在做：…", buttons 检测 / 重启.
   - Footer: version, "已暂停新调用" when latched, 暂停/继续 button, and text links
     连接与使用 / 诊断 / 设置.
2. **连接与使用 connections** — client rows (name, state, channel, last action, age,
   calls/latency) and tool-usage rows (tool, calls, avg, total), both as cards.
3. **设置 settings** — same fields and semantics as today, laid out in cards:
   服务端口, 截图长边上限, "你一动键鼠就暂停", "操作时显示窗口光环", allow-list editor,
   保存并重启服务 / 打开配置文件 / 打开系统设置.
4. **诊断 diagnostics** — status/permission/pause/frontmost/clients summary, config
   and log paths, 18-line log tail, 刷新 / 打开服务日志 / 复制诊断信息.
5. **接入其他 agent agent-setup** — numbered "01" card, monospaced read-only MCP JSON
   for the generic server name, one-line instruction, 复制配置指令 → "已复制" for 1.8 s.

### Visual tokens (copied from the bridge)
| Token | Value |
|---|---|
| Window | 520 × 780, `.underWindowBackground` vibrancy, radius 25, 0.7 pt border |
| Content inset | 24 pt sides, 472 pt card width |
| Card | radius 13, white 0.96 @ 0.64 alpha, 0.7 pt separator border, hairline internal separator |
| Title | 23 pt bold, centered |
| Subtitle | 14 pt regular, calibratedWhite 0.34 |
| Section header | 14 pt medium |
| Explanation | 13 pt, secondary |
| Row title / detail | 14 pt medium / 12 pt secondary |
| Icon tile | 32 pt, radius 9, quaternary 6 % fill, blue SF Symbol 22 pt |
| Status dot | 7 pt circle, systemGreen when allowed |
| Pill CTA | radius 13, systemBlue 10 % fill, 13 pt blue text |
| Subtle button | radius 9, black 3.5 % fill, 13 pt medium |
| Footer | 12 pt secondary, right-aligned pause state |

All layout is manual frames (the bridge's approach) with a small vertical-flow helper,
so the result is deterministic and snapshot-testable.

### Interaction rules
- Refresh: a 2 s timer updates labels in place; permission glyphs read
  `AXIsProcessTrusted()` / `CGPreflightScreenCaptureAccess()`; settings fields load
  only when the page is shown (never clobber typing).
- 去授权: `openSystemSettings(pane)` + floating guide, then re-prompt
  (`AXIsProcessTrustedWithOptions` / `CGRequestScreenCaptureAccess`) and refresh.
- Agent switch: read state → call connect/disconnect → re-read state → update row.
  Failure raises an `NSAlert` sheet with the reason. Never claim success from the call
  alone (same rule as the rest of the product).
- Menu: add 复制 MCP 配置, 接入其他 agent…, 重置失效授权; keep everything present today.
- TCC heal: only when a grant is missing; scan last 5 min of `tccd` log for
  "Failed to match existing code requirement" mentioning our identifier; on evidence
  `tccutil reset <service> local.cu.app` then re-prompt. Never touch a working grant.

### Test hooks
- `cu menubar --snapshot-console <path> [--snapshot-page overview|connections|settings|diagnostics|agent-setup]`
  — show the window in-process, wait for first model load, capture it with SCK
  (`capture(windowId:)`, fall back to content-view bitmap), write PNG, exit 0.
- `cu menubar --selftest-ui` — build the console offscreen, assert and emit JSON:
  page list, permission rows, agent row count, menu items, MCP config page content,
  copy payload parses as JSON, pause/restore round-trip, no visible window left.

New regression test `engine/tests/console_ui.py` drives both hooks and checks the PNG
dimensions and the JSON assertions; it is added to `engine/tests/run_all.sh`.

## My calls (decisions taken here, not by the user)

- **Keep all five existing functions**; they are folded into pages instead of being
  deleted. The bridge's one-page layout is the model for 概览 only.
- **No tab bar.** Navigation lives in the 概览 footer, the agent card and the menu.
  This is what makes the bridge feel calm; tabs would undo it.
- **Per-agent toggle over per-agent rows only for config-file agents.** Qoder is
  managed by its own app, so it keeps an informational row.
- **Snapshot via ScreenCaptureKit**, not view bitmaps, so the vibrancy render in the
  PNG is what users actually see.
- **TCC heal is evidence-gated** (missing grant + log evidence) plus an explicit menu
  item; we do not silently reset permissions.
- **The floating guide is a panel, not a window**, and never activates the app.

## Constraints

- Single Swift module, compiled by `engine/build.sh` (`swiftc -O -swift-version 5
  -target arm64-apple-macos14.0`); the console lives in four new files
  (`ConsoleKit/ConsolePages/ConsoleWindow/ConsoleApp.swift`) and `build.sh` compiles
  `Sources/*.swift`. No new frameworks, no package manager.
- Must keep the current signing identity flow (`engine/signing-identity`) so the
  Accessibility/Screen-Recording grants survive rebuilds.
- macOS 14+; the bridge was macOS 15+ because of Claude's binaries — we are not.
- UI strings in Simplified Chinese, matching the existing product.

## Verification

1. `cd engine && ./build.sh` builds; binary reports permissions.
2. `cu menubar --snapshot-console build/evidence/console-overview.png` renders the main
   page; snapshots for each page inspected by a human/vision pass.
3. `cu menubar --selftest-ui` JSON assertions pass (`engine/tests/console_ui.py`).
4. Focus discipline: with the menu bar idle, frontmost app unchanged before/after
   start and after snapshot runs (measured with `cu frontmost`).
5. Existing regressions: `engine/tests/run_all.sh`, plugin `node --test` suites.
6. Settings round-trip: save changes, service restarts, `/v1/status` reflects them.
7. Permission guide drag payload is the real app URL; TCC heal dry-run verified with a
   simulated log line (test seam) rather than by breaking a real grant.

## Open questions

None blocking. If the user prefers the bridge's exact 520×670 fixed-height feel over
a taller window with scrolling, the layout can be compacted in a follow-up.
