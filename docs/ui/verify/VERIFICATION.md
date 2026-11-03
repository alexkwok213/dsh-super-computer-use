# Console UI port — independent verification

Date: 2026-11-03 (verified 12:44–13:00 CST)
Verifier: `verifier` teammate (independent of the implementation)
Task: task-3 — verify the Claude-CU-style console port (task-2) and add a regression test.
Method: re-derive everything from the artifacts, the installed app and the hooks; do not
trust the implementation notes. Every check below has an honest result.

## Environment

| Item | Value |
|---|---|
| macOS | 27.0 (build 26A428), arm64 |
| Screen | 3456×2234 Retina → 1728×1117 logical (window 520×780 fits) |
| Installed app | `/Applications/Computer Use.app` — binary sha256 `788a02a7e05a…b76090b3`, built 12:43:28, signed *Apple Development* (`local.cu.app`) |
| Running menu-bar instance | pid 70160 (`…/Computer Use app --quiet`), never restarted by this verification |
| Running service | pid 70237, port 47777, accessibility=true, screenRecording=true, paused=false |
| Repo revision at verification | `main` @ `398dedb` + uncommitted work: `M main.swift`, `M build.sh`, `M README.md`; new `ConsoleKit/ConsolePages/ConsoleWindow/ConsoleApp.swift`, `docs/ui/**`, `docs/superpowers/specs/**` |
| Source hashes verified | ConsoleKit `fa0b1684…`, ConsolePages `d7400349…`, ConsoleWindow `26940780…`, ConsoleApp `18e6c089…`, main.swift `fd82236e…`, build.sh `2fd239d0…` |
| `engine/bin/cu` after `./build.sh` | rebuilt from source at 12:48, sha256 `e466607c…` (see check 2) |

Note: **after** this verification the Lead continued editing (`ConsoleWindow.swift` now
`b01269ce…`, `install-service.sh` modified, `engine/bin/cu` rebuilt to `098a3634…`).
The installed app still carries the 12:43 build. The Lead's final reinstall must re-run
`engine/tests/console_ui.py` against the reinstalled bundle.

