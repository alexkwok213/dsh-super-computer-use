// App playbooks — the "capability router" & universal UI exploration model.
//
// The hard part of computer use is not clicking; it is:
//   1. Understanding the user's true GOAL and the authenticity boundary (driving
//      the target app's real tools/timeline/canvas rather than faking results);
//   2. Building a mental map of the app's UI ZONES (top toolbar, left rail/media,
//      center canvas/viewer, right inspector, bottom timeline/sub-bar) and
//      discovering hidden secondary popovers (sliders, hex inputs, parameters);
//   3. Running a 1-step closed-loop probe to verify how the app reacts;
//   4. Batching the remaining operations for high speed.
//
// FIRST PRINCIPLE (see docs/process-authenticity-oracle.md): computer use is
// valuable because it OPERATES the target application, not because it makes a
// pre-rendered artifact appear inside it. Rendering a picture off-screen and
// uploading/pasting it is process fraud: the pixels match, but no computer use
// happened. Every route below therefore ends with real operations inside the
// target app (cu_paint for native drawing, cu_cdp_paint for web canvas, real
// timeline/inspector manipulation for video editors). Off-screen rendering is
// allowed ONLY as a composition/colour preview, never as a delivery path.
//
// This module keeps four kinds of verified knowledge:
//   1. UNIVERSAL_EXPLORATION_PROTOCOL — the 4-stage onboarding loop for ANY app.
//   2. PLAYBOOKS      — per-app capability maps (controls / flows / pitfalls).
//   3. TOOL_CHANNELS  — what each cu_* tool costs and requires.
//   4. routes         — per-app decision rules: given an intent, which ordered
//                       path to take, what it costs, and what to avoid.

/** Channel / cost metadata for the cu_* tool surface. Pure data, no imports. */
export const TOOL_CHANNELS = {
  cu_status:        { channel: "read",    note: "health, vision route, targets, pause state; safe while paused" },
  cu_windows:       { channel: "read",    note: "window/pid enumeration; safe while paused" },
  cu_snapshot:      { channel: "read",    note: "AX tree refs; safe while paused" },
  cu_expect:        { channel: "read",    note: "poll a visible condition without acting" },
  cu_screenshot:    { channel: "capture", note: "needs Screen Recording; returns origin+scale for coordinate mapping. Verification only — NEVER a delivery proof." },
  cu_find:          { channel: "capture", note: "AX first, OCR fallback; for canvas-heavy panes" },
  cu_session:       { channel: "session", note: "attach/detach target; start before operating" },
  cu_launch:        { channel: "session", note: "background by default; foreground needs explicit authorization" },
  cu_route:         { channel: "strategy", note: "offline lookup; read-only, never claims the desk" },
  cu_discover:      { channel: "strategy", note: "web: CDP DOM enumeration + 5-zone UI map; native: AX tree (+ optional OCR) + 5-zone UI map + matched playbook" },
  cu_click:         { channel: "ax",      note: "prefers AXPress; coordinate clicks need a fresh snapshot" },
  cu_click_text:    { channel: "ax",      note: "AXPress by label, OCR coordinate fallback" },
  cu_type:          { channel: "ax",      note: "type / setvalue / named AX action" },
  cu_key:           { channel: "ax",      note: "deterministic shortcut; do not guess undocumented ones" },
  cu_scroll:        { channel: "ax",      note: "background wheel by default" },
  cu_drag:          { channel: "native",  note: "real pointer for canvas/timeline drags; background may be ignored" },
  cu_batch:         { channel: "composite", note: "many deterministic steps in one round trip; use expect checkpoints" },
  cu_paint_plan:    { channel: "offline", note: "compile reference image into layered horizontal runs; also produces an inline preview for composition checking" },
  cu_paint:         { channel: "native", needsForeground: true, focusRisk: true, authoritativeStroke: true,
                      note: "CGEvent strokes INTO a NATIVE app; the app must be frontmost. The only legitimate native drawing delivery channel." },
  cu_cdp_paint:     { channel: "cdp",    authoritativeStroke: true,
                      note: "Input.dispatchMouseEvent INTO a WEB canvas (with built-in DOM brush setup, connected-region merging and seam pass); requires an owned debug Chrome. The only legitimate web drawing delivery channel." },
};

/**
 * Universal 4-stage onboarding & execution protocol for ANY desktop or web app.
 * Teaches the agent how to approach unfamiliar interfaces (Canva, Freeform,
 * 剪映专业版, Final Cut Pro, Blender, or any unseen software) like a thoughtful
 * human operator: understand the goal -> map the 5 UI zones -> probe 1 step to
 * reveal secondary controls -> batch execute.
 */
export const UNIVERSAL_EXPLORATION_PROTOCOL = [
  {
    stage: 1,
    id: "goal_and_authenticity",
    title: "明确目的与过程真实性边界（cu_route）",
    action: "先调 cu_route({intent, appName|url})，区分『用户要达成的业务目的』与『禁止的投机捷径』。Computer Use 的核心是驱动目标应用的原生工具/画笔/时间线/检查器产生结果，严禁在外部伪造/渲染成品文件再导入充数。",
  },
  {
    stage: 2,
    id: "spatial_zone_mapping",
    title: "摸清界面五大功能分区（cu_discover）",
    action: "调 cu_discover 获取界面的 5 大空间分区（topToolbar 顶部全局栏、leftSidebar 左侧工具/素材箱、centerStage 中央画布/监视器、rightInspector 右侧参数检查器、bottomBarOrTimeline 底部时间线/二级工具条），先搞清楚按钮、滑块、画布和轨道分别在哪。",
  },
  {
    stage: 3,
    id: "one_step_probe",
    title: "上手试探一招：探测二级浮层与单步闭环验证",
    action: "许多功能（如画笔粗细/颜色、视频片段属性、转场参数）藏在点击主工具后才展开的二级浮层或检查器里。先点开主工具 → 再次观察新出现的滑块/输入框 → 在画布或时间线上做 1 个最小动作并用 cu_expect / cu_screenshot 验证真正生效。",
  },
  {
    stage: 4,
    id: "batch_execution",
    title: "按任务分段执行并持续观察",
    action: "绘画先理解参考图的主体、轮廓、色块和顺序；每笔观察画布与颜色，验证失败立即停止。普通 UI 序列可用 cu_batch 并设置检查点。",
  },
];

