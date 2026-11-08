---
name: dsh-super-computer-use
description: macOS Computer Use / 桌面操控与自动化（剪映、微信、Finder、备忘录、Freeform 等后台操作、绘图与内嵌观看预览），含 cu_route/cu_discover 能力路由与过程真实性硬约束：绘图必须在目标 app 内落笔，禁止离屏渲染后上传/粘贴。Control macOS desktop applications using background AX actions, a deterministic strategy router, real in-app strokes (never uploaded images), floating status capsule/halo, and inline target window previews.
---

# macOS Computer Use (`cu_*` Tools)

Use `cu_*` tools to inspect and operate macOS desktop applications. For ordinary web browsing inside Chromium, use `browser-skill` (`bsk_*`) instead.

## Core Principles

**-2. Process authenticity — computer use means OPERATING the target app.**
A task is NOT complete because the desired pixels appear inside the app. It is
complete because **the app was driven to produce them**. Rendering an image
off-screen and uploading / pasting / dropping it into the canvas is process
fraud: no computer use happened, even when the result is pixel-perfect. This is
a hard constraint from the user (2026-11-08), not a style preference.

For ANY drawing task, all of the following hold:

- The finished artwork **must consist of stroke objects created inside the target
  app** by `cu_paint` (native) or `cu_cdp_paint` (web canvas). There is no other
  legitimate delivery channel.
- `cu_paint_plan`, its preview PNG, and any off-screen render are for
  **composition and colour checking ONLY**. Never a deliverable.
- A screenshot is **verification, never a delivery proof**. Keep process
  evidence: stroke/element counts and the painting tool calls.