## Per-check results

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Code review of the four new/changed Swift files vs spec | **PASS with findings** (1 medium, 4 low, nits — none blocking) | Findings F1–F7 below |
| 2 | `cd engine && ./build.sh` | **PASS** | exit 0; `built …/engine/bin/cu`; `./bin/cu perms` → accessibility/screenRecording true. 2 distinct warnings: **new** deprecation `activateIgnoringOtherApps` at `ConsoleApp.swift:364`; **pre-existing** duplicate literal `case "cursor-overlay"` at `main.swift:5611` (present in `HEAD` too — `git show HEAD:…` also has 2 occurrences) |
| 3 | `menubar --selftest-ui` on installed app | **PASS** | exit 0, stderr empty, valid JSON (1480 bytes; `docs/ui/verify/selftest-installed.json`). Asserted: `ok=true`, `pages=[overview,connections,settings,diagnostics,agentSetup]`, `pageCount=5`, `permissionRows=2`, `agentRows=4 (≥1)`, `windowBorderless=true`, `windowWidth=520`, `windowHeight=780`, `windowVisible=false`, `configurationContainsMCPServers=true`, `menuCopyConfiguration/menuResetPermissions/menuAgentSetup=true`; `configuration` parses as JSON with `mcpServers["computer-use"]` containing `command`+`args`. Frontmost before/after = DeepSeek Harness pid 61392 (focus untouched); menu-bar pid 70160 alive |
| 4 | `--snapshot-console` for all five pages | **PASS (layout defect F2)** | each: exit 0, `ok=true`, `via=screencapturekit`, real `windowId>0`, PNG 1040×1560 = 520×780 @2x (IHDR), 129 KB–283 KB (non-blank), focus returned to DeepSeek Harness, no console window left, menu-bar pid alive. Programmatic pixel stats (≤64-colour buckets saturated, mean/std luminance 223–230 / 23–45) confirm real content. Page-by-page visual pass in `docs/ui/verify/snapshots/`: overview, connections, settings, diagnostics, agent-setup all lay out cleanly; only defect is the missing footer version label (F2). `windowKey=false` → controls render in inactive style (switches grey even though JSON `switchOn=3/4`) — matches the documented snapshot limitation, not a bug |
| 5 | `--snapshot-guide` | **PASS** | exit 0, `ok=true`, `via=panel-bitmap`, PNG 720×300 (=360×150 @2x), 42,471 bytes; content correct: ↑, 辅助功能授权, three-line detail, draggable “Computer Use” card + 重启生效, close ✕. Focus returned |
| 6 | Focus discipline (open via notification → close) | **PASS (2 rounds)** | Round 1: frontmost DeepSeek Harness (61392) → notification → Computer Use (70160) frontmost, borderless 520×780 window `windowId 18476` at 604,88 → AX click 关闭控制台 → after 1.6 s frontmost **DeepSeek Harness (61392)**, no `Computer Use` window. Round 2 (window reuse, same `windowId 18476`): same result. No case of focus sticking to the windowless process |
| 7 | Read-only live UI walkthrough | **PASS** | Opened console (live screenshots `docs/ui/verify/live/`). Footer 设置 → page rendered, back 返回 works; 诊断 → page rendered incl. report text; 连接与使用 → client + usage rows; ＋其他 agent → agent-setup page with full MCP text. **复制配置指令** → AX title flips to `已复制` and reverts to `复制配置指令` after 1.8 s. Clipboard was pre-set to a sentinel, then the click replaced it with the documented payload; JSON inside the payload parses (`mcpServers["computer-use"]` with command/args/env) — so the button really writes. Closed with 关闭控制台. Nothing else clicked (no agent switch, no 保存, no 去授权, no 重置). State unchanged: `~/.cu/config.json`, `~/.claude.json`, `~/.workbuddy/mcp.json`, Claude Desktop config all sha256-identical before/after; no `~/.cu/pause`; service still ok/pid 70237 |
| 8 | New regression test `engine/tests/console_ui.py` + wiring | **PASS** | File: `engine/tests/console_ui.py` (stdlib only, prefers installed app, falls back to `engine/bin/cu`, `CU_CONSOLE_UI_BIN` override; `--keep` keeps temp PNGs). Output: 4 PASS lines (selftest / 5 snapshots / guide / menu-bar survival), exit 0, ~8.4 s. Also passes with `CU_CONSOLE_UI_BIN=engine/bin/cu`; skips cleanly (exit 0) when no engine binary. Wired into `engine/tests/run_all.sh` **full section** (line 28, `== console ui`), not `--quick` because snapshots briefly activate the console. `bash -n` clean. Re-ran after the Lead's 13:00 rebuild of `engine/bin/cu` (newer `ConsoleWindow.swift`): still exit 0. |
| 9a | `engine/tests/run_all.sh --quick` | **PASS** | exit 0. 10 test files, all green: unittest runs 3, 11, 7, 9, 7, 22, 5, 4 tests (`OK`), plus suite summaries `28 passed, 0 failed` and `35 passed, 0 failed` (full log `docs/ui/verify/run_all_quick.log`) |
| 9b | Plugin node tests (`node --test test/core.test.mjs test/plugin_observation.mjs test/plugin_lifecycle.mjs test/capture_daemon.mjs`) | **25 pass / 1 fail (recorded, not caused by this port)** | `test/core.test.mjs:396` “Batch should include final preview” fails deterministically (also alone). The batch preview path depends on the plugin's **capture-daemon** helper; unrelated to the console UI (see out-of-scope note). Plugin sources untouched by the port (`git status` shows no `lib/` or `test/` change), and the capture-daemon code region is byte-identical to `HEAD` (first `main.swift` diff hunk starts at line 3896, after the daemon class). Log: `docs/ui/verify/node_tests.log` |

**Overall: 9/9 required checks PASS**; 1 pre-existing plugin-test failure recorded for the
Lead's decision; 1 medium + 4 low code-review findings, all with suggested fixes.

## Code-review findings

Severity: blocker / high / medium / low / nit. Nothing here is a blocker.

- **F1 — MEDIUM — manual “重置失效授权” can revoke a working grant.** `ConsoleApp.swift:480–491`
  (`resetStalePermissions`): when *either* grant is missing it calls `resetTCCPermission("Accessibility")`
  **and** `resetTCCPermission("ScreenCapture")` (lines 487–488) — so a missing Screen
  Recording grant also resets a healthy Accessibility grant, forcing the user to re-grant
  and (temporarily) breaking the product. The *automatic* heal is correct (per-service,
  guarded by `!AXIsProcessTrusted()` / `!CGPreflightScreenCaptureAccess()`, lines 83–90,
  and evidence-gated by the tccd log). Suggested fix: in `resetStalePermissions`, reset
  only the service(s) whose preflight check is false (or call the same per-service helper
  the heal uses).