/**
 * Delivery paths that are categorically forbidden for a drawing/creative task.
 * Kept as data so tests can assert it never disappears.
 */
export const PROHIBITED_DELIVERY_PATHS = [
  "离屏渲染 PNG → 上传/粘贴/拖入目标 app（图片对象）",
  "用剪贴板 Cmd+V 把外部生成的图片放进白板",
  "用 CDP DOM.setFileInputFiles / 文件输入框把渲染图导入画布",
  "把截图、预览图或任何外部图片当作最终交付物",
  "调用 scripts/draw-image.mjs 的放置能力（该能力已移除，脚本仅供离屏预览）",
];

/** Intent keywords are kept short and literal so routing stays testable. */
const DRAW_INTENT = {
  keywords: ["画", "绘制", "还原", "复制", "临摹", "参考图", "draw", "reproduce", "copy", "image", "paint"],
  boost: ["这幅图", "像素", "精确", "忠实", "一样", "清晰", "pixel", "exact", "faithful", "crisp", "手绘", "笔触", "画笔"],
  summary: "用户要求把一幅参考图画进目标应用（无论是否要求像素级精确）",
};

const VIDEO_EDIT_INTENT = {
  keywords: ["剪辑", "视频", "时间线", "分割", "字幕", "导入", "导出", "片段", "轨道", "转场", "特效", "音频", "配乐", "调色", "变速", "edit", "video", "timeline", "clip", "cut", "trim", "blade", "export", "import"],
  boost: ["粗剪", "成片", "对齐", "关键帧", "检查器", "磁性时间线", "inspector", "keyframe"],
  summary: "用户要求在视频剪辑软件中完成素材导入、时间线剪辑、属性调整或导出",
};

const DRAWING_ACCEPTANCE = [
  "最终画面必须由目标 app 内的笔画对象构成：原生 app 由 cu_paint 落笔，网页 canvas 由 cu_cdp_paint 落笔",
  "保留可核验的过程证据：落笔工具调用记录 + 笔画数/元素数；截图只用于构图校验，不是交付证明",
  "若目标 app 有元素上限，用 planLayerToRegionStrokes()（cu_cdp_paint 的 strokeMode:'regions'）在 app 内合并笔画解决，不得改用上传",
];

const VIDEO_EDIT_ACCEPTANCE = [
  "所有剪辑动作（导入、入轨、分割、参数调节、字幕、导出）必须在目标剪辑软件内通过真实控件/时间线交互完成",
  "每次关键操作（素材入轨、分割片段、修改检查器参数）必须经由 AX delta、OCR 或局部截图核实状态已改变，不得仅凭事件派发 ok:true 宣称完成",
];

