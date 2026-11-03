---
name: super-computer-use
description: Control macOS desktop applications (Jianying/CapCut, WeChat, Finder, Notes, native clients) using the local CU engine with background AX actions, floating status capsule/halo, and inline target window previews. For web browser tasks, prefer browser-skill (bsk_*) instead.
---

# macOS Computer Use (`cu_*` Tools)

Use `cu_*` tools to inspect and operate macOS desktop applications. For ordinary web browsing inside Chromium, use `browser-skill` (`bsk_*`) instead.

## Core Principles

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
   - `cu_batch` runs all steps locally in ~50-200ms, updates the floating status capsule live, and delivers the single final observation delta + preview.

6. **Post-Action Waiting and Verification**
   - Every mutating tool returns `observation.changed` (`true`/`false`/`null`), `observation.waitedMs` and `observation.reads`. The adapter re-reads the tree while it is still identical to the pre-action baseline, inside a short budget (~300 ms), so a sheet or search result that paints late is not missed. `changed: true` means the tree moved—not that the business action succeeded.
   - Pass `expect` to declare what the app must show: `{ query: "导入完成", timeoutMs: 2000 }`, or `{ ref, enabled, value, contains }`. The result then carries `verified: true|false` plus `verification`. `verified: false` means the action was dispatched but the app never showed that state: re-observe (and read `warning`) instead of replaying the click, which `actionReplaySafe: false` marks.
   - `cu_expect` runs the same check on its own, which is the right tool when the condition comes from an action you did not issue (user typing, a background import, another app's window).
   - A deterministic input followed by `expect` is the shortest reliable compound action; use `cu_batch` when the steps have no branch between them.
