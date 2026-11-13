---
name: dsh-super-computer-use
description: macOS Computer Use / 桌面操控与自动化（剪映、Final Cut Pro、微信、Finder、备忘录、Freeform、Canva 等通用软件理解与操控），含四阶段认知协议（cu_route 意图路由 → cu_discover 五大分区建图 → 单步试探 → 分段观察与执行）与过程真实性硬约束：必须真实操控目标应用，禁止离屏渲染后上传/粘贴。Control macOS desktop and web canvas applications using spatial UI zoning, deterministic strategy routing, real in-app strokes (never uploaded images), floating status capsule/halo, and inline target window previews.
---

# Universal macOS Computer Use (`cu_*` Tools)

Use `cu_*` tools to understand, explore, and operate macOS desktop applications and creative web canvases. For ordinary web browsing inside Chromium, use `browser-skill` (`bsk_*`) instead.

## Universal 4-Stage Cognitive & Execution Loop (Think → Map → Probe → Observe and Act)

Never jump straight into clicking coordinates or writing ad-hoc external scripts. Whether you are operating **Canva**, **Freeform**, **剪映专业版 (Jianying)**, **Final Cut Pro**, or an **unseen new application**, you must follow this 4-stage state machine in order:

### Stage 1: Understand the Goal & Process authenticity (`cu_route`)
1. Call `cu_route({ intent, appName | url | pid | windowId })` **before your first click**.
2. Read `recommended`, `prohibited`, `acceptance`, `preflight`, and `explorationProtocol`.
3. **Process authenticity — computer use means OPERATING the target app (Hard Constraint)**:
   - A task is NOT complete because the desired pixels or files appear inside the app. It is complete because **the target app's own tools, brush, timeline, and inspector were driven to produce them**.
   - Rendering an image off-screen and uploading / pasting / dropping it into the canvas (or synthesizing a video externally to bypass timeline editing) is **process fraud**: no computer use happened, even when the result is pixel-perfect. This is a hard constraint from the user (2026-11-08), not a style preference.
   - For ANY drawing task, the finished artwork **must consist of stroke objects created inside the target app** by `cu_paint` (native) or `cu_cdp_paint` (web canvas). There is no other legitimate delivery channel.
   - `cu_paint_plan`, its inline preview, and any off-screen render are for **composition and colour checking ONLY**. Never a deliverable.
   - A screenshot is **verification, never a delivery proof**. Keep process evidence: stroke/element counts, timeline state diffs, and tool call records.

### Tool availability is a prerequisite

If this host (including Codex) does not expose the plugin's `cu_*` tools, report that the managed connection is unavailable. Do not silently substitute `bin/cu strokes`, a shell loop or an independent Host for `cu_paint`: raw native dispatch omits the plugin's color/region checks, image delivery and cursor event publication. A local binary, symlink or installed skill does not establish a live plugin connection. Never claim those checks ran unless the actual call result contains their verification evidence.

### Stage 2: Build a 5-Zone Spatial Mental Map (`cu_discover`)
Before operating an app, understand what functional regions and controls exist on screen:
1. Call `cu_status` / `cu_windows` to locate the target `pid` and `windowId` (and check `activeAppPlaybook` + `vision.supported`).
2. Call `cu_discover`:
   - **Web Canvas / App (Canva, Figma, etc.)**: `cu_discover({ urlMatch: "canva.com" })` (or `launch: true, startUrl: "..."` to launch the owned debug Chrome with synced login state).
   - **Native macOS App (Freeform, Final Cut Pro, Finder, Notes)**: `cu_discover({ pid, windowId, appName })`.
   - **Custom Canvas Native App (Blender, Games, 剪映时间线画布)**: `cu_discover({ pid, windowId, appName, includeOcr: true })` — only when `counts.axNodes < 5` AND `counts.controls < 5`, standard AX sees just the window frame, so `includeOcr: true` scans visible UI labels via Apple Vision OCR. 剪映专业版 11.x 的 AX 树是完整的（190+ 节点，automation ID 写在 `AXDescription`），**不需要** OCR；只有纯画布区域与时间线拖拽才需要前台鼠标。
