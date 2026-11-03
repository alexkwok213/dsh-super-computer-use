# Computer Use visual refresh implementation plan

**Goal:** Improve native session feedback without adding action latency or intercepting target-app input.

**Architecture:** Keep the installed plugin's `cu halo`/`cu capsule` interface. Implement a blue/cyan/violet Core Animation border in the engine, put the halo Stop control in its own small panel, and query only the target CGWindowID while following geometry. The existing signed running engine remains untouched until a built candidate has been reviewed.

**Tech stack:** Swift 5 mode, AppKit, QuartzCore, macOS 14+.

## Evidence and design

Reference recordings were sampled across their full lengths. Claude shows a compact top-right conversation window and warm screen-edge tint; Codex shows a target-window thumbnail. Samples do not establish either engine's speed or prove cursor animation details. The current halo draws a static 3pt tan stroke, duplicates activity in a chip, and polls every visible window four times per second. Returning nil from NSView.hitTest does not guarantee events pass through an NSWindow to another app.

Design call: narrow blue/cyan/violet gradient border, restrained breathing glow composed by Core Animation, no frame-by-frame application drawing; static fallback for Reduce Motion. Keep full-screen glow and cursor choreography for a later persistent overlay process so we do not accumulate more helper processes now.

## Implementation and verification

- [x] Add a native view regression that rejects hit testing throughout the decorative halo, including the previous top-left chip region. Run against the existing class and observe failure.
- [x] Replace HaloView drawing with gradient/mask/glow layers; move label and Stop to a compact separate control view. Set the large panel's ignoresMouseEvents to true; keep only the compact control panel interactive. Clip long labels with ellipsis.
- [x] Replace follow-loop full window enumeration with a query for the one window; retain exit when target goes off screen. Avoid implicit resize animation so feedback never lags target geometry.
- [x] Compile a candidate under build/, run quick regression suite, and inspect a timed standalone overlay. Check focus preservation, target-window disappearance, Reduce Motion behavior, and cleanup.
- [x] Record measured results and remaining deployment work. Do not describe a source build as an installed update.

## Subsequent work from plugin audit

Plugin source is a separate sibling repository, ~/Downloads/work/dsh-computer-use, linked by the desktop profile. Read-only audit found: startup implicitly resumes and docks; display geometry is hard-coded; optional observation failures erase successful actions; batch timeout checks do not bound the final step; an unbounded fetch blocks the execution queue. Fix with behavioral tests before redesigning the complete persistent overlay channel.

## Review focus

Click-through must be a window-level property, Stop must still latch pause, no claim that animation changes improve execution speed, no TCC identity changes during candidate verification, and no automatic resume of a user pause. Native candidate deployment and live plugin integration remain separate from this first source change.

## Verified result — 2026-11-03

