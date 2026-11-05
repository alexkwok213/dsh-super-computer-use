---
name: dsh-super-computer-use
description: macOS Computer Use / 桌面操控与自动化（剪映、微信、Finder、备忘录等后台操作与内嵌观看预览）。Control macOS desktop applications using background AX actions, floating status capsule/halo, and inline target window previews.
---

# macOS Computer Use (`cu_*` Tools)

Use `cu_*` tools to inspect and operate macOS desktop applications. For ordinary web browsing inside Chromium, use `browser-skill` (`bsk_*`) instead.

## Core Principles

0. **Ask `cu_status` Once, Then Stop Repeating Yourself**
   - `cu_status` reports `vision.supported` (`true`/`false`/`null` with a `reason`) and `lastImage` (what the last capture actually delivered). `false` or `null` means a screenshot is a file path, not evidence: do not reason about pixels, use `cu_find`/`cu_expect`/`cu_snapshot` instead.
   - While a session is running, `pid` and `windowId` may be omitted: actions, snapshots and screenshots fall back to the session's target. Pass them explicitly only to act on a different window.


1. **Background First (Never Steal the User's Pointer or Focus by Default)**
   - `cu_click`, `cu_type`, `cu_key`, and `cu_scroll` default to `foreground: false` (background execution via `AXPress` or PID-targeted events).
   - Only set `foreground: true` when an app's custom canvas or modal sheet explicitly requires foreground delivery, and ask/warn before taking foreground focus.

2. **Session Visibility & Target Preview (Claude + Codex Hybrid UX)**
   - Before operating on a target window, call `cu_session` with `action: "start"`, passing `windowId`, `pid`, `appName`, and `preview: true`.
   - This displays the non-activating top-right status capsule (`cu capsule`) and window border halo (`cu halo`) with a user Stop button, and returns an inline thumbnail preview of the target window in the chat.
   - By default the DSH window shrinks to the right third and the target window takes the left, so the user can watch the work. `cu_click`'s first automatic session also shrinks DSH (but never moves the target, because the click coordinates are already resolved). Pass `dockDsh: false` to leave the desktop untouched.
   - While a session is active the menu bar shows `● CU · REC` and macOS raises its screen-recording privacy indicator. Always call `cu_session` with `action: "stop"` when done: it restores both window frames and clears the indicator. A 15-minute safety timer does the same if the session is abandoned.

3. **AX Snapshot & Delta Observation First, Screenshot/OCR When Needed**
   - Start with `cu_windows` to find the target `pid` and `windowId`.
   - Call `cu_snapshot` (`pid`, `windowId`) to obtain element refs (`e1`, `e2`, ...).
   - Mutating tools (`cu_click`, `cu_type`, `cu_key`) support `observe: true` (enabled by default when `pid` is provided), which returns the AX delta (`+` added, `-` removed, `~` changed) in the same call.
   - Never assume `ok: true` means the business action succeeded—verify from the returned `observation` delta or a follow-up `cu_find` / `cu_screenshot` / `cu_expect`.
   - For canvas-heavy apps (such as video timelines or custom panels without AX nodes), use `cu_find` (`mode: "auto"` or `"ocr"`) or `cu_screenshot`.

4. **Respect User Pause / Stop**
   - If any tool returns `PAUSED_BY_USER`, stop immediately and ask the user before calling `cu_session(action="resume")`.

5. **Multi-Step Execution with `cu_batch` (Codex / Claude Fast-Action Loop)**
   - For compound tasks (e.g. click search box -> type keyword -> press return), prefer `cu_batch` instead of round-tripping to the model for each individual keystroke or click.
   - `cu_batch` runs all steps locally, updates the floating status capsule live, and delivers the single final observation delta + preview.
   - A step can be `{action: "expect", query/enabled/value/contains/ref, timeoutMs}`: it polls until the app reaches that state and, with `stopOnError`, stops the batch there. That is the checkpoint to use when the next step depends on loading. Blind `settleMs` (default 60 ms between steps) is only a fallback; it is reported in `timings.settleMs`.
   - `cu_batch` returns `budgetExceeded: true` when a run overshoots `timeoutMs` even if every step landed, so a slow run is never mistaken for a fast one.

6. **Post-Action Waiting and Verification**
   - Every mutating tool returns `observation.changed` (`true`/`false`/`null`), `observation.waitedMs` and `observation.reads`. The adapter re-reads the tree while it is still identical to the pre-action baseline, inside a short budget (~300 ms), so a sheet or search result that paints late is not missed. `changed: true` means the tree moved—not that the business action succeeded.
   - Pass `expect` to declare what the app must show: `{ query: "导入完成", timeoutMs: 2000 }`, or `{ ref, enabled, value, contains }`. The result then carries `verified: true|false` plus `verification`. `verified: false` means the action was dispatched but the app never showed that state: re-observe (and read `warning`) instead of replaying the click, which `actionReplaySafe: false` marks.
   - `cu_expect` runs the same check on its own, which is the right tool when the condition comes from an action you did not issue (user typing, a background import, another app's window).
   - A deterministic input followed by `expect` is the shortest reliable compound action; use `cu_batch` when the steps have no branch between them.

7. **Coordinates Must Come From the Current Frame**
   - Read coordinates from the observation you are looking at, not from an earlier window position or from memory.
   - `cu_click` refuses `point_outside_target_window` when the point is outside the target window's live bounds, and `window_geometry_changed` when the window moved or resized after your last `cu_snapshot`. Both are refusals, not transient errors: call `cu_snapshot` again and derive a new point. Never repeat the rejected numbers.
   - When a reliable control ref exists, click the ref (or `cu_type` with `mode: "action"`, `actionName: "AXPress"`) instead of a coordinate. Coordinates are for canvas areas with no AX node.

8. **A Dispatched Event Is Not a Successful Action**
   - `ok: true` only means the engine dispatched the event. If `observation.changed` is `false` or the expected state is absent, the app did not react: stop and re-observe. Do not replay the same click, type or key "once more" — a second identical dispatch is how a background click becomes a counter or a duplicate.
   - Do not scan the application bundle, guess internal files, or try random shortcuts after one failure. Identify the visible control, its enabled state and the current window, then act on that.
   - Do not guess app shortcuts (`⌘L`, `⌘K`, …). Use a visible menu item, an AXPress control, or a documented toolbar action; if you cannot find one, say so.

9. **Wait on What the Screen Shows**
   - Build `expect` / wait conditions from text or controls you actually observed, not from a hardcoded phrase. If the page already says "立即试用", waiting for "已安装" for 60 seconds is waiting for a state that does not exist.
   - When a condition times out, re-read the tree before deciding: the app may have taken a different path, which is information, not a reason to replay.

10. **Report Only What Was Verified**
    - `restoredTarget: false` means the target window was not restored; `cleanupState: "unknown"` means cleanup is unknown. Never describe either as "restored" or "cleaned up".
    - A screenshot path, a successful click and a model's summary are not proof of the business result. Quote the verified field (`verified`, `expect` match, before/after text) or state that it is unverified.
    - A snapshot from another chat is never your baseline: the first `cu_snapshot` in each chat returns `mode: "full"`. If you receive a delta you did not build on, re-observe with `full: true`.