3. Read `zones` and `onboarding` from `cu_discover` to understand the 5 universal functional regions of the interface:
   - `topToolbar`: Global mode switches, Import/Export, Undo, Zoom (`缩放选项`), Drawing Tools toggle.
   - `leftSidebar`: Tool rail (`画笔`, `工具`), Media Browser (`媒体/音频/文本/转场`, Final Cut Pro `Browser`).
   - `centerStage`: Main canvas, whiteboard, or video `Viewer` / preview player.
   - `rightInspector`: Context-sensitive property panels (`Inspector`, sliders, text/audio/speed parameters).
   - `bottomBarOrTimeline`: Multi-track timeline (`磁性时间线` / 剪映轨道), Freeform bottom drawing bar, or zoom bar.

### Stage 3: Hands-On 1-Step Probe (Reveal Secondary Panels & Verify Closed Loop)
Most complex software hides parameters inside **secondary popovers or context-sensitive inspectors**:
- In **Canva**, brush thickness (`粗细`) and opacity (`不透明度`) sliders only appear in the DOM after clicking `画笔` → `设置`; hex colour input only appears after `颜色` → `添加新颜色`.
- In **Freeform**, selecting a colour in the floating `Colors` panel automatically resets the active tool back to `选择` (`Select`), requiring you to re-arm `Drawing tool` before painting.
- In **剪映专业版 / Final Cut Pro**, `rightInspector` parameters only appear *after* you click/select a clip on the timeline or browser.

**Rule**: Always execute **ONE minimal closed-loop probe first**:
1. Click/select the primary tool or clip → observe the delta (`observation.changed`, `cu_snapshot`, or `cu_discover`) to confirm secondary controls opened.
2. Perform **1 test action** (e.g. draw one short test stroke, or make 1 timeline cut / parameter edit) → verify with `cu_expect` or `cu_screenshot` that the colour, thickness, coordinates, or timeline change actually took effect.
3. Never start a 16-step batch before this 1-step probe passes.

### Stage 4: Observed Execution (`cu_batch` / `cu_paint`)
For drawing, first study the reference: identify the subject, outline, major color areas, foreground/background order and details. Plan deliberate brush paths that follow those features. Do not default to reproducing a raster by scanning horizontal lines.

- **Native drawing (Freeform)**: choose a brush and color, close the color panel and re-arm the drawing tool. Use `cu_paint` with a raw `strokesFile`, `expectedHex`, `paintRegion` polygon and observed `brushWidth`; it sends one stroke, captures before/after and checks for pixels of the expected color near that stroke. Inspect the canvas and reference after each stroke and continue using `nextOffset`, `reviewToken` and a concrete `review` only when appropriate. Each review must compare color, width and placement with the reference. If `paint_canvas_changed` returns a new frame/token, inspect it before retrying; do not replay the old token. If the check fails or capture is unavailable, stop and inspect the cause. Pixel changes do not establish semantic accuracy or final image quality. `artworkComplete:false` is literal: report the work as partial until the entire reference is compared. The tool measures the actual mark width and checks changed pixels against the intended region; this still does not establish that you chose the correct semantic region. Stop on capture failure, secure input or an interrupted stroke and state what remains unfinished. Do not describe several thin arcs as a filled color region.
- **Web drawing**: prefer small strokes and observation between them. Do not use `allLayers:true` as a substitute for observing the drawing.
- **Ordinary UI and video editing**: `cu_batch` may be used with explicit checkpoints.

## Application Architecture Quick-Reference