export const PLAYBOOKS = [
  {
    id: "canva-whiteboard",
    match: /canva\.com\/design\/|canva.*白板|白板.*canva/i,
    native: false,
    title: "Canva 设计 / 白板（含画笔）",
    summary:
      "画布是自绘的 Canvas 区域；工具栏在左侧竖排，画布靠 CDP Input.dispatchMouseEvent 落笔。" +
      "系统 AX 树只暴露 Chrome 外壳，页面里的控件必须从 DOM 读（有 aria-label 的 button/input）。" +
      "cu_cdp_paint 已内置 DOM 画笔驱动（autoBrush:true）、连通区域合并（strokeMode:'regions'）与半格补缝（seamPass:true）。",
    controls: [
      { name: "画笔", kind: "rail-tool", selector: "[aria-label='画笔']", note: "激活时背景 rgba(57,70,96,.14)；点它可开/关画笔面板" },
      { name: "颜色", kind: "button", selector: "[aria-label='颜色']", note: "打开调色板；当前色在 [role=img][aria-label='#rrggbb']" },
      { name: "添加新颜色", kind: "palette-entry", selector: "[aria-label='添加新颜色']", note: "打开后出现 hex 文本框（value 形如 #1e1e1e）" },
      { name: "设置", kind: "button", selector: "[aria-label='设置']", note: "打开「粗细」「不透明度」两个 input[type=range]（默认 36 / 50）" },
      { name: "缩放选项", kind: "combobox", selector: "[aria-label='缩放选项']", note: "显示百分比；画布坐标只在 100% 对齐" },
    ],
    flows: {
      drawImage: [
        "1. 意图与规划：先调 cu_route 与 cu_discover({urlMatch:'canva.com'}) 确认画布区域与左侧画笔控件",
        "2. 生成笔画计划：调 cu_paint_plan(imagePath, x, y, width, height, grid≈140, colors≈8)，读取返回的 recommendedBrushThickness 与 activeLayerIndices",
        "3. 先确认参考图、画布、画笔和颜色，进行最小笔画并观察实际结果",
        "4. 目前 cu_cdp_paint 不具备逐笔核验：不要用 allLayers 批量执行冒充已验证的逐笔作画；若无法逐笔操作和观察，应如实说明限制",
      ],
    },
    prohibited: PROHIBITED_DELIVERY_PATHS,
    routes: [
      {
        id: "freehandCdp",
        when: DRAW_INTENT,
        prefer: true,
        why: "用户要的是用 computer use 在 Canva 里把图画出来，不是让画布里出现一张图。落笔必须发生在目标页面。cu_cdp_paint 可通过 CDP 驱动画笔，但目前不提供逐笔颜色核验，应如实说明该限制。",
        steps: [
          "cu_route → cu_discover({urlMatch:'canva.com'}) 了解界面五大分区与画笔二级面板控件",
          "cu_paint_plan 生成分层计划，获取推荐笔宽与非近白图层索引（预览图仅供构图核对）",
          "先研究参考图的主体、轮廓和颜色，确认画笔和颜色设置",
          "cu_cdp_paint 的连通区域批量路径没有逐笔视觉验证；如无法逐笔绘制并检查，停止并报告能力限制",
          "cu_screenshot 对比校验最终画面；报告 layersPainted / strokes / points 作为过程证据",
        ],
        tools: ["cu_route", "cu_discover", "cu_paint_plan", "cu_cdp_paint", "cu_screenshot"],
        cost: { roundTrips: 4, needsForeground: false, focusRisk: false, elements: 350, level: "low",
                note: "现有 CDP 连通区域绘制尚未提供逐笔观察和颜色校验" },
        avoid: [
          "严禁离屏渲染 PNG 后上传/拖入/粘贴：那不是 computer use，是图片搬运",
          "不要对网页 canvas 用 cu_paint（CGEvent 会被渲染循环丢弃）",
          "不要用 strokeMode:'runs' 逐条横线落元素（会超 2000 上限）；保持默认 strokeMode:'regions' 连通区域合并",
          "不要自动清空已有画布；先检查局部错误并征得用户对破坏性操作的授权",
          "绝不能 Page.reload 编辑器：会掉到模板/落地页并丢失画布",
        ],
        preflight: ["启动 owned debug Chrome（launch:true），不要 attach 日常浏览器", "缩放必须 100%（autoBrush:true 会自动校准）", "粗细至少为网格 cell 的 2 倍（autoBrush:true 会按计划自动设置）"],
        acceptance: DRAWING_ACCEPTANCE,
        verifiedAt: "2026-11-08",
        source: "docs/2026-11-08-computer-use-playbook.md 第二、六节 Canva 实测 + 用户过程真实性裁决",
      },
    ],
    pitfalls: [
      "分层覆盖法（关键）：不要一条横线一个元素——把每层按连通区域串成蛇形连续笔迹。实测 3321 runs 从 6642 个元素降到 350 个，远低于上限。planLayerToRegionStrokes() 已内置为 cu_cdp_paint 的 strokeMode:'regions'。",
      "白板有 2000 个素材上限（实测 3321 runs × 2 pass 会触发「超出 2,000 个素材」，无法保存）；必须控制在 ~1500 笔以内，用连通区域合并解决，不得改走上传",
      "Cmd+Z 通过 CDP 键盘事件进不了 Canva 撤销栈，重画只能全选删除（clearFirst:true）",
      "换颜色后面板会关闭且工具可能回到「选择」，落笔前必须再 armBrush（autoBrush:true 会自动处理）",
      "换色不会重置粗细（已验证 25 保持 25）",
      "绝不能 Page.reload 编辑器：会掉到模板/落地页并丢失画布",
      "打开颜色/设置浮层时不要点画布，否则会把浮层点掉或误画",
      "2000 元素上限是 app 内的物理约束，要用 app 内的笔画合并解决，不是绕过 computer use 的理由",
    ],
  },
  {
    id: "apple-freeform",
    match: /freeform/i,
    native: true,
    title: "Apple Freeform（白板绘图）",
    summary:
      "原生 macOS 白板。绘制靠真实指针事件（CGEvent），不是 CDP。必须先把 Freeform 激活到前台，否则 hid-events 会发给别的窗口，笔画不出现。",
    controls: [
      { name: "Drawing Tools", kind: "checkbox", selector: 'AXCheckBox "Drawing Tools" @481,55', note: "工具栏右侧铅笔图标；勾选后底部出现绘图条" },
      { name: "Drawing tool", kind: "button", selector: 'AXButton "Drawing tool"', note: "当前笔型，值形如 Pen" },
      { name: "Choose a drawing tool", kind: "popover", selector: 'AXButton "Choose a drawing tool"', note: "展开 5 档笔宽（Extra-fine/Fine/Medium/Heavy/Extra-heavy）+ 10 种笔（Pen/Monoline/Marker/Pencil/Crayon/Fountain Pen/Reed/Watercolor/Fill/Eraser）" },
      { name: "Choose a color", kind: "button", selector: 'AXButton "Choose a color"', note: "颜色选择器；value 为当前色名（如 black）" },
      { name: "Zoom", kind: "menubutton", selector: 'AXMenuButton "Zoom"', note: "左下角，显示百分比" },
    ],
    flows: {
      drawImage: [
        "先观察参考图，描述主体、轮廓、色块、颜色与前后关系；规划可以手工绘制的连续笔画，不把扫描线当作默认方案",
        "cu_windows → cu_session start（cursor:true）→ cu_discover，打开绘图工具并选择画笔及笔宽",
        "为当前区域选颜色，确认颜色控件，关闭面板后重新选择 Drawing tool",
        "用 cu_paint(strokesFile, expectedHex) 按参考图画一笔；每笔先后截图并核验该笔颜色和画布变化，失败即停止",
        "观察画布与参考图，确认位置、形状和颜色；只有确认后才按 nextOffset 继续，换色后重复核验",
        "最终截图与参考图逐项对照；不把像素检查通过当成作品质量通过",
      ],
    },
    prohibited: PROHIBITED_DELIVERY_PATHS,
    routes: [
      {
        id: "freehandNative",
        when: DRAW_INTENT,
        prefer: true,
        why: "用户要的是在 Freeform 里用画笔把图画出来。唯一合法的交付通道是 cu_paint 把真实指针笔画注入 Freeform；离屏渲染再粘贴即使逐像素一致，也没有发生任何 computer use 操作，属于过程造假（用户 2026-11-08 明确裁决）。",
        steps: [
          "先观察参考图并说明主体、构图、轮廓与颜色；按可见区域规划连续画笔路径",
          "确认目标窗口、画笔、笔宽和颜色；换色后重新选择 Drawing tool",
          "每笔通过 cu_paint 真实拖动画笔，并检查截图中的位置、形状和颜色；核验失败立即停止",
          "根据 nextOffset 逐笔继续；定期将当前画布与参考图比较，修正局部而非反复清空重来",
          "完成后对照参考图，诚实报告未画出的内容和偏色；保留过程证据",
        ],
        tools: ["cu_paint_plan", "cu_paint", "cu_discover", "cu_screenshot"],
        cost: { roundTrips: 16, needsForeground: true, focusRisk: true, elements: 3177, level: "high",
                note: "逐笔截图核验需要时间；事件派发或像素匹配不能证明最终画面相似" },
        avoid: [
          "严禁离屏渲染 PNG 后粘贴（Cmd+V）/上传/拖入 Freeform：这是投机取巧，用户已判定错误",
          "不要假设换色后画笔仍激活：Freeform 换色会让工具跳回「选择」，落笔前必须重新点 Drawing tool",
          "Colors 是独立 axOnly 窗口（windowId 0），cu_snapshot 读不到，后台 AXPress 对颜色按钮也不生效，需前台真实点击 + osascript 定位",
          "不要用 planLayerToRegionStrokes 折线合并：跨行连接线会拉出大量长斜线（仅适用于网页 canvas）",
          "不自动批量补缝；先检查当前画布，再决定是否需要局部补笔",
        ],
        preflight: [
          "osascript -e 'tell application \"Freeform\" to activate'（不在前台则 hid-events 不落笔）",
          "粘贴/上传类路径已在 prohibited 中禁用；本任务只允许 cu_paint 落笔",
          "每次换色后重新观察工具并逐笔检查颜色",
        ],
        acceptance: DRAWING_ACCEPTANCE,
        verifiedAt: "2026-11-08",
        source: "本轮 Freeform 实测：16 色画笔版可完整落笔（横纹可经补缝改善）；用户裁决离屏 PNG 粘贴为错误方式",
      },
    ],
    pitfalls: [
      "Freeform 不在前台时 hid-events 不落笔（实测第一次全无反应，activate 后成功）",
      "画笔浮层（Choose a drawing tool）打开时会挡住颜色按钮，先 Escape 关闭",
      "Fill 工具可填充闭合区域，比逐笔刷更快",
      "不要用 planLayerToRegionStrokes 的折线合并法：跨行连接线会在画面里拉出大量长斜线，看起来像草稿（实测被用户指正）",
      "不要根据颜色接近白色就自动忽略参考图中的必要轮廓和细节",
      "换色后工具跳回「选择」：Colors 面板关闭后必须重新点 Drawing tool（底部绘图条），否则下一层不落笔",
      "Colors 面板是 axOnly 窗口（windowId 0），不在普通窗口列表里；用 osascript 读它的位置/关闭按钮",
      "不要默认采用逐扫描线重建；优先按参考图轮廓和色块规划笔画",
      "离屏渲染再粘贴/上传属于过程造假，用户 2026-11-08 明确判定为错误；交付必须由 cu_paint 在 Freeform 内落笔",
    ],
  },
  {
    id: "jianying-pro",
    match: /剪映|JianyingPro|VideoFusion|CapCut/i,
    native: true,
    title: "剪映专业版 / CapCut（多轨视频剪辑）",
    summary:
      "剪映专业版 11.x 的 AX 树是完整的（实测 190+ 节点）：内部控件多为 AXStaticText，标识写在 AXDescription 里（root_素材 / automationtextArea / MainWindowTitleBarExportBtn）。" +
      "优先用 cu_discover / cu_snapshot 的完整树 + ref 后台精确操作；OCR 仅作附带校验，前台授权只在时间线拖拽等自绘画布交互时需要。",
    controls: [
      { name: "左上分类栏", kind: "ax-static-text", selector: "AXDescription: root_素材 / root_音频 / root_文本 / …", note: "13 个分类标签，AXStaticText + automation ID，可直接用 ref 点击" },
      { name: "导入/素材区", kind: "ax-button", selector: "AXButton: MainWindowTitleBarExportBtn 等；素材卡片带 .apply 按钮", note: "选中素材后拖拽到底部时间线，或点素材右下角『+』入轨" },
      { name: "播放器预览", kind: "viewer", selector: "centerStage 区域 / PlayerPlayBtn", note: "画面预览与播放/暂停（空格键）" },
      { name: "属性检查器", kind: "inspector", selector: "rightInspector 的 automation* SpinBox / Slider / AXTextField", note: "只有先在时间线或画布选中片段后，右侧才会展开对应参数面板" },
      { name: "多轨时间线", kind: "timeline", selector: "bottomBarOrTimeline / MainTimeLineRoot", note: "支持拖拽入轨、播放头定位、分割片段与轨道缩放；拖拽需前台真实鼠标" },
      { name: "导出", kind: "ax-button", selector: "AXButton: MainWindowTitleBarExportBtn（右上角）", note: "打开导出参数弹窗" },
    ],
    flows: {
      editTimeline: [
        "1. 意图与会话：调 cu_route → cu_windows → cu_session(action:'start') 锁定剪映窗口（仅时间线拖拽需要 authorizeForeground:true）",
        "2. 五大分区探测：调 cu_discover({pid, windowId})，它读取完整 AX 快照，leftSidebar / rightInspector / bottomBarOrTimeline 都会带上 automation ID 控件",
        "3. 单步上手试探：用 cu_snapshot 取 ref 后 cu_click(ref) 点击分类标签（如 root_文本），重新观察左侧面板刷新的子项；选中片段后观察右上检查器展开的二级标签",
        "4. 时间线操控与校验：参数修改用 cu_type(mode:'setvalue') / cu_click(ref) 后台完成；素材入轨与拉动时间线用 cu_drag(foreground:true, authorizeForeground:true)，每次操作后用 cu_expect / cu_snapshot 确认轨道与时间码变化",
      ],
    },
    prohibited: PROHIBITED_DELIVERY_PATHS,
    routes: [
      {
        id: "timelineJianying",
        when: VIDEO_EDIT_INTENT,
        prefer: true,
        why: "剪映 11.x 的 AX 树完整（190+ 节点，automation ID 写在 AXDescription），分类标签、导入、导出、检查器与时间线工具栏都能通过 cu_snapshot 的 ref 后台精确操作；只有自绘画布的时间线拖拽需要前台真实鼠标。",
        steps: [
          "cu_session(action:'start', pid, windowId) 锁定剪映窗口（拖拽入轨时再加 authorizeForeground:true）",
          "cu_discover({pid, windowId}) 读取完整 AX 快照，拿到五大分区的 automation ID 与坐标",
          "单步试探：cu_snapshot 取 ref → cu_click(ref) 点击目标标签（如 root_文本 / cutoff / MainWindowTitleBarExportBtn），用 cu_expect 确认二级面板或时间线状态变化",
          "执行剪辑：参数修改用 cu_type(mode:'setvalue') / cu_click(ref) 后台完成；素材入轨与拉动时间线用 cu_drag(foreground:true, authorizeForeground:true)",
          "每步关键操作后用 cu_expect / cu_snapshot 或局部 cu_screenshot 核实结果；OCR 只在 AX 未覆盖的纯画布文本时兜底",
        ],
        tools: ["cu_route", "cu_discover", "cu_session", "cu_snapshot", "cu_click", "cu_find", "cu_type", "cu_expect", "cu_drag", "cu_screenshot"],
        cost: { roundTrips: 5, needsForeground: false, focusRisk: false, elements: 190, level: "low",
                note: "AX 树完整，绝大多数操作可后台完成；仅时间线拖拽需前台真实鼠标" },
        avoid: [
          "不要用旧的 `ax --depth 6` 浅层遍历判断 AX 能力：它只读 AXTitle/AXValue，会漏掉剪映放在 AXDescription 的 automation ID；cu_discover / cu_snapshot 现在统一读完整快照",
          "不要在未选中时间线片段时去点右上检查器：未选中片段时检查器只显示空状态或草稿信息",
          "后台拖拽（foreground:false）会被剪映画布忽略，拖拽入轨必须显式授权前台操作",
          "严禁在外部用 ffmpeg 合成视频冒充在剪映内完成了时间线剪辑",
        ],
        preflight: [
          "先运行 cu_discover({pid, windowId}) 建立五大分区坐标图（无需 includeOcr）",
          "仅当需要向时间线拖入素材时，才申请前台操作授权（authorizeForeground:true）",
        ],
        acceptance: VIDEO_EDIT_ACCEPTANCE,
        verifiedAt: "2026-11-12",
        source: "剪映专业版 11.7.13472 实测：内置 DSH CUA 与 cu_snapshot 均读到 190+ AX 节点，automation ID 位于 AXDescription",
      },
    ],
    pitfalls: [
      "剪映的控件标识在 AXDescription 而非 AXTitle（如 root_素材 / automationtextArea）；旧版浅层 ax --depth 遍历会看到空树，但 cu_discover / cu_snapshot 的完整快照能看到全部 190+ 节点，不要据此误判为自绘界面",
      "右上角属性检查器是上下文相关的二级面板：必须先在底部时间线点击选中某个片段，右上角才会出现『文本/画面/音频/变速』参数",
      "事件派发 ok:true 不代表剪映时间线接受了拖拽，拖拽后必须检查底部轨道缩略图或时间码变化",
    ],
  },
  {
    id: "final-cut-pro",
    match: /Final Cut Pro/i,
    native: true,
    title: "Final Cut Pro（原生磁性时间线剪辑）",
    summary:
      "macOS 原生 ProKit/Cocoa 架构，AX 无障碍树非常丰富，完整暴露五大区域：左上资源库与浏览器（Browser）、中上检视器（Viewer）、右上检查器（Inspector 含完整 AXSlider/AXCheckBox/AXPopUpButton）、底部磁性时间线（Magnetic Timeline）。",
    controls: [
      { name: "Browser / 资源库与事件浏览器", kind: "ax-group", selector: "leftSidebar 区域 AXSplitGroup", note: "管理导入的片段、字幕、发生器与转场（右侧边栏按钮可开闭效果/转场面板）" },
      { name: "Viewer / 检视器", kind: "ax-group", selector: "centerStage 区域", note: "实时画面监视、变换/裁切/失真模式切换" },
      { name: "Inspector / 检查器", kind: "ax-group", selector: "rightInspector 区域", note: "暴露真实的 AXSlider / AXTextField / AXCheckBox，可直接用 cu_type(mode:'setvalue') 或 cu_click(ref) 精确改参数" },
      { name: "Magnetic Timeline / 磁性时间线", kind: "ax-group", selector: "bottomBarOrTimeline 区域", note: "主故事线与连接片段，中间工具栏切换选择(A)、切割(B)、修剪(T)、位置(P)" },
    ],
    flows: {
      editTimeline: [
        "1. 意图与探测：调 cu_route → cu_discover({pid, windowId})，一次性拿到五大分区的 AX 控件树",
        "2. 理解二级面板：在 Browser 或磁性时间线中点击选中一个片段（cu_click ref），再调 cu_snapshot 观察右上 Inspector 新刷出的参数控件（缩放、位置、音量、字幕文本）",
        "3. 单步闭环验证：对 Inspector 中的滑块或输入框执行 1 次 cu_type(mode:'setvalue') 或工具切换，配合 cu_expect 验证数值已写回",
        "4. 批量执行：确认控件 ref 与行为一致后，用 cu_batch 串联后续確定性步骤",
      ],
    },
    prohibited: PROHIBITED_DELIVERY_PATHS,
    routes: [
      {
        id: "magneticTimelineNative",
        when: VIDEO_EDIT_INTENT,
        prefer: true,
        why: "Final Cut Pro 具备完整的原生 AX 树。先通过 cu_discover 建立五大功能区地图，再选中片段驱动右上 Inspector 的真实 AX 控件与底部磁性时间线，既快又可精确回读验证。",
        steps: [
          "cu_discover({pid, windowId}) 建立五大分区（Browser / Viewer / Inspector / Timeline / TopBar）控件映射",
          "单步上手试探：先用 cu_click(ref) 选中目标片段或切换工具，观察 Inspector 面板暴露的二级 AXSlider / AXTextField",
          "优先用 cu_click(ref) 与 cu_type(mode:'setvalue', ref) 修改参数，并用 cu_expect 验证数值生效",
          "对重复性剪辑动作使用 cu_batch 带 expect 检查点批量执行",
        ],
        tools: ["cu_route", "cu_discover", "cu_snapshot", "cu_click", "cu_type", "cu_expect", "cu_batch"],
        cost: { roundTrips: 4, needsForeground: false, focusRisk: false, elements: 0, level: "low",
                note: "原生 AX 控件支持后台精确读写与 cu_expect 状态轮询" },
        avoid: [
          "不要在不看 AX 树的情况下盲猜屏幕坐标点击：Final Cut Pro 的按钮和滑块都有精确 AX ref",
          "不要在未选中片段时尝试修改 Inspector 参数：先选中时间线或 Browser 中的目标对象并确认 Inspector 已刷新",
          "不要盲目猜快捷键：工具栏和菜单项均可通过 AX 树确认当前激活态",
        ],
        preflight: [
          "运行 cu_discover({pid, windowId}) 获取五大分区的 AX 控件列表",
          "若窗口节点超过 800（truncated:true），在 cu_snapshot 中调高 maxNodes（如 2000）",
        ],
        acceptance: VIDEO_EDIT_ACCEPTANCE,
        verifiedAt: "2026-11-08",
        source: "Final Cut Pro 原生 Cocoa/AX 分区架构与磁性时间线操作规范",
      },
    ],
    pitfalls: [
      "Final Cut Pro 界面节点较多，默认 snapshot 预算（800）若返回 truncated:true，需传 maxNodes:2000 获取完整时间线节点",
      "Inspector（右上）与 Effects/Transitions 面板（右下侧开关）默认可能折叠，需先看 topToolbar / bottomBarOrTimeline 的面板开关状态",
    ],
  },
  {
    id: "web-canvas-generic",
    match: /.*/,
    native: false,
    title: "通用网页 Canvas / 未知应用探索模板",
    summary: "未知或通用应用：先用 cu_discover 建立五大空间分区地图（顶部栏/左栏/中央主区/右检查器/底栏），点选主工具试探二级面板，验证 1 步闭环后再批量执行。",
    controls: [],
    flows: {
      drawImage: ["先用 cu_discover 枚举五大分区控件（[aria-label]、button、input[type=range]、canvas 或原生 AX/OCR）；试探 1 步确认二级面板与落笔生效后再批量执行"],
      exploreAndOperate: [
        "1. 调 cu_route 明确任务目标与真实性边界",
        "2. 调 cu_discover 获取界面五大分区（zones）与交互通道类型（AX / OCR / CDP DOM）",
        "3. 选 1 个核心控件试探点击，观察弹出的二级设置面板或属性变化",
        "4. 验证 1 步成功后用 cu_batch / cu_cdp_paint / cu_paint 批量完成",
      ],
    },
    prohibited: PROHIBITED_DELIVERY_PATHS,
    routes: [
      {
        id: "discoverFirst",
        when: { keywords: ["画", "绘制", "操作", "编辑", "剪辑", "制作", "draw", "edit", "automate", "use", "create"], boost: [], summary: "未知或通用应用，先做五大分区能力发现与单步试探" },
        prefer: true,
        why: "面对未预置剧本的应用，盲点必错。先通过 cu_discover 把界面划分为五大功能区，试探一招摸清二级面板和通道反应，再批量执行。",
        steps: [
          "cu_discover（网页用 urlMatch，原生应用用 pid/windowId，自绘界面加 includeOcr:true）获取 zones 五大分区地图",
          "读 onboarding 指南、controls 与 playbook.pitfalls / prohibited",
          "单步试探：点击主工具后重新观察新出现的二级滑块/参数面板，优先用 input[type=range] setter 或 AX setvalue",
          "在主画布/主工作区做 1 步最小操作并用 cu_expect / cu_screenshot 确认生效后，再批量执行",
        ],
        tools: ["cu_discover", "cu_cdp_paint", "cu_screenshot"],
        cost: { roundTrips: 3, needsForeground: false, focusRisk: false, elements: 0, level: "low", note: "探测是只读的" },
        avoid: ["不要对网页 canvas 用 cu_paint（CGEvent 会被渲染循环丢弃）", "严禁离屏渲染 PNG 后上传", "不要在不了解界面分区前盲猜坐标连续点击"],
        preflight: ["先调用 cu_discover 获取五大空间分区与控件清单"],
        acceptance: DRAWING_ACCEPTANCE,
        verifiedAt: "2026-11-08",
        source: "docs/2026-11-08-computer-use-playbook.md 第一节",
      },
    ],
    pitfalls: ["不要假设界面没有控件；先 cu_discover 看五大分区再操作", "交付必须由目标应用内的真实操作构成，不得用外部成品文件导入冒充"],
  },
];