- Candidate compiled successfully to `build/cu-visual-candidate` with Swift 5 language mode and macOS 14 deployment target.
- Installed 2026-11-03: staged a signed copy of the original bundle with the candidate Mach-O; designated requirement unchanged (`identifier "local.cu.app"` + same Apple Development leaf). Full previous bundle retained at `build/deploy-visual-20261103/previous-Computer Use.app`; new engine hard-linked to the service path; both agents kickstarted. `/v1/status` reports buildId `c43309404cde53c05cdf4f684d355ccbf902294816fe818d51a15ed5f74df638`, accessibility and screen recording true, paused false. The menu-bar helper and service share one inode (link count 2).
- Native view regression failed against the old chip-region hit test, then passed with the new implementation. Covers decoration input, resizing, reduced-motion enable/disable and accessible Stop callback.
- Live temporary-window regression passed: focus remains unchanged, border and control follow resize, transparent target dismisses both before the timeout. The fixture has prohibited activation and waits for WindowServer visibility before publishing its ID. Earlier failures exposed locked-desktop scaling and a fixture startup race; those runs were not counted as successful verification.
- Engine quick regression suite passed. Plugin's five existing non-desktop unit tests passed.
- Single-window CG query benchmark, 200 samples per path: full listing median 0.215ms/p95 2.735ms; target query median 0.097ms/p95 0.193ms. These are query wall times on this machine, not end-to-end action latency or comparative product benchmarks. Geometry polling now runs at 30Hz instead of 4Hz; no per-frame AppKit redraw loop was introduced.
- `tests/halo_preview.py` renders the actual native view classes to `build/halo-preview.png` offscreen. It is a static implementation preview, not a screenshot of the installed plugin.
- Approved sibling-plugin edit in `lib/index.mjs` isolates optional snapshot/preview exceptions and exposes failures without losing a completed action result. Five new mock regressions cover snapshot exception/failure response, preview exception, cancellation after dispatch and primary action failure. All pass; independent review found no blockers.
- Installed-engine smoke test 2026-11-03: ran the deployed `cu halo` against a real Finder "Downloads" window for 3 s. Emitted `halo:shown` then `halo:timeout`, exit 0; frontmost app was DeepSeek Harness both before and after (no focus steal). Full-screen screenshot during display saved as `build/evidence/halo-installed-finder.png` showing the gradient border and control chip.
- Host reload 2026-11-03: restarted the DeepSeek Harness desktop app (new main process, 10:01). The restarted host's bundled Node v24 imports `lib/index.mjs`, registering all 12 `cu_*` tools with the observation-isolation fix present. Re-ran plugin non-desktop unit tests (5 pass), `tests/plugin_observation.mjs` (5 pass) and `tests/halo_view.py` (pass). A post-restart `cu halo` smoke against Finder "Downloads" again showed and timed out cleanly with no focus change.
- Full end-to-end performance measurement, startup docking/resume defaults, actual display geometry, and batch timeout enforcement remain outstanding.

## Round 2 — agent cursor overlay + startup geometry (2026-11-03)

- New `cu cursor-overlay` command: one persistent, click-through, `.statusBar` full-screen panel driven by JSON lines on stdin (a dedicated reader thread feeds the main run loop). Layers: `CAGradientLayer` radial edge vignette (transparent centre, blue/cyan/violet rim), white arrow with blue glow, expanding click ripple. Exits on stdin EOF so it never orphans.
- Plugin wiring: `CuSessionManager.startCursorOverlay/showAgentCursor/showClickRipple/setAgentAura/stopCursorOverlay`; started at session start, stopped at session stop; `cu_click` glides the cursor to the target (from explicit x/y or the cached ref centre) and fires a ripple, fire-and-forget so it never delays the action.
- Verified coordinate fix: an initial `layer.position` double-flip put the arrow at screen bottom-left. Switched to drawing absolute paths in view coordinates. Deterministic capture now shows the arrow at exactly the requested (500,300) and the ripple ring at (900,500); evidence in `build/evidence/agent-cursor.png`, `click-ripple.png`, `aura-over-desktop.png`.
- Startup geometry: replaced hard-coded `1728×640×33×997` dock layout with values derived from the widest full-display window and the DSH window's own top edge, so other Macs' resolutions are respected.
- Deployed: signed replacement installed at `/Applications/Computer Use.app`, service hardlink refreshed, both agents kickstarted (one extra `kickstart` was needed after a transient launchd spawn race). `/v1/status` buildId `273c1040ad0a3088…`, accessibility & screen recording true, paused false. Prior bundle retained at `build/deploy-cursor2-20261103/previous`.
- Regressions: `tests/halo_view.py` pass; `tests/plugin_observation.mjs` 6 pass (incl. new cursor-command test); plugin core units 5 pass; `tests/halo_live.py` pass.
- Outstanding: host reload to load the plugin cursor wiring into the running GUI, and the items still open from Round 1.
- Final live verification 2026-11-03: host restarted (pid cycled, 10:16) and re-imports the cursor-wired plugin (12 tools, `startCursorOverlay`, `showClickRipple` present, hard-coded `1728` gone). Engine buildId `273c1040ad0a3088…`, accessibility & screen recording true, paused false. A live session against the running desktop shows the aurora rim composited over real windows with the agent cursor visible; saved as `build/evidence/full-session-aura-cursor.png`. Still open: end-to-end action-latency benchmark vs the round-2 baseline, startup docking/resume idempotency, and batch absolute timeout enforcement.