| Application Type | Examples | Discovery & Control Channel | Key Pitfalls & Craft Rules |
|---|---|---|---|
| **Web Canvas** | Canva, Figma, tldraw | `cu_discover({urlMatch})` + `cu_cdp_paint` with small, visually reviewed strokes | Browser render loops drop native `CGEvent` (`cu_paint`); use `cu_cdp_paint`. Keep zoom at 100% (`autoBrush:true` sets this automatically). Merge strokes with `strokeMode:"regions"` to beat the 2,000-element cap. Never `Page.reload`. |
| **Native AX + Canvas** | Apple Freeform | `cu_discover({appName:"Freeform"})` + `cu_click(ref)` + `cu_paint({strokesFile, expectedHex, paintRegion, brushWidth})` | Must be frontmost (`activate`) for `cu_paint` hid-events to land. Every colour change resets tool to `选择` — re-arm `Drawing tool` before each layer. Do NOT use region serpentine merging on Freeform (draws diagonal connectors). Recheck every stroke and compare the artwork with the reference. |
| **Qt/Metal with full AX** | 剪映专业版 (Jianying / CapCut) 11.x | `cu_discover({pid, windowId})` + `cu_snapshot` + `cu_click(ref)` / `cu_type(mode:"setvalue")`; timeline drags use `cu_drag({foreground:true, authorizeForeground:true})` | AX tree is complete (190+ nodes); automation IDs live in `AXDescription` (`root_素材`, `automationtextArea`). `cu_discover` / `cu_find` now read the full snapshot, so OCR is only a fallback for pure canvas text. Select a timeline clip before reading `rightInspector`. Only timeline drags need foreground authorization. |
| **Native ProKit/Cocoa** | Final Cut Pro, Finder, Notes | `cu_discover({pid, windowId})` + `cu_snapshot` + `cu_click(ref)` / `cu_type(mode:"setvalue")` + `cu_batch` | Rich AX tree across Browser, Viewer, Inspector, and Magnetic Timeline. If `truncated:true`, pass `maxNodes:2000` to `cu_snapshot`. Use `cu_type(mode:"setvalue")` on `AXSlider` / `AXTextField` and verify with `cu_expect`. |

## Core Execution & Safety Rules

1. **Background First (Never Steal Focus by Default)**
   - `cu_click`, `cu_drag`, `cu_type`, `cu_key`, and `cu_scroll` default to `foreground: false` (background execution via `AXPress` or PID-targeted events).
   - A foreground action takes focus and real keyboard/mouse input. It runs only with BOTH `foreground: true` and `authorizeForeground: true` (after explicit user permission).
   - A background operation that needs foreground capability reports `capability: "background_unavailable"` / `requiresForeground`; do not retry it blindly or silently promote it.

2. **Session Visibility & Target Preview (`cu_session`)**
   - Before operating on a native target window, call `cu_session` with `action: "start"`, passing `windowId`, `pid`, `appName`, and `preview: true`.
   - It starts a non-activating, draggable native picture preview and a per-target halo without moving, docking, or staging any window (`dockDsh`, `splitScreen`, and `bringOnStage` are explicit opt-ins).
   - Use `targetId` from the start result for all subsequent calls. Multiple targets can be held concurrently in one chat.
   - To identify a native preview panel vs. the controlled app window, read `cu_status.targets[].nativePreview`. Never treat a feedback helper or preview window as the target window.
   - If any tool returns `PAUSED_BY_USER`, stop immediately and ask the user before calling `cu_session(action="resume")`.

3. **A Dispatched Event Is Not a Successful Action**
   - `ok: true` only means the engine dispatched the event. A raw PID event without an explicit `expect` returns `ok:false, error:"effect_not_verified"`; do not replay it blindly.
   - Pass `expect` (`{ query, ref, enabled, value, contains, timeoutMs }`) or call `cu_expect` / `cu_screenshot` to verify the state actually changed.
   - Build `expect` conditions from text or controls you actually observed in `cu_discover` / `cu_snapshot`, never from guessed labels or undocumented keyboard shortcuts.

4. **Coordinates Must Come From the Current Frame**
   - `cu_snapshot` node frames (`@x,y width×height`) are already global screen logical points (top-left origin). Do not add the window origin to them.
   - Screenshot pixels map to logical screen points via `screen = origin + pixel / scale`.
   - `point_outside_target_window` and `window_geometry_changed` are refusals, not transient errors: call `cu_snapshot` again and derive fresh coordinates.
   - Report stop/cleanup status literally: `restoredTarget: false` and `cleanupState: "unknown"` must never be reported as "restored" or "cleaned up".