/**
 * Partition discovered UI controls into 5 universal spatial zones so the agent
 * immediately understands the layout of ANY unfamiliar application:
 *   - topToolbar          (top ~16% of window height)
 *   - bottomBarOrTimeline (bottom ~22% of window height)
 *   - leftSidebar         (middle height, left ~26% of width)
 *   - rightInspector      (middle height, right ~26% of width)
 *   - centerStage         (middle height, center ~48% of width)
 *
 * Works identically for native AX/OCR nodes (`frame: [x,y,w,h]`) and web DOM
 * nodes (`rect: [x,y,w,h]`).
 */
export function classifyUiZones(items = [], bounds = null) {
  const zones = {
    topToolbar: [],
    leftSidebar: [],
    centerStage: [],
    rightInspector: [],
    bottomBarOrTimeline: [],
  };
  if (!Array.isArray(items) || items.length === 0) return zones;

  // Derive bounds from window geometry or fallback to the bounding box of items.
  let bx = Number(bounds?.x ?? 0);
  let by = Number(bounds?.y ?? 0);
  let bw = Number(bounds?.width ?? 0);
  let bh = Number(bounds?.height ?? 0);
  if (!(bw > 0 && bh > 0)) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const item of items) {
      const r = item?.frame ?? item?.rect;
      if (!Array.isArray(r) || r.length < 4) continue;
      const [x, y, w, h] = r.map(Number);
      if (![x, y, w, h].every(Number.isFinite)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + w > maxX) maxX = x + w;
      if (y + h > maxY) maxY = y + h;
    }
    if (Number.isFinite(minX) && maxX > minX && maxY > minY) {
      bx = minX;
      by = minY;
      bw = maxX - minX;
      bh = maxY - minY;
    } else {
      bw = 1280;
      bh = 800;
    }
  }

  for (const item of items) {
    const r = item?.frame ?? item?.rect;
    if (!Array.isArray(r) || r.length < 4) continue;
    const [x, y, w, h] = r.map(Number);
    if (![x, y, w, h].every(Number.isFinite)) continue;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const relX = Math.max(0, Math.min(1, (cx - bx) / Math.max(1, bw)));
    const relY = Math.max(0, Math.min(1, (cy - by) / Math.max(1, bh)));
    const label = String(item.label ?? item.title ?? item.value ?? item.text ?? "").trim();
    const role = String(item.role ?? item.type ?? "control");
    if (!label && role !== "range" && role !== "AXSlider") continue;
    const compact = {
      label: label || `<${role}>`,
      role,
      ...(item.value !== undefined && item.value !== "" ? { value: item.value } : {}),
      frame: [Math.round(x), Math.round(y), Math.round(w), Math.round(h)],
    };
    if (relY < 0.16) {
      zones.topToolbar.push(compact);
    } else if (relY > 0.78) {
      zones.bottomBarOrTimeline.push(compact);
    } else if (relX < 0.26) {
      zones.leftSidebar.push(compact);
    } else if (relX > 0.74) {
      zones.rightInspector.push(compact);
    } else {
      zones.centerStage.push(compact);
    }
  }

  // Cap each zone so the mental map stays concise and token-friendly.
  for (const key of Object.keys(zones)) {
    zones[key] = zones[key].slice(0, 25);
  }
  return zones;
}

