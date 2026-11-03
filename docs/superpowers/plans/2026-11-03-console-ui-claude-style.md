# Console UI port — Claude CU Bridge → Computer Use control panel

Date: 2026-11-03
Spec: `docs/superpowers/specs/2026-11-03-console-ui-claude-style-design.md`
Reference audit: `docs/ui/reference/claude-cu-ui-notes.md` (+ 7 renders)
After renders: `docs/ui/console-after/`
Status: implemented; independent verification in `docs/ui/verify/VERIFICATION.md`

## Goal

Replace the old 660×470 tabbed console (代理/连接/使用/设置/诊断) of the native
`Computer Use.app` with a control panel at the quality of the retired Claude CU
Bridge: borderless vibrancy window, hero lockup, permission CTAs, per-agent
connect switches, a service status card, a copyable MCP configuration page and a
floating drag-to-authorize guide — without losing a single existing capability.

## Architecture

- **`engine/Sources/ConsoleKit.swift`** — design tokens (520×780 window, 472×13 pt
  cards, 0.08/0.34 text ramp), primitives (flipped container, card, separator,
  subtle/pill/icon buttons, app icons), `CUConsoleModel`/`CUConsoleSettings`,
  `CUConsolePage`, and the small components: permission row, agent row (native
  `NSSwitch`), service card, footer.
- **`engine/Sources/ConsolePages.swift`** — the five pages, absolute-frame layout:
  概览, 连接与使用, 设置, 诊断, 接入其他 agent; plus the floating
  `CUGuidePanel` and its draggable app row.
- **`engine/Sources/ConsoleWindow.swift`** — borderless `CUConsoleWindow`
  (`NSVisualEffectView(.underWindowBackground)`, radius 25), scroll hosting, page
  navigation (pinned close/back), footer updates, `captureSnapshot`, guide
  snapshot, `selftestReport`.
- **`engine/Sources/ConsoleApp.swift`** — the new `MenuBarController`: menu-bar
  item and status menu (unchanged semantics + 复制 MCP 配置 / 接入其他 agent… /
  重置失效授权), 2 s refresh loop, model building, agent connect/disconnect,
  settings save, diagnostics, TCC heal, one-shot snapshot/selftest modes, and the
  window-close focus hand-back.
- **`engine/Sources/main.swift`** — legacy `MenuBarController` + its two
  extensions removed; added `agentsDisconnect`, `mcpConfigurationJSON/Text`,
  `appVersion`, `resetTCCPermission`, `healStalePermissionsIfNeeded`, the
  `agents-disconnect` CLI command, and the new `runMenuBar` one-shot arguments.
- **`engine/build.sh`** — compiles `Sources/*.swift` instead of only `main.swift`.

## Behavior changes (all additive except the visual replacement)

- Agent connection is a first-class row: app icon, live detail sentence and a
  switch that writes/removes our MCP entry (`agentsConnect` /
  new `agentsDisconnect`, both with `.bak-cu` backups). Managed agents (Qoder)
  keep an informational row. The bulk “一键连接” stays in the menu.
- Permission rows show a green dot + “已允许”, or a “去授权” pill that opens the
  exact privacy pane, raises the system prompt and shows the floating guide.
- The guide (360×150, non-activating `.popover` panel) contains a draggable
  “Computer Use” app card and “重启生效”; fixes the reference's clipped detail.
- “接入其他 agent” page gives the exact MCP JSON with copy feedback; the menu has
  the same payload as 复制 MCP 配置 (new `mcpConfigurationText()`).
- Service card replaces the old menu-only status: state line, port/pid/online
  clients/current activity, 检测 and 重启.
- 连接与使用 / 设置 / 诊断 are still there, now as calm sub-pages reachable from
  the footer; all fields and semantics are unchanged.
- TCC: `healStalePermissionsIfNeeded()` runs 3 s after launch **only when a grant
  is missing** and only when the last 5 min of `tccd` log shows a stale
  code-requirement for `local.cu.app`; the manual 重置失效授权 refuses to run when
  both grants are healthy.
- Focus: the console still activates only when the user opens it, and closing it
  now hands focus back to the previously frontmost app (`applicationDidBecomeActive`
  handles stray activations as before).
- Test hooks: `cu menubar --selftest-ui`, `--snapshot-console <png>
  [--snapshot-page …]`, `--snapshot-guide <png>`. One-shot processes skip the
  menu-bar instance lock and never retire the running copy.

## Verification

Independent verification (teammate `verifier`, task-3): **9/9 required checks PASS**,
report and evidence in `docs/ui/verify/VERIFICATION.md` (+ `snapshots/`, `live/`).
It re-derived the selftest contract, all five page renders, the guide render, focus
hand-back on close (two rounds), the read-only live walkthrough, and confirmed the
menu-bar instance survives every one-shot hook.

Review findings fixed afterwards (Lead): F1 manual TCC reset now only resets the
missing grant(s); F2 footer labels are populated whenever the window is built, so
one-shot snapshot PNGs show `v0.1.0` / pause state; F3 agent-row retain cycle removed
(weak `row` capture); F4 `--snapshot-guide` added to the `app`-case one-shot guard and
to the permission/heal gate; F5 window height clamps to `NSScreen.visibleFrame` (pages
scroll); F7 stale empty-state label removed; F6 spec drift corrected.

Final deployed state: `/Applications/Computer Use.app` reinstalled 13:03, service
buildId `5fca1aa50b51…`, accessibility + screen recording true, paused false.
`engine/tests/console_ui.py` against the reinstalled bundle: 4/4 PASS (selftest,
5 snapshots, guide, menu-bar survival). `run_all.sh --quick` green. Plugin node suite
**26/26 pass** on a quiet machine (the earlier single batch-preview failure was the
capture-daemon timing flake noted by the verifier; it did not reproduce).

Run `engine/tests/console_ui.py` (added to `run_all.sh`), plus:

```bash
cd engine && ./build.sh
"/Applications/Computer Use.app/Contents/MacOS/Computer Use" menubar --selftest-ui
"/Applications/Computer Use.app/Contents/MacOS/Computer Use" menubar \
  --snapshot-console /tmp/console.png --snapshot-page overview
```

Live checks performed during implementation:

- selftest JSON: 5 pages, 2 permission rows, 4 agent rows / 3 switches, MCP page
  contains `mcpServers`, menu items present, borderless 520×780 window.
- Snapshot of every page renders 1040×1560 @2x; live window capture of 概览 shows
  the active (blue) switches; guide renders 720×300 @2x.
- Agent switch round trip: WorkBuddy entry removed from `~/.workbuddy/mcp.json`
  (backup written) and restored; the row detail and switch follow the real state.
- Copy button flips to 已复制 and the pasteboard contains the MCP JSON.
- Pause icon latches the pause marker and flips to 继续电脑操作; diagnostics shows
  暂停：是.
- Closing the console returns frontmost to the previously active app (verified
  DeepSeek Harness → Computer Use → DeepSeek Harness).

## Notes / follow-ups

- `install-service.sh` can leave the service in `bind_failed` retries for ~10–15 s
  after a reinstall while the old process exits; launchd eventually recovers.
  Waiting for the port to be free before `bootstrap` would remove the papercut.
- The one-shot snapshot process cannot become the key window (macOS blocks
  background activation), so its PNGs render controls in their inactive style.
  Evidence of the active appearance uses a live window capture
  (`docs/ui/console-after/console-overview-live.png`).