- **F2 — LOW — footer version/pause labels are empty in every one-shot snapshot** (live UI
  is correct). `CUConsoleController.update(model:)` updates the footer *before* its
  `if window == nil { return }` guard (`ConsoleWindow.swift:232–233`), and `show(page:)`
  (`:183`) never calls `footer.update`; a one-shot process builds the window only afterwards,
  so `v0.1.0` / pause state stay blank in `--snapshot-console` PNGs. Measured: 0 dark
  pixels in the footer-left region of snapshot renders (installed + rebuilt + the earlier
  `console-after/console-overview.png`), vs 426 in the live capture. In normal use the 2 s
  refresh timer fills it in (≤2 s after first open). Suggested fix: call `footer?.update`
  in `show(page:)` after `ensureWindow()` (or move it after the nil-window guard).
- **F3 — LOW — retain cycle in agent rows.** `ConsolePages.swift:145–151`:
  `row.onToggle = { … row.update(…) … }` stores a closure on `row` that captures `row`
  strongly → `CUAgentRow` ⇄ closure cycle; rows leak when the agent id list changes
  (and the controller/console can never deallocate). Bounded (4 rows, rebuilt only when the
  catalog changes), so no user-visible symptom today. Suggested fix: capture `row` weakly
  (`[weak self, weak row]`) or update via `self.agentRows[index]`.
- **F4 — LOW — one-shot guard is duplicated and misses `--snapshot-guide`.**
  `main.swift:5625` (`case "app"`) treats only `--selftest-ui` / `--snapshot-console` as
  one-shot; `--snapshot-guide` is absent, so `Computer Use … app --snapshot-guide` would
  post `local.cu.handover` and retire the running menu-bar instance. The documented
  `menubar --snapshot-guide` path is safe (verified), so this is latent/inconsistent, not a
  live bug. Related: `--snapshot-guide` is also not excluded from the launch-time
  `requestPermissionsIfMissing()` / TCC-heal scheduling (`ConsoleApp.swift:206`), so in a
  machine with missing grants that one-shot could raise consent dialogs. Suggested fix:
  compute one `oneShot` from the args once and use it for both the handover gate and the
  permission/heal gate.
- **F5 — LOW — fixed 520×780 window is never clamped to the visible screen.**
  `ConsoleWindow.swift:81–92`: `window.center()` with no `visibleFrame` clamping or
  minimum-screen handling; on a display whose visible height < 780 pt the pinned footer
  would be partly off-screen. Cannot be tested here without changing the resolution
  (not done — would change user state); logic review only. Suggested fix: clamp
  `window.frame` into `screen.visibleFrame` on show.
- **F6 — NIT — spec drift.** Spec says a single new file `ConsoleUI.swift`; implementation
  is four files (`ConsoleKit/ConsolePages/ConsoleWindow/ConsoleApp`) — benign, build.sh
  compiles `Sources/*.swift`. Spec also says refresh timer 3 s; code uses 2 s — docs drift
  only.
- **F7 — NIT — stale empty-state label.** `ConsolePages.swift:155–159`: the
  “没有可接入的 agent。” label is only removed with the rows loop, not when the agent list
  becomes non-empty later; unreachable today (4 fixed agent specs). Suggested fix: remove
  it in `rebuildAgentsIfNeeded` when `!agents.isEmpty`.

Things that were checked and look correct: closures in `CUConsoleController.init` /
footer / permission rows / pages all use `[weak self]`; array iteration is bounds-guarded
(`index < model.agents.count`); page heights (700/660) fit the 736 pt page area and the
footer is outside the scroll; automated TCC heal never touches a working grant;
`agentsDisconnect` preserves foreign config keys, writes `.<path>.bak-cu` before an atomic
write and bails out on unreadable/malformed JSON instead of clobbering; snapshot/selftest
skip the single-instance lock and never post handover (verified live: pid 70160 survived
all of them); the multi-file rename did not change the signing flow.

## Test file and invocation

```bash
cd engine && python3 tests/console_ui.py            # installed app (fallback engine/bin/cu)
CU_CONSOLE_UI_BIN=$PWD/engine/bin/cu python3 engine/tests/console_ui.py   # explicit binary
./tests/run_all.sh                                  # full section now includes it
```

What it asserts: selftest JSON contract (page list/count, permission rows, agent rows,
borderless 520×780, MCP config parses with `mcpServers["computer-use"]`, three menu items,
no visible window left); each of the five pages renders a non-blank 1040×1560 PNG through
one of the two allowed capture paths and reports a real window id; guide renders 720×300;
after every hook the Computer Use process is not frontmost and no console window remains;
the running `app --quiet` menu-bar instance survives the whole sequence (skipped if not
running). No config/permission/service state is touched.

