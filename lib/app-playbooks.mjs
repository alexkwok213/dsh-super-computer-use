// App playbooks — the "capability router".
//
// The hard part of computer use is not clicking; it is knowing what an
// application can do, which tool channel reaches it, and which route is worth
// taking for the task at hand. A blind agent with perfect mouse control still
// cannot draw in a whiteboard if it does not know the brush has separate
// thickness/opacity/colour controls.
//
// FIRST PRINCIPLE (see docs/process-authenticity-oracle.md): computer use is
// valuable because it OPERATES the target application, not because it makes an
// image appear inside it. Rendering a picture off-screen and uploading/pasting
// it is process fraud: the pixels match, but no computer use happened. Every
// drawing route below therefore ends with real strokes injected INTO the target
// app (cu_paint for native, cu_cdp_paint for web). Off-screen rendering is
// allowed ONLY as a composition/colour preview, never as a delivery path.
//
// This module keeps three kinds of verified knowledge:
//   1. PLAYBOOKS      — per-app capability maps (controls / flows / pitfalls).
//   2. TOOL_CHANNELS  — what each cu_* tool costs and requires.
//   3. routes         — per-app decision rules: given an intent, which ordered
//                       path to take, what it costs, and what to avoid.
//
// `cu_route` calls routeFor() over this data; `cu_discover` calls
// detectTargetPlaybook(); every mutating tool's result can carry a short
// `guidance` distilled from the matched playbook. Knowledge is pushed into the
// model's context at execution time rather than left in a document the model
// has to remember to read.
//
// Keep entries factual: only record controls and pitfalls that were verified by
// actually driving them. Every route carries verifiedAt + source so a stale rule
// can be recognised instead of silently trusted.

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
  cu_discover:      { channel: "strategy", note: "web: CDP DOM enumeration; native: AX tree + matched playbook" },
  cu_click:         { channel: "ax",      note: "prefers AXPress; coordinate clicks need a fresh snapshot" },
  cu_click_text:    { channel: "ax",      note: "AXPress by label, OCR coordinate fallback" },
  cu_type:          { channel: "ax",      note: "type / setvalue / named AX action" },
  cu_key:           { channel: "ax",      note: "deterministic shortcut; do not guess undocumented ones" },
  cu_scroll:        { channel: "ax",      note: "background wheel by default" },
  cu_drag:          { channel: "native",  note: "real pointer for canvas drags; background may be ignored" },
  cu_batch:         { channel: "composite", note: "many deterministic steps in one round trip; use expect checkpoints" },
  cu_paint_plan:    { channel: "offline", note: "compile reference image into layered horizontal runs; also produces a preview for composition checking" },
  cu_paint:         { channel: "native", needsForeground: true, focusRisk: true, authoritativeStroke: true,
                      note: "CGEvent strokes INTO a NATIVE app; the app must be frontmost. The only legitimate native drawing delivery channel." },
  cu_cdp_paint:     { channel: "cdp",    authoritativeStroke: true,
                      note: "Input.dispatchMouseEvent INTO a WEB canvas; requires an owned debug Chrome. The only legitimate web drawing delivery channel." },
};