## Round 3 — snapshot settle-loop performance (2026-11-03)

- Baseline measured through `/v1/exec`: HTTP transport is only ~1.8 ms; `windows`/`frontmost` ~30 ms (dominated by the AX-only window supplement); snapshot full **892 ms**, windowed 265 ms. The snapshot's settle loop was the dominant cost: it re-walks the whole AX tree, sleeps 120 ms, and repeats until two walks agree **or the 600 ms deadline expires**. A tree that never agrees (Finder's live clock/spinner) burned the full deadline — 892 ms on a 498-node window.
- Fix: cap the extra settle re-walks (`--max-settle-walks`, engine default 2, hard bound). The plugin's `buildCommandArgv('snapshot')` now passes `--max-settle-walks 0` for the hot path, because change-driven observe re-reads on real change. Node counts are identical at 0 vs 2 extra walks on Finder (498 = 498), so single-walk is correctness-preserving here.
- Deployed final: engine buildId `e437d3febbdce922…` (signed, permissions intact), previous bundle kept at `build/deploy-final-20261103/previous`. Reusable `build/deploy_engine.py` verifies the designated requirement, retries the launchd spawn, and confirms the running buildId.
- Final `/v1/exec` medians on the deployed build: snapshot full **206 ms** (was 892, ~4.3×; 498 nodes both), snapshot windowed **166 ms** (was 265, ~1.6×), legacy `--settle 600` default now capped at 362 ms (was 892). `windows` unchanged at 32 ms.
- Tried and **reverted** a `windows --fast` path that skipped the AX sheet scan: A/B over HTTP with 30 samples showed it consistently *slower* (57.7 ms vs 31.7 ms full), not faster — skipping the AX trigger does not help and perturbs later calls. Kept `windows` as-is per YAGNI.
- Regressions all pass: `halo_view`, `plugin_observation` 7 (new settle-argv test), plugin core 5, `halo_live`. Running host already carries the `--max-settle-walks 0` plugin default (loaded two restarts ago); this round's only plugin edit reverted the `--fast` call, so no further host restart was required for correctness.
- Still open: startup docking/resume idempotency, batch absolute timeout, and cross-product (Claude/Codex) comparison numbers.

## Round 4 — lifecycle correctness + batch deadline (2026-11-03)

- Batch timeout was only checked before each step, so a trailing `wait` (up to 10 s) or a slow `exec` could overrun the budget unboundedly. Fixed in `executeBatch`: waits clamp to the remaining budget; a step that straddles the deadline stops the batch and is reported with `outcomeUnknown: true` (dispatched, effect may or may not have landed) instead of being silently retried or misreported. Tests: trailing 5 s wait under a 200 ms budget returns in ~201 ms; an over-budget dispatched click reports `error: batch_timeout, outcomeUnknown: true`.
- Startup was not idempotent and ignored the documented `dockDsh` default. Doc said `default false` but the code used `opts.dockDsh !== false` (default true), and every `startVisualSession` re-ran `resume + windows + stage` and could move windows. Fixed: docking is now opt-in (`opts.dockDsh === true`), `cu_session` maps `dockDsh: args.dockDsh === true`, and a same-target restart short-circuits to "continued" (refreshes indicators only). Live check against the deployed engine: default start does `resume,windows,stage` and **no `movewindow`**; an identical second start issues **zero** engine calls.
- New `tests/plugin_lifecycle.mjs` (4 tests: clamp-wait, outcome-unknown, dock-default-false, idempotent-restart) all pass; plugin observation 7, core 5, `halo_view`, `halo_live` all pass.
- Current measured hot paths (deployed engine `e437d3fe…`, `/v1/exec`, medians): windows 32 ms, frontmost 29 ms, snapshot hot (Finder, walks=0) 243 ms, snapshot windowed 204 ms, windowed JPEG shot 241 ms. Shot still delegates to `screencapture` CLI in service mode because SCK completions do not fire in a launchd agent — an in-process SCK path is the next perf lever but needs a design that keeps a real UI process for TCC.
- Still open: cross-product comparison against live Claude/Codex, and an in-process or warm capture path for `shot`.