/**
 * Build a concrete onboarding guide for the discovered window so the AI knows
 * HOW to explore and operate this specific interface before clicking around.
 */
export function buildOnboardingPlan({ channel = "native", controlsCount = 0, axNodesCount = 0, ocrCount = 0, zones = {}, playbook = null } = {}) {
  const known = Boolean(playbook && playbook.id !== "web-canvas-generic");
  // A sparse "named control" count is not proof of a self-drawn canvas: 剪映
  // exposes ~190 AX nodes but only a handful carry AXTitle (the rest are
  // AXStaticText labelled through AXDescription). Judge the full tree, like the
  // built-in CUA does, before telling the model to fall back to OCR.
  const isSparseAx = channel === "native" && axNodesCount < 5 && controlsCount < 5;
  const uiArchitecture =
    channel === "web"
      ? "web_dom_and_canvas"
      : isSparseAx
      ? "custom_self_drawn_canvas_needs_ocr_and_foreground"
      : "native_accessibility_tree";

  const zoneOverview = {
    topToolbar: (zones.topToolbar ?? []).slice(0, 6).map((c) => c.label),
    leftSidebar: (zones.leftSidebar ?? []).slice(0, 6).map((c) => c.label),
    centerStage: (zones.centerStage ?? []).slice(0, 6).map((c) => c.label),
    rightInspector: (zones.rightInspector ?? []).slice(0, 6).map((c) => c.label),
    bottomBarOrTimeline: (zones.bottomBarOrTimeline ?? []).slice(0, 6).map((c) => c.label),
  };

  const steps = [];
  if (known) {
    steps.push(`已命中已知应用剧本「${playbook.title}」：请严格遵循 playbook.routes 与 flows，避开 pitfalls。`);
  } else {
    steps.push("当前为未预置剧本的应用，请按通用四步法先摸清界面分区再动手。");
  }
  if (uiArchitecture === "custom_self_drawn_canvas_needs_ocr_and_foreground") {
    steps.push(
      `检测到自绘界面（AX 命名控件仅 ${controlsCount} 个${ocrCount ? `，OCR 识别到 ${ocrCount} 处文本` : ""}）：标准 AX 快照无法覆盖内部按钮，请使用 cu_discover(includeOcr:true) / cu_find(mode:'ocr') / cu_click_text 定位，并向用户申请前台授权（authorizeForeground:true）。`,
    );
  } else if (channel === "web") {
    steps.push("检测到网页 Canvas/DOM 界面：按钮与滑块请通过 DOM aria-label / input[type=range] 驱动，画布落笔必须走 cu_cdp_paint（内置 autoBrush 与连通区域合并）。");
  } else {
    steps.push(`检测到原生 AX 界面（共 ${controlsCount} 个具名控件）：优先通过 cu_snapshot 的 ref + cu_click / cu_type(mode:'setvalue') 后台精确操作。`);
  }
  steps.push(
    "上手试探二级面板：先在 leftSidebar / bottomBarOrTimeline 点击目标主工具或选中片段，再次观察弹出的二级设置浮层或 rightInspector 属性滑块，完成 1 步闭环验证（动作 → expect/截图确认生效）后再批量执行。",
  );

  return {
    uiArchitecture,
    knownPlaybook: known ? playbook.id : null,
    zoneOverview,
    steps,
  };
}