- A physical limit inside the app (e.g. Canva's 2,000-item cap) must be solved
  **inside the app** — merge strokes into connected regions with
  `planLayerToRegionStrokes()` — not by switching to an upload.
- "The brush leaves stripes / costs 16 colour changes" is a **craft problem**
  (fix with brush width ≈ 2× cell and a `+sy/2` second pass), never a licence
  to bypass the app.

`cu_route` returns `prohibited` (forbidden delivery paths) and `acceptance`
(evidence required). Read both before the first click. First-principles audit:
`docs/process-authenticity-oracle.md`.

**-1. Route first, then discover, then verify one step, then batch.**
Computer use is not "click wherever". The thing that makes an app usable is knowing
what it CAN do, and knowing which route is worth taking. A whiteboard is not
"a canvas you drag on" — it has a brush with separate thickness, opacity and
colour controls buried in a popover.
For ANY non-trivial task, in this order:

1. `cu_route({intent, appName|url|pid|windowId})` — deterministic intent → route
   lookup. Read `recommended.why`, `recommended.avoid`, `prohibited`,
   `acceptance` and `preflight` **before the first click**. If `noRoute:true`,
   follow `fallback` (the generic method).
2. `cu_discover` — `urlMatch` for web pages (CDP DOM enumeration), or
   `appName`/`pid`/`windowId` for **native apps** (AX tree + native playbook).
   Native discovery needs no Chrome. Read `playbook.flows` / `pitfalls` /
   `routes` / `prohibited`.
3. **Minimum closed loop on ONE step**: act → `expect` or screenshot → confirm it
   actually took effect. Do not start a 16-step batch before this passes.
4. Only then `cu_batch` the remaining deterministic steps. A missing step 3 is
   how a wrong colour or a deactivated brush gets multiplied 16 times.

### Route quick-reference (the decision the router encodes)

| Intent | Only legitimate route | Prohibited |
|---|---|---|
| 在 Freeform / 原生白板画参考图 | `cu_paint_plan` → 逐层换色 + `cu_paint` 落笔（Medium 笔宽、`+sy/2` 补缝、每色重新 arm） | 离屏 PNG 粘贴 / 上传 / 拖入；剪贴板 `Cmd+V` |
| 在 Canva / 网页 canvas 画参考图 | `cu_paint_plan` → DOM 驱动画笔 + 连通区域蛇形合并 + `cu_cdp_paint` 落笔 | 上传图片对象；`cu_paint`（CGEvent 被渲染循环丢弃） |
| 明确要手绘笔触 | 同上，保留笔宽与笔触质感 | 用外部图片冒充手绘 |
| 任何绘图任务的验收 | 目标 app 内存在笔画对象 + 过程证据（笔画数 / 工具调用记录） | 只交截图、只交一个图片对象 |

Mutating tools now return a short `guidance` field (channel/cost + the matched
playbook's route and first pitfall); `cu_status` / `cu_windows` return
`activeAppPlaybook`. Read them — they are the router pushing knowledge into your
context at execution time, not a document you have to remember to open.

0. **Ask `cu_status` Once, Then Stop Repeating Yourself**
   - `cu_status` reports `vision.supported` (`true`/`false`/`null` with a `reason`) and `lastImage` (what the last capture actually delivered). `false` or `null` means a screenshot is a file path, not evidence: do not reason about pixels, use `cu_find`/`cu_expect`/`cu_snapshot` instead.
   - `cu_status.targets` lists every target in this chat (`targetId`, pid, windowId, appName). Pass `targetId` to keep observations, actions, previews and stops on one window; a chat may own several targets concurrently.
   - Omitting a target uses the chat's current target, not the only target. Never infer that another target's ref belongs here.


1. **Background First (Never Steal the User's Pointer or Focus by Default)**
   - `cu_click`, `cu_drag`, `cu_type`, `cu_key`, and `cu_scroll` default to `foreground: false` (background execution via `AXPress` or PID-targeted events).
   - A foreground action takes focus and real keyboard/mouse input. It runs only with BOTH `foreground: true` and `authorizeForeground: true`; the latter means the user explicitly agreed to the interruption. Otherwise the tool refuses before sending input.
   - A background operation that needs foreground capability reports `capability: "background_unavailable"` / `requiresForeground`; do not retry it or silently promote it.
   - `cu_launch` defaults to `background:true`: it can create an app window without taking focus. Use `background:false` plus `authorizeForeground:true` only when the user explicitly wants the app brought forward.

2. **Session Visibility & Target Preview**
   - Before operating on a target window, call `cu_session` with `action: "start"`, passing `windowId`, `pid`, `appName`, and `preview: true`.
   - This starts a non-activating, draggable native picture preview and a per-target halo, and returns an inline image. `nativePreview:false` disables the native picture preview. In an embedded client the Control Deck supplies status controls; the separate native capsule is opt-in. It does **not** activate, move, dock or stage anything. `dockDsh`, `splitScreen` and `bringOnStage` are explicit opt-ins; use `dockDsh:false` (or omit) while the user is working elsewhere.
   - Starting a second target in the same chat keeps the first target and its halo/preview alive. Use `targetId` from the start result for all subsequent calls.
   - In embedded mode the Control Deck follows active targets. Its live thumbnails open only when the user expands/chooses Watch; do not open a second continuous capture just to duplicate an already visible native preview.
   - To identify a native preview, read `cu_status.targets[].nativePreview`: `windowId` is the preview panel identity, `frame` is its current rectangle in `screen-points-top-left` logical coordinates, and `visible`/`status` distinguish a live panel from a closed or unavailable one. The target's own `windowId` remains the controlled application window. Do not confuse these identities.
   - `cu_windows` normally lists ordinary application windows; a floating preview may be absent, while a `cu` halo can appear. Never treat a halo window as the preview or start a control target on a feedback helper. Never guess drag coordinates from a resized screenshot when exact preview geometry is available. If metadata is absent, confirm the actual panel visually before input.
   - Dragging/clicking native preview controls uses real mouse input. Do it only when the user requested that interaction and foreground authorization is available; it is not a background AX test. Re-read the current panel geometry before input, then verify movement or disappearance from fresh status and the real UI.
   - Hover reveals Stop and Close (×). Close removes that target's preview/capture while background control can continue; Stop closes that target's input gate and resources. A closed preview reports `status:"closed"` and `visible:false`; do not click its last known coordinates. Reopen it with an explicit `cu_session start` for the same target when requested.
   - While a session is active the menu bar may show the recording indicator. Call `cu_session` with `action: "stop"` and `targetId` to stop one target, or omit `targetId` to stop all. A per-target stop does not latch the session-wide pause; stop-all does.

3. **AX Snapshot & Delta Observation First, Screenshot/OCR When Needed**
   - Start with `cu_windows` to find the target `pid` and `windowId`.
   - Call `cu_snapshot` (`pid`, `windowId`) to obtain element refs (`e1`, `e2`, ...).
   - Mutating tools (`cu_click`, `cu_type`, `cu_key`) support `observe: true` (enabled by default when `pid` is provided), which returns the AX delta (`+` added, `-` removed, `~` changed) in the same call.
   - Never assume `ok: true` means the business action succeeded. A raw PID event without an explicit `expect` is returned as `ok:false, error:"effect_not_verified"`; do not replay it. Prefer AXPress / setvalue plus a concrete `expect`.
   - For canvas-heavy apps (such as video timelines or custom panels without AX nodes), use `cu_find` (`mode: "auto"` or `"ocr"`) or `cu_screenshot`.
   - A window capture may omit a separate file chooser or modal. If the target reports a modal but it is missing from the window image, use `cu_windows` and, when necessary, `cu_screenshot` with `screen:true` to locate it; screen capture can include other visible apps.

4. **Respect User Pause / Stop**
   - If any tool returns `PAUSED_BY_USER`, stop immediately and ask the user before calling `cu_session(action="resume")`.

5. **Multi-Step Execution with `cu_batch` (Codex / Claude Fast-Action Loop)**
   - For compound tasks (e.g. click search box -> type keyword -> press return), prefer `cu_batch` instead of round-tripping to the model for each individual keystroke or click.
   - `cu_batch` runs all steps locally, updates the floating status capsule live, and delivers the single final observation delta + preview.
   - Batch input defaults to background. If foreground input is authorized and needed, pass both `foreground:true` and `authorizeForeground:true` on the batch; its input steps inherit foreground unless a step explicitly overrides it. Authorization alone does not switch modes.
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
   - `cu_snapshot` node frames (`@x,y width×height`) are already global screen logical points with a top-left origin, not window-relative. Do not add the window origin to them.
   - When a reliable control ref exists, click the ref (or `cu_type` with `mode: "action"`, `actionName: "AXPress"`) instead of a coordinate. Coordinates are for canvas areas with no AX node.
   - For a canvas drag, use `cu_drag` with `from` and `to` in logical screen points, both inside the same target window. A screenshot's `origin` and `scale` map image pixels to points: `screen = origin + pixel / scale`; use the image actually delivered, and take a fresh snapshot before aiming if the window may have moved. Do not mistake the floating preview for the target window.
   - A background drag may be ignored by an app; an unverified dispatch is not success and must not be replayed blindly. Re-observe the timeline or canvas. If background input is unsuitable, foreground drag requires explicit user authorization and takes the real mouse/focus. Verify the intended clip or position after the gesture.

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
    - A snapshot from target A is never target B's baseline, even when both windows belong to the same pid. Use the `targetId` and `snapshotId` returned with the observation.

11. **Multiple Targets in One Chat**
    - Treat `targetId` as the handle for one window incarnation. Window close/reopen or app restart changes its generation; old refs/snapshotIds must be re-observed.
    - Different targets can be observed and previewed concurrently. Same-target operations stay ordered. Never send global keyboard/mouse/clipboard input concurrently to fake parallel control of several apps.
    - Stopping A leaves B alive. After stop-all, no queued input may run and no late result may reopen a target.

12. **Drawing a Reference Image (Freeform / Canva / Web Canvas)**
    - **Start with `cu_route`** (see -1). It returns ONE legitimate route (`freehandNative` / `freehandCdp`), plus `prohibited` and `acceptance`. There is no fast path that skips painting — see Principle -2.
    - Use `cu_paint_plan` first. It posterizes the reference, removes the border-connected background, assigns a palette, and writes a plan of horizontal brush runs. Give it the drawing rect. Its **preview PNG is for composition/colour checking only, never a deliverable**.
    - **The only two delivery channels — choose by target:**
      - **Native app (Freeform, Photoshop, Preview): `cu_paint`** with the real pointer. Freeform requires `osascript -e 'tell application "Freeform" to activate'` before any stroke; its colour panel is a separate axOnly window (`windowId 0`), needs a foreground real click, and **after every colour change the tool jumps back to "选择" — re-arm Drawing tool before each layer**. See playbook `pitfalls`.
      - **Web canvas (Canva / Figma whiteboard / tldraw): `cu_cdp_paint`, NOT `cu_paint`.** A browser canvas filters CGEvent/pid pointer events; `cu_paint` reports ok but paints nothing (verified). `cu_cdp_paint` injects `Input.dispatchMouseEvent` over CDP into the page.
    - **Craft, not shortcuts — how to make real strokes good:**
      - Brush width ≈ **2× the plan cell** so rows overlap: `grid 180` → cell 4px → Medium (≈4px). Extra-fine leaves white seams; Extra-heavy covers adjacent rows and smudges facial details.
      - Run a **`+sy/2` second pass** per layer to close horizontal seams; skip near-white layers (invisible on white).
      - **Verify ONE stroke's closed loop first**: set colour → re-arm brush → paint → screenshot → confirm both colour and stroke landed. Only then batch the remaining layers. This is what prevents 16× wrong-colour errors.
      - Canva's **2,000-item cap** is an in-app constraint: use `planLayerToRegionStrokes()` to merge each layer into connected serpentine strokes (measured 3,321 runs → 350 elements). Never solve it by uploading.
      - A round-tipped brush leaves faint horizontal stripes; that is a craft problem to fix with width and the second pass, **not** a reason to switch to an off-screen render.
    - **CDP channel setup (macOS):** `cu_cdp_paint {launch:true, startUrl:"<url>"}` launches an owned Chrome with a dedicated profile and, by default, copies the daily Chrome's cookies/logins/localStorage into it (`syncLogin:true`) so it starts already signed in — never attach to the user's everyday browser for repeated work (Chrome 144+ re-prompts "Allow remote debugging?" on every attach). Reuse the pooled session; `action:"disconnect"` drops it.
    - **The brush UI is scriptable — drive the DOM, not pixel coordinates.** On Canva whiteboard the controls are real DOM nodes with aria-labels (verified 2026-11): the rail `画笔` button's background turns `rgba(57,70,96,.14)` when armed; `设置` opens two `<input type=range>` sliders — **[0]=thickness (default 36 px), [1]=opacity (default 50 %)**; `颜色` → `添加新颜色` reveals a hex text input (`#rrggbb`). Set them with the native value setter plus `input`/`change` events (React ignores a plain `value=` assignment). `lib/canva-brush.mjs` implements exactly this: `armBrush`, `setBrushStyle({thickness, opacity})`, `setBrushColor(hex)`, `clearCanvas`, `closePopovers`.
      - A typed hex is applied only after the palette chip/Enter commits — read back the `[role=img][aria-label="#rrggbb"]` swatch to verify.
      - There is no usable undo (`Cmd+Z` via CDP keys does not reach Canva); clear with select-all + delete twice. **Beware `clearCanvas` click targets near the zoom slider — keep the click inside the artboard, and re-assert zoom=100% before painting.**
      - Never `Page.reload` the editor: it drops to the template/landing page and loses the canvas.
    - Coordinates are CSS viewport px and only align at **100% zoom**; confirm zoom first. `cu_cdp_paint` stroke points are **CSS viewport pixels**; at Canva zoom Z, one design unit = Z CSS px, so a fixed rect only lines up when zoom is 100%. Reset zoom before painting; a zoom change between planning and painting shifts every stroke.
    - A `dispatched`/`ok` result is not a drawing. Screenshot and compare against the plan preview; if it is a blob, the brush is too thick or the zoom is wrong — do not replay the whole layer. **Finish by reporting process evidence (stroke/element count + the `cu_paint`/`cu_cdp_paint` calls), not just a screenshot.**