## Round 5 — shot cost analysis + competitor tooling reality (2026-11-03)

- `shot` windowed JPEG is 241 ms warm. Breakdown measured: raw `/usr/sbin/screencapture -x -t jpg -o -l <win>` is **146–177 ms**; the remaining ~70 ms is `refine()` decode→downscale→JPEG re-encode (window is 1840 px, requested max-dim 1280). Full-screen `screencapture -D1` is ~155 ms. In-process SCK (no `CU_SHOT_CLI`) measured **~260 ms capture** after ~40 ms launch — i.e. *not* faster than the CLI route here, because `SCShareableContent` enumeration dominates. So 241 ms is near the floor for a per-call capture; a real speedup needs a persistent warm capture process (the "resident overlay/capture" idea), which is a larger architectural change, not a quick patch.
- Competitor live benchmark blocked honestly: `kimi-cu` 0.6.8 is installed (`/Applications/KimiCU.app/.../kimi-cu`, MCP stdio works, 20 tools) but its service `ai.kimi.cu.service` is **not running** — every MCP `tools/call` returns `service unavailable` at ~610 ms (retry timeout). Same-harness direct-CLI `windows` measured: kimi 57.5 ms vs our 86 ms *as one-shot CLI* (equal launch overhead), but our real agent path is the warm service at **~30 ms** with no per-call launch. Producing a fair live head-to-head needs launching Kimi.app/Claude.app, which I won't do unprompted. The validated evidence remains the measured before/after table (`build/evidence/perf-table.png`).
- No engine/plugin code changed this round; deployed engine stays `e437d3fe…` (all regressions green from Round 4 still hold).

## Round 6 — resident ScreenCaptureKit capture daemon (2026-11-03)

- Benchmarked the premise before building: a warm `SCShareableContent` reused across captures gives steady-state window captures of **53 ms median / 58 ms p90** (n=20), while a cold enumeration costs 29–34 ms and the first capture ~120 ms. That justified a resident daemon rather than more per-shot tuning.
- New engine command `cu capture-daemon`: one long-lived process holding the SCK content cache, JSON-lines on stdin/stdout (`shot` / `refresh` / `quit`), replying with base64 + mimeType + width/height/origin/size/scale so it is shape-compatible with the engine's `shot`. Written as a top-level class + free functions because an earlier all-in-one nested-closure version reliably crashed the Swift 6.3 type-checker (signal 6); that crash, not a runtime bug, was the build failure.
- Plugin wiring: `CuSessionManager.startCaptureDaemon / _captureRequest / captureShotViaDaemon / stopCaptureDaemon`, serialized through a promise queue so concurrent previews cannot swap replies; `capturePreviewObject` prefers the daemon and falls back to the normal `shot` exec path on any failure. Daemon is stopped in `stopVisualSession`.
- Verified: daemon spawned from the plugin's own Node process captures successfully (so the plugin's TCC/SCK context is sufficient — no menu-bar delegation needed). Spawned daemon measured **102–105 ms median, p90 ~108 ms**; end-to-end `cu_screenshot` through `registerCuTools` measured **100 ms**; concurrent 4-shot burst returned consistent sizes; daemon exits cleanly on stop with no stray processes.
- Deployed engine buildId `1234e54eece9bd38…` (signed, accessibility + screen recording true, paused false); previous bundle at `build/deploy-capture-20261103/previous`. Host restarted (pid 51596, 11:05) so the plugin loads the daemon wiring.
- Net so far: snapshot 892→206 ms (4.3×), window JPEG 241→105 ms (2.3×), `cu_screenshot` end-to-end 100 ms.
- Regressions: capture-daemon 3, lifecycle 4, observation 7, plugin core 5, halo_view — all pass.
- Still open: a fair live head-to-head against Claude/Codex (their services are not running and launching their UI is not something to do unprompted); broader end-to-end scenario timing.

## Round 7 — parallel post-action reads + daemon cache correctness (2026-11-03)