/** Match a URL (and optional page title) to a web playbook. */
export function detectPlaybook(url = "", title = "") {
  const text = `${url} ${title}`;
  for (const pb of PLAYBOOKS) {
    if (pb.id === "web-canvas-generic" || pb.native) continue;
    if (pb.match.test(text)) return pb;
  }
  return PLAYBOOKS.find((p) => p.id === "web-canvas-generic") ?? null;
}

/** Match a native application name / window title to ANY native playbook. */
export function detectNativePlaybook(appName = "", title = "") {
  const text = `${appName} ${title}`;
  const hit = PLAYBOOKS.find((pb) => pb.native && pb.match.test(text));
  return hit ?? null;
}

/** Unified entry point for both channels. */
export function detectTargetPlaybook({ url = "", title = "", appName = "" } = {}) {
  if (url || (!appName && title)) return detectPlaybook(url, title);
  const native = detectNativePlaybook(appName, title);
  return native ?? detectPlaybook(url, title);
}

/** Compact playbook for tool output (drops the regex and normalises routes). */
export function playbookSummary(pb) {
  if (!pb) return null;
  return {
    id: pb.id,
    title: pb.title,
    summary: pb.summary,
    controls: pb.controls,
    flows: pb.flows,
    pitfalls: pb.pitfalls,
    routes: (pb.routes ?? []).map(publicRoute),
    prohibited: pb.prohibited ?? PROHIBITED_DELIVERY_PATHS,
  };
}