/**
 * Delivery paths that are categorically forbidden for a drawing task. This is
 * a zero-trust guardrail: assume the executor will look for a shortcut, and
 * make the shortcut unavailable in the route table rather than merely advising
 * against it. Kept as data so tests can assert it never disappears.
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

const DRAWING_ACCEPTANCE = [
  "最终画面必须由目标 app 内的笔画对象构成：原生 app 由 cu_paint 落笔，网页 canvas 由 cu_cdp_paint 落笔",
  "保留可核验的过程证据：落笔工具调用记录 + 笔画数/元素数；截图只用于构图校验，不是交付证明",
  "若目标 app 有元素上限，用 planLayerToRegionStrokes() 在 app 内合并笔画解决，不得改用上传",
];

export const PLAYBOOKS = [
  {
    id: "canva-whiteboard",
    match: /canva\.com\/design\//i,
    native: false,
    title: "Canva 设计 / 白板（含画笔）",
    summary:
      "画布是自绘的 Canvas 区域；工具栏在左侧竖排，画布靠 CDP Input.dispatchMouseEvent 落笔。" +
      "系统 AX 树只暴露 Chrome 外壳，页面里的控件必须从 DOM 读（有 aria-label 的 button/input）。",
    controls: [
      { name: "画笔", kind: "rail-tool", selector: "[aria-label='画笔']", note: "激活时背景 rgba(57,70,96,.14)；点它可开/关画笔面板" },
      { name: "颜色", kind: "button", selector: "[aria-label='颜色']", note: "打开调色板；当前色在 [role=img][aria-label='#rrggbb']" },
      { name: "添加新颜色", kind: "palette-entry", selector: "[aria-label='添加新颜色']", note: "打开后出现 hex 文本框（value 形如 #1e1e1e）" },
      { name: "设置", kind: "button", selector: "[aria-label='设置']", note: "打开「粗细」「不透明度」两个 input[type=range]（默认 36 / 50）" },
      { name: "缩放选项", kind: "combobox", selector: "[aria-label='缩放选项']", note: "显示百分比；画布坐标只在 100% 对齐" },
    ],
    flows: {
      drawImage: [
        "cu_paint_plan(imagePath, rect, grid≈140, colors≈8) 生成分层笔画计划",
        "clearCanvas(): 点画布空白 → Cmd+A → Delete ×2 → Esc ×3（Esc 很关键，残留选择会让下一次拖拽变框选）",
        "setZoom(100): 清屏会触发 fit 到十几 %，必须重置",
        "armBrush(): 真实鼠标点左栏「画笔」，校验背景 rgba(57,70,96,.14)",
        "setBrushStyle({thickness: 24, opacity: 100})",
        "逐层: setBrushColor(layer.hex) → closePopovers → armBrush → cu_cdp_paint(paceMs≈5)",
        "用 planLayerToRegionStrokes() 按连通区域蛇形合并，元素数控制在 2000 上限内",
        "跳过近白层（#fcf5f5/#f1e3e2 在白底不可见）；每层做 +sy/2 第二遍补缝",
      ],
    },
    prohibited: PROHIBITED_DELIVERY_PATHS,
    routes: [
      {
        id: "freehandCdp",
        when: DRAW_INTENT,
        prefer: true,
        why: "用户要的是用 computer use 在 Canva 里把图画出来，不是让画布里出现一张图。落笔必须发生在目标页面：CDP Input.dispatchMouseEvent 驱动页面画笔，逐层换色是可观测、可核验的真实操作。",
        steps: [
          "cu_paint_plan → 读 flows.drawImage 与 prohibited",
          "lib/canva-brush.mjs: clearCanvas / setZoom(100) / armBrush / setBrushStyle / 逐层 setBrushColor + armBrush",
          "lib/cdp.mjs 的 planLayerToRegionStrokes() 把每层按连通区域蛇形合并（实测 3321 runs → 350 元素，避开 2000 上限）",
          "逐层 cu_cdp_paint 落笔；每层 +sy/2 补缝，跳过近白层",
          "cu_screenshot 对比 plan 预览校验构图；保留笔画数与工具调用记录作为过程证据",
        ],
        tools: ["cu_paint_plan", "cu_cdp_paint", "cu_discover", "cu_screenshot"],
        cost: { roundTrips: 8, needsForeground: false, focusRisk: false, elements: 350, level: "medium",
                note: "每种颜色需开颜色面板 + 重新 armBrush；用连通区域合并而非逐 run 落元素" },
        avoid: [
          "严禁离屏渲染 PNG 后上传/拖入/粘贴：那不是 computer use，是图片搬运",
          "不要对网页 canvas 用 cu_paint（CGEvent 会被渲染循环丢弃）",
          "逐条 run 一个元素会超 2000 上限；用 planLayerToRegionStrokes 按连通区域合并",
          "Cmd+Z 进不了 Canva 撤销栈，重画只能全选删除",
          "绝不能 Page.reload 编辑器：会掉到模板/落地页并丢失画布",
        ],
        preflight: ["启动 owned debug Chrome（launch:true），不要 attach 日常浏览器", "缩放必须 100%", "粗细致少为网格 cell 的 2 倍"],
        acceptance: DRAWING_ACCEPTANCE,
        verifiedAt: "2026-11-08",
        source: "docs/2026-11-08-computer-use-playbook.md 第二、六节 Canva 实测 + 用户过程真实性裁决",
      },
    ],
    pitfalls: [
      "分层覆盖法（关键）：不要一条横线一个元素——把每层按连通区域串成蛇形连续笔迹。实测 3321 runs 从 6642 个元素降到 350 个，远低于上限。planLayerToRegionStrokes() 已实现。",
      "白板有 2000 个素材上限（实测 3321 runs × 2 pass 会触发「超出 2,000 个素材」，无法保存）；必须控制在 ~1500 笔以内，用连通区域合并解决，不得改走上传",
      "Cmd+Z 通过 CDP 键盘事件进不了 Canva 撤销栈，重画只能全选删除",
      "换颜色后面板会关闭且工具可能回到「选择」，落笔前必须再 armBrush",
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
        "cu_windows 找 Freeform 窗口 → cu_session start",
        "点击 AXCheckBox 'Drawing Tools' 打开绘图条",
        "选择笔宽与笔型（Monoline + Medium）",
        "osascript 'tell application \"Freeform\" to activate' 把窗口带到前台（关键！）",
        "cu_paint_plan 生成分层计划",
        "每种颜色：前台点 Choose a color → Show Colors… → 填 hex → 关闭面板 → 重新点 Drawing tool → cu_paint 落笔",
        "Medium 笔宽（约 4px）配 grid 180（cell≈4px）；每层 +sy/2 补缝消除横纹",
        "cu_screenshot 校验；保留笔画数作为过程证据",
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
          "cu_paint_plan → 读 flows.drawImage 与 prohibited",
          "osascript -e 'tell application \"Freeform\" to activate'（不在前台则 hid-events 不落笔）",
          "先在 ONE 笔画上验证闭环：设色 → 重新 arm Drawing tool → cu_paint → 截图确认颜色与落笔都生效",
          "逐层：设 hex → 关闭 Colors 面板 → 重新点 Drawing tool → cu_paint 该层（换色后工具会跳回「选择」，漏了就不落笔）",
          "Medium 笔宽 + grid 180；每层 +sy/2 第二遍补缝消除横纹；跳过近白层",
          "cu_screenshot 对比 plan 预览校验构图；保留笔画数与 cu_paint 调用记录作为过程证据",
        ],
        tools: ["cu_paint_plan", "cu_paint", "cu_discover", "cu_screenshot"],
        cost: { roundTrips: 16, needsForeground: true, focusRisk: true, elements: 3177, level: "high",
                note: "16 层 × (开面板/填 hex/关面板/重新 arm/落笔/验证)；这是真实操作的必要代价，不是待优化的浪费" },
        avoid: [
          "严禁离屏渲染 PNG 后粘贴（Cmd+V）/上传/拖入 Freeform：这是投机取巧，用户已判定错误",
          "不要假设换色后画笔仍激活：Freeform 换色会让工具跳回「选择」，落笔前必须重新点 Drawing tool",
          "Colors 是独立 axOnly 窗口（windowId 0），cu_snapshot 读不到，后台 AXPress 对颜色按钮也不生效，需前台真实点击 + osascript 定位",
          "不要用 planLayerToRegionStrokes 折线合并：跨行连接线会拉出大量长斜线（仅适用于网页 canvas）",
          "不要拿「画笔有横纹」当借口改走上传：横纹要用笔宽与补缝工艺解决",
        ],
        preflight: [
          "osascript -e 'tell application \"Freeform\" to activate'（不在前台则 hid-events 不落笔）",
          "粘贴/上传类路径已在 prohibited 中禁用；本任务只允许 cu_paint 落笔",
          "换色流程先在一笔上验证闭环再批量",
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
      "跳过近白层（如 #f3e8e9）否则整片涂黑；单色时只画中暗层，白纸自然当高光",
      "换色后工具跳回「选择」：Colors 面板关闭后必须重新点 Drawing tool（底部绘图条），否则下一层不落笔",
      "Colors 面板是 axOnly 窗口（windowId 0），不在普通窗口列表里；用 osascript 读它的位置/关闭按钮",
      "逐扫描线画笔会留横向条纹：用 Medium 笔宽（≈2× cell）与 +sy/2 第二遍补缝解决，这是画笔工艺问题，不是改走上传的理由",
      "离屏渲染再粘贴/上传属于过程造假，用户 2026-11-08 明确判定为错误；交付必须由 cu_paint 在 Freeform 内落笔",
    ],
  },
  {
    id: "web-canvas-generic",
    match: /.*/,
    native: false,
    title: "通用网页 Canvas",
    summary: "网页画布通常只接受 CDP Input.dispatchMouseEvent；CGEvent/pid 事件会被渲染循环丢弃。",
    controls: [],
    flows: {
      drawImage: ["先用 cu_discover 枚举 [aria-label]、button、input[type=range]、canvas；再决定用 DOM 控件还是坐标注入"],
    },
    prohibited: PROHIBITED_DELIVERY_PATHS,
    routes: [
      {
        id: "discoverFirst",
        when: { keywords: ["画", "绘制", "操作", "编辑", "draw", "edit", "automate"], boost: [], summary: "未知网页应用，先做能力发现" },
        prefer: true,
        why: "没有验证过的控件地图时，任何点击都是猜；先枚举 DOM 再决定通道。",
        steps: ["cu_discover({urlMatch})", "读 controls / playbook.pitfalls / prohibited", "有 input[type=range] 优先用原生 setter", "坐标注入前确认 zoom 100%", "落笔必须用 cu_cdp_paint 注入目标页面"],
        tools: ["cu_discover", "cu_cdp_paint", "cu_screenshot"],
        cost: { roundTrips: 3, needsForeground: false, focusRisk: false, elements: 0, level: "low", note: "探测是只读的" },
        avoid: ["不要对网页 canvas 用 cu_paint（CGEvent 会被渲染循环丢弃）", "严禁离屏渲染 PNG 后上传"],
        preflight: ["owned debug Chrome"],
        acceptance: DRAWING_ACCEPTANCE,
        verifiedAt: "2026-11-08",
        source: "docs/2026-11-08-computer-use-playbook.md 第一节",
      },
    ],
    pitfalls: ["不要假设页面没有控件；先 discover 再操作", "交付必须由目标页面内的笔画构成，不得用外部图片代替"],
  },
];

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
  "先 cu_route 查这类任务的推荐路线再动笔；确定性规则表比临场试错快得多。",
  "过程真实性是硬边界：必须在目标 app 内用 cu_paint / cu_cdp_paint 落笔；离屏渲染再上传/粘贴是过程造假，禁止。",
  "换色/换工具后先在一笔上验证闭环（动作 → 截图 → 确认生效），再批量；截图只作校验，不是交付证明。",
];

const GENERIC_METHOD = [
  "cu_status：确认 vision.supported / targets / pause 状态",
  "cu_windows → cu_session start 锁定目标",
  "cu_discover（web 用 urlMatch，native 用 pid/windowId）读控件与 playbook",
  "用最小闭环验证一步：动作 → expect / 截图 → 确认生效",
  "确认无误后再用 cu_batch 批量执行，避免把错误放大 N 倍",
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
 * plus the generic methodology. `prohibited` is ALWAYS returned so a shortcut
 * can never be justified by "the router didn't mention it".
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