- Post-action observation and preview were awaited serially although both are independent read-only reads. `runPostAction` now runs them via `Promise.all`, each keeping its own error isolation. Measured on a live Chrome window: serial 261 ms → parallel **170 ms (35% faster, ~91 ms saved per action)**. New regression asserts the preview starts while the snapshot is still in flight.
- Daemon cache correctness: a window opened after the daemon started is absent from the cached `SCShareableContent`. Added refresh-on-miss (refresh once and retry when the requested window is not in the cache). Verified with a decisively new Finder window (id 17918 created after warm-up, not in the daemon's initial 6-window set): captured successfully through the **same** daemon process.
- Same-window A/B on the deployed build (old `screencapture` exec path vs new warm daemon, medians): Finder 920×796 259→114 ms (2.3×); Pearcleaner 900×702 294→114 ms (2.6×); MLX-Serve 1291×994 288→144 ms (2.0×); DeepSeek Harness 1728×1001 296→183 ms (1.6×). Shot cost scales with window pixel area; the gain is largest on ordinary app windows and still meaningful on full-screen ones.
- Deployed engine buildId `1230fc9b9226a02c…` (signed; accessibility + screen recording true; paused false); previous bundle at `build/deploy-daemon2-20261103/previous`. Evidence table: `build/evidence/perf-table-v3.png`.
- Regressions: capture-daemon 3, observation 8 (incl. new concurrency test), lifecycle 4, plugin core 5, halo_view — all pass. Host restarted to load the parallel post-action change.
- Remaining: fair live head-to-head with Claude/Codex; the daemon currently captures at native scale then downscales in `refine`, which is the next incremental cost on large windows.

## Round 8 — capture directly at target size (2026-11-03)

- The daemon was still capturing at native 2× and then downscaling in `refine` (decode → scale → JPEG encode). Threaded `maxDimension` into the daemon's `shoot` so `SCStreamConfiguration` requests the target pixel width up front and the window server resamples in its own pipeline; `refine` then only does PNG→JPEG with no scaling.
- Result (deployed, same windows, medians): Finder ~1068×872 143→93 ms; WorkBuddy 1232×907 199→108 ms; Chrome 1728×999 176→76 ms; DeepSeek 1728×1001 183→75 ms. Against the original `screencapture` path this is **296→75 ms on full-screen windows (~3.9×)**. `cu_screenshot` end-to-end now measures **76 ms median**. Output dimensions verified exact at maxDim 1280/960/640 with proportional height, and the 1280 px capture was inspected: text remains crisp, no resampling artifacts.
- Deployed engine buildId `76ce076a3f36fcdd…` (signed; accessibility + screen recording true; paused false); previous bundle at `build/deploy-daemon3-20261103/previous`. Evidence: `build/evidence/perf-table-final.png`.
- Regressions: capture-daemon 3, observation 8, lifecycle 4, halo_view — all pass. No plugin change this round, so no host restart was required.
- Cumulative measured gains: snapshot 892→206 ms (4.3×); window capture 296→75 ms (3.9×); post-action observe+preview 261→170 ms (35%); `cu_screenshot` end-to-end 76 ms.
- Remaining: fair live head-to-head with Claude/Codex. Everything else in the plan's scope is implemented and verified.


## Round 9 — visual polish: glass HUD + cursor action label (2026-11-03)

- Capsule rebuilt as a real glass HUD: `NSVisualEffectView` with `.hudWindow` material and forced `.darkAqua` appearance (default material washed out white over bright documents and killed text contrast), blue→cyan→violet gradient border via masked `CAGradientLayer`, pulsing cyan status dot (two layers: glow + core, render-server animation), elapsed timer on its own 1 Hz tick, and a 12/10.5 pt title/subtitle stack. Text lives in a transparent overlay subview because AppKit draws subviews above the parent's own `draw()`, so the original in-`draw` text was hidden behind the glass.
- Agent cursor gained a trailing action chip (`{"cmd":"label","text":"点击 导入"}`): dark rounded bubble with a blue outline, placed below-right of the cursor tip so it never covers the pointer. The plugin emits it on every click: `showAgentCursor` → `showActionLabel` → `showClickRipple`.
- Verified visually on the live desktop: capsule in the top-right reads clearly with gradient rim, glowing dot, title and timer (`build/evidence/capsule-glass-hud.png`); cursor + chip legible over text (`build/evidence/cursor-action-label.png`); all effects together in one frame (`build/evidence/full-experience-v2.png`).
- Deployed engine buildId `23dc49afed83a66c…` (signed; accessibility + screen recording true; paused false); previous bundle at `build/deploy-visual4-20261103/previous`. Host restarted (pid 55887, 11:27) so the plugin loads the label wiring.
- Regressions: observation 9 (new cursor-label test), lifecycle 4, capture-daemon 3, halo_view, halo_live — all pass.
- Remaining: fair live head-to-head with Claude/Codex; the capsule's subtitle only shows when an activity string is present (it updates from ~/.cu/activity.json every 300 ms).

## Round 10 — safety-path and lifecycle verification (2026-11-03)

- Helper lifecycle: started a real session (`startVisualSession` → capsule + halo + cursor overlay + capture daemon on demand), then stopped it. Helper processes went 0 → active → **0**, `indicators.size` 0, `captureProcess`/`cursorProcess` null after stop. No orphaned helpers.
- Stop button is safety-critical (it latches the user pause). Verified end-to-end with a real synthetic click at the capsule's stop rect: the process emitted `{"capsule":"stopped","paused":true}` and wrote `~/.cu/pause`. Then verified the gate: `assertCanAct` throws `PAUSED_BY_USER` while paused, and `resume` + `clearPauseLatch` restores action. Re-ran the same click test against the deployed binary `3adf57bf…` — same result.
- Capsule accessibility: exposes a single `AXButton` described "Stop computer use" (`accessibilityFrame` = the stop rect, `accessibilityPerformPress` invokes the same handler). Verified by walking the AX tree of a live capsule; the rest of the pill stays non-focusable decoration.
- Deployed engine buildId `3adf57bf3f4aae0a…` (signed; accessibility + screen recording true; paused false); previous bundle at `build/deploy-visual5-20261103/previous`. No plugin change, so no host restart needed.
- Regressions: observation 9, lifecycle 4, capture-daemon 3, halo_view, halo_live — all pass.
- Note: the pause file was removed after testing so the machine was left unblocked.

## Round 11 — snapshot payload trimming + honest truncation (2026-11-03)

- `actionNames` is one AX IPC per node and `actions` is not consumed by the plugin's delta logic (`renderNodeLine` never includes it). Added `--no-actions` and made the automatic post-action observe use it. Measured on the deployed engine: Finder 800 nodes 797→525 ms; DeepSeek 704 nodes 170→148 ms; Chrome 65 nodes 85→75 ms. `cu_snapshot` keeps action lists by default, so model-facing output is unchanged.
- Found a real correctness gap: the walk stops at `SNAP_LIMIT = 800` but never said so, so a caller could mistake a partial tree for the whole app. Snapshots now carry `truncated` and `limit`, and `recordSnapshot` forwards them into the model-visible result. Verified: Finder at 800 reports `truncated: true`, Chrome at 65 reports `false`.
- Deployed engine buildId `aebc9d320d80ea65…` (signed; accessibility + screen recording true; paused false); previous bundle at `build/deploy-trunc-20261103/previous`. Host restarted (pid 57485, 11:38).
- Regressions: observation 11, lifecycle 4, capture-daemon 3, halo_view — all pass.
- Note on variance: Finder sits exactly at the 800 cap and its tree churns, so its timings swing between ~525 and ~690 ms run to run; the with/without-actions ratio is the stable signal.

## Round 12 — tunable snapshot budget + competitor-benchmark reality check (2026-11-03)

- Once truncation was reported, callers needed a way to ask for more. Added `--max-nodes` (50–3000, default 800) and `--depth` (4–48) to the engine and a `maxNodes` parameter to `cu_snapshot` (clamped). Verified end-to-end: Finder default returns 800 nodes with `truncated: true`; `maxNodes: 1500` returns the complete 957-node tree with `truncated: false` at ~1.9 s. That is the honest trade: completeness costs latency, and the caller chooses.
- Competitor benchmark investigated again and still blocked, recorded rather than faked: `/Applications/Claude CU Bridge.app` no longer exists on this machine; `kimi-cu 0.6.8` is installed and its CLI `windows` works (~57–85 ms as a one-shot process), but its MCP `tools/call` always returns `service unavailable` because `ai.kimi.cu.service` is not registered with launchd — starting `kimi-cu service` reports a runtime socket already in use and does not make the Mach service reachable. Installing or launching their privileged services / model UIs is not something to do unprompted, so no head-to-head numbers are claimed.
- Deployed engine buildId `a246368617a7e274…` (signed; accessibility + screen recording true; paused false); previous bundle at `build/deploy-limit-20261103/previous`. Host restarted (pid 58062, 11:42).
- Regressions: observation 12, lifecycle 4, capture-daemon 3, halo_view — all pass.

## Round 13 — end-to-end scenario measurement and wrap-up (2026-11-03)

- Measured the full action cycle through the real plugin tool stack (`registerCuTools` → `cu_snapshot` → `cu_click` with `preview: true` → `stopVisualSession`) against a live demo window: session start **107 ms**, click + observe + preview **472 ms**, stop **1 ms**. The historical baseline in `性能与体验改造方案.md` recorded click+observe around 1.4 s, so the end-to-end cycle is roughly **3×** faster, consistent with the component measurements.
- Click cost breakdown for the record: background coordinate click ~111 ms, background AXPress-with-ref ~187 ms (ref resolution dominates: path walk plus the level-0 sorted listing), preflight ~23 ms, `windowRoot` ~44 ms. Further click gains would need an in-process command path plus an index cache; not attempted because it would restructure the service's fork-per-command model and the current cycle is already ~3× better than baseline.
- Summary evidence: `build/evidence/optimization-summary.png`.
- Final state: engine `a246368617a7e274…` installed and running; all regressions green (observation 12, lifecycle 4, capture-daemon 3, core 5, halo_view, halo_live).
- Deliberately not claimed: "fastest in market". A fair head-to-head needs Claude's or Kimi's own privileged service running, which is not available here and not something to install or launch unprompted.

## Round — aura feedback correction (2026-11-03, user report)

The user reported a large tint covering much of the screen that never switched off, and
asked for an edge-hugging breathing light that only appears while the agent is operating.
Root causes and fixes:

1. **Persistent session overlay.** `cu_click` auto-starts a visual session
   (`config.autoSession`) when a `windowId` is passed, and nothing ends it. A
   `cu cursor-overlay` process (started 12:23 by the plugin host, parent DSH) survived
   for more than an hour, keeping the aura at full opacity. The orphan was killed; the
   overlay now exits after 2 idle hours instead of running forever.
2. **Wrong aura geometry.** The aura was one radial `CAGradientLayer` centered on the
   screen with `endPoint (1,1)` → ~1000 pt radius, so the “edge” tint covered a large
   part of the display. Replaced with four 72 pt edge bands (linear gradients,
   transparent on the inner side) inside a container whose opacity carries the 55–100 %
   breathing animation (1.8 s, autoreverse).
3. **Wrong trigger.** `aura true` now only arms the feedback; `cursor` / `click` /
   `label` commands light the rim for 2 s and fade over 0.5 s. Continuous actions read
   as a breathing rim; idle is fully transparent (no ambient glow).
4. **Regression pin.** New `engine/tests/aura_view.py` compiles the real
   `CursorLayerView` offscreen and asserts: armed-idle transparent; a pulse draws a
   ≤100 pt rim on all four edges with a clear centre; fade clears it; the activity
   timestamp updates. Wired into `run_all.sh` (full section).

Verified live after reinstall (service buildId `09c04b3215d8…`): pulse vs idle mean RGB
difference 0.046 (~12/255) in the outer 60 pt band and 0.0003 in the centre; after the
2 s fade the edge difference returns to 0.0001; no overlay process or window left behind.