/** Strip regex / internals so a route is JSON-safe in a tool result. */
function publicRoute(route) {
  return {
    id: route.id,
    when: {
      keywords: route.when?.keywords ?? [],
      boost: route.when?.boost ?? [],
      summary: route.when?.summary ?? "",
    },
    prefer: route.prefer === true,
    why: route.why ?? "",
    steps: route.steps ?? [],
    tools: route.tools ?? [],
    cost: route.cost ?? null,
    avoid: route.avoid ?? [],
    preflight: route.preflight ?? [],
    acceptance: route.acceptance ?? [],
    verifiedAt: route.verifiedAt ?? null,
    source: route.source ?? null,
  };
}

/**
 * Always-true strategy lines pushed into tool results. These are deliberately
 * generic: they must remain useful even when the target app has no playbook.
 * A router is an advisor, not a gate — the model keeps the final decision.
 */
export const GENERAL_GUIDANCE = [
  "先 cu_route 明确目的与禁止捷径，再 cu_discover 摸清界面五大分区（顶栏/左栏/主画布/右检查器/底栏或时间线）与二级浮层。",
  "过程真实性是硬边界：必须驱动目标 app 的原生工具/画笔/时间线产生结果（如 cu_paint / cu_cdp_paint）；在外部生成成品图片/视频再上传或粘贴是过程造假，禁止。",
  "换工具或颜色后先做最小闭环试探；绘画时逐笔观察画布与参考图，普通界面操作可使用带检查点的 cu_batch。",
];