## Out-of-scope observation (reported, not chased)

The one failing plugin node test is the batch **inline preview**
(`core.test.mjs:396`): the plugin first tries its warm `capture-daemon`, then falls back to
`cu shot`. During this verification the installed engine's `capture-daemon` behaved
inconsistently (one run returned `capture_failed` after an 8 s timeout; direct `cu shot` on
the same window succeeded; later re-runs of the same request returned base64 immediately).
A HEAD-built copy of the pre-port sources shows the same capture-daemon code (the first
UI-port diff hunk is at main.swift:3896, far below the class), so this is not attributable
to the console UI work; root-causing it is outside task-3 and was stopped per the Lead's
timebox. If `capture-daemon` truly fails, the batch preview stalls ~12 s, the demo window
(10 s lifetime) expires, and the preview assertion fails — that matches the observed
failure. Recommended follow-up: an A/B of `capture-daemon` smoke behaviour on the next
deployed build (one scenario: daemon request right after spawn) before deciding whether
this is a regression from the install or an environment/SCK issue.

## Residual risks / follow-ups

1. Reinstall the app from the final sources (Lead) and re-run `engine/tests/console_ui.py`
   + the five-page snapshots; the binary I verified is the 12:43 build while
   `ConsoleWindow.swift` changed afterwards.
2. F1 (TCC manual reset scope) and F2 (footer labels in snapshots) are the two most
   user-visible findings; F3/F4/F5 are cleanup.
3. The one-shot snapshot cannot render active control styling (`windowKey=false`); if
   active-appearance evidence is needed, keep using a live window capture (as in
   `docs/ui/verify/live/live-overview.png`).
4. The node plugin suite needs a decision on the batch-preview/capture-daemon failure
   (see out-of-scope note) — not fixed here.

## Machine state left behind

- Rebuilt `engine/bin/cu` via `./build.sh` (gitignored; source-identical to the verified
  working tree at that time). Installed app untouched, no reinstall, no service/menu-bar
  restart; pid 70160 and service pid 70237 still running.
- Added `engine/tests/console_ui.py`; one line added to `engine/tests/run_all.sh`.
- Added this report + evidence under `docs/ui/verify/` (snapshots/, live/, selftest JSON,
  regression logs). No product source modified.
- UI: console opened twice and closed twice with the 关闭控制台 pill; no console window
  left, no stray one-shot process. Clipboard returned to its pre-check content (the same
  MCP instruction text it held before — verified identical).
- No settings saved, no permission reset, no pause latch, no agent switch toggled, no agent
  config written, no system dialog triggered.

## Post-verification fixes (Lead, 13:03–13:07)

The Lead fixed every finding in this report after the verification above:

- **F1 (medium) fixed** — `resetStalePermissions` now resets only the grant(s) whose
  preflight check is false; a healthy grant is never touched.
- **F2 fixed** — `CUConsoleController.show(page:)` populates the footer, so one-shot
  `--snapshot-console` PNGs now show `v0.1.0` and the pause state (verified by cropping
  the footer strip of the final overview render).
- **F3 fixed** — `CUAgentRow.onToggle` captures its row weakly; no retain cycle.
- **F4 fixed** — `Computer Use … app --snapshot-guide` is now treated as one-shot
  (no handover, no launch-time permission prompt/heal).
- **F5 fixed** — the 520×780 window is clamped to `NSScreen.visibleFrame`; on a
  shorter display it shrinks and the pages scroll instead of losing the footer.
- **F7 fixed** — stale “没有可接入的 agent。” label is removed when agents appear.
- **F6 fixed** — spec now names the four files and the 2 s refresh timer.

Reinstalled `/Applications/Computer Use.app` at 13:03 (service buildId
`5fca1aa50b51…`, accessibility + screen recording true, paused false) and re-ran the
required checks: `engine/tests/console_ui.py` → 4/4 PASS (selftest, five page
snapshots at 1040×1560, guide 720×300, menu-bar survival, focus kept);
`run_all.sh --quick` green; plugin node suite **26/26 pass** (the batch-preview /
capture-daemon failure from §“Out-of-scope observation” did not reproduce on a quiet
machine — treat as a timing flake unless it recurs). Final renders are in
`docs/ui/console-after/` (including a live overview capture showing the active
control styling).