const GENERIC_METHOD = [
  "1. 明确目的（cu_route）：确认任务意图、合法操作通道与 prohibited 禁用捷径",
  "2. 窗口锁定（cu_status / cu_windows → cu_session start）：锁定目标 pid 与 windowId",
  "3. 界面建图（cu_discover）：网页传 urlMatch，原生传 pid/windowId（自绘 UI 加 includeOcr:true），获取 zones 五大空间分区与控件清单",
  "4. 单步试探（1-Step Probe）：先点选主工具观察弹出的二级参数面板（滑块/颜色/检查器），执行 1 个最小动作并用 cu_expect / cu_screenshot 确认生效",
  "5. 执行与复核：绘画逐笔观察参考图和实际画布；普通 UI 序列可使用带检查点的 cu_batch",
];

function scoreRoute(route, intent) {
  if (!route?.when) return 0;
  let score = 0;
  for (const kw of route.when.keywords ?? []) if (intent.includes(kw)) score += 2;
  for (const kw of route.when.boost ?? []) if (intent.includes(kw)) score += 3;
  if (route.prefer === true) score += 1;
  return score;
}

/** Only the channels actually referenced by this playbook's routes. */
function usedChannels(routes) {
  const out = {};
  for (const route of routes) {
    for (const tool of route.tools ?? []) {
      if (TOOL_CHANNELS[tool]) out[tool] = TOOL_CHANNELS[tool];
    }
  }
  return out;
}

/**
 * Deterministic intent → route lookup. No LLM, no I/O, no state: the same
 * inputs always produce the same recommendation, so it is unit-testable and
 * auditable. Never invents a route: an unmatched app returns noRoute: true
 * plus the generic methodology. `prohibited` and `explorationProtocol` are
 * ALWAYS returned so the agent always knows both what is forbidden and how to
 * onboard onto any unfamiliar interface.
 */
export function routeFor({ intent = "", appName = "", windowTitle = "", url = "", playbook = null } = {}) {
  const pb = playbook ?? detectTargetPlaybook({ url, title: windowTitle, appName });
  const app = pb && pb.id !== "web-canvas-generic" ? pb.id : (appName || url || null);
  const goal = String(intent || "").trim();
  const routes = pb?.routes ?? [];
  const prohibited = pb?.prohibited ?? PROHIBITED_DELIVERY_PATHS;
  const base = {
    goal,
    app,
    playbook: playbookSummary(pb),
    channels: usedChannels(routes),
    prohibited,
    explorationProtocol: UNIVERSAL_EXPLORATION_PROTOCOL,
  };
  // No intent, no verified app playbook, or no routes at all: say so plainly
  // instead of inventing a plan. The generic methodology is still returned.
  const isGeneric = !pb || pb.id === "web-canvas-generic";
  if (!goal || isGeneric || !routes.length) {
    return {
      ...base,
      recommended: null,
      alternatives: isGeneric ? routes.map(publicRoute) : [],
      acceptance: DRAWING_ACCEPTANCE,
      preflight: GENERIC_METHOD,
      noRoute: true,
      fallback: GENERIC_METHOD,
    };
  }
  const ranked = routes
    .map((r) => ({ route: r, score: scoreRoute(r, goal) }))
    .sort((a, b) =>
      b.score - a.score ||
      (a.route.cost?.roundTrips ?? 99) - (b.route.cost?.roundTrips ?? 99)
    );
  const top = ranked[0];
  if (!top || top.score <= 0) {
    return { ...base, recommended: null, alternatives: ranked.map((x) => publicRoute(x.route)),
             acceptance: DRAWING_ACCEPTANCE, preflight: GENERIC_METHOD, noRoute: true, fallback: GENERIC_METHOD };
  }
  return {
    ...base,
    recommended: { ...publicRoute(top.route), matchScore: top.score },
    alternatives: ranked.slice(1).map((x) => ({ ...publicRoute(x.route), matchScore: x.score })),
    acceptance: top.route.acceptance ?? DRAWING_ACCEPTANCE,
    preflight: top.route.preflight ?? GENERIC_METHOD,
    noRoute: false,
  };
}
