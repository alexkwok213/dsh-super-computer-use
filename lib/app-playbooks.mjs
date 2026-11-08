// App playbooks — the "capability router".
//
// The hard part of computer use is not clicking; it is knowing what an
// application can do, which tool channel reaches it, and which route is worth
// taking for the task at hand. A blind agent with perfect mouse control still
// cannot draw in a whiteboard if it does not know the brush has separate
// thickness/opacity/colour controls — or that placing a rendered PNG is cheaper
// and more faithful than 16 colour passes with a freehand brush.
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
  cu_screenshot:    { channel: "capture", note: "needs Screen Recording; returns origin+scale for coordinate mapping" },
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
  cu_paint_plan:    { channel: "offline", note: "compile reference image into layered horizontal runs" },
  cu_paint:         { channel: "native", needsForeground: true, focusRisk: true,
                      note: "CGEvent strokes for NATIVE apps; the app must be frontmost, else nothing lands" },
  cu_cdp_paint:     { channel: "cdp",    note: "Input.dispatchMouseEvent for WEB canvases; requires an owned debug Chrome" },
};

/** Intent keywords are kept short and literal so routing stays testable. */
const DRAW_EXACT = {
  keywords: ["画", "绘制", "还原", "复制", "临摹", "参考图", "draw", "reproduce", "copy", "image"],
  boost: ["像素", "精确", "忠实", "一样", "这幅图", "清晰", "pixel", "exact", "faithful", "crisp"],
  // A request for visible brush strokes is a different deliverable: never
  // recommend the pixel-exact PNG route for it.
  exclude: ["手绘", "笔触", "用画笔", "画笔描", "hand-drawn", "hand drawn", "brush strokes"],
  summary: "用户要把一张参考图准确搬到画布上（像素级还原）",
};

const DRAW_HAND = {
  keywords: ["手绘", "笔触", "笔画", "用画笔", "画笔画", "brush", "hand-drawn", "strokes"],
  boost: ["画笔", "手绘", "笔触", "brush"],
  summary: "用户明确要求手绘笔触 / 用画笔逐笔描",
};

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
        "逐层: setBrushColor(layer.hex) → closePopovers → armBrush → paintStrokes(paceMs≈5)",
        "跳过近白层（#fcf5f5/#f1e3e2 在白底不可见）；需要更实时对每层做 +sy/2 的第二遍补缝",
      ],
      exactCopy: [
        "若目标是像素级精确，改走：cu_paint_plan → scripts/plan-to-png.py 光栅化 PNG → 上传并放置到画布（结果只有 1 个元素，不会碰 2000 上限）",
        "自由笔刷路线受圆头软边、5px 网格和 2000 元素上限三重限制，只能做小尺寸近似图；像素级必须走 PNG 路径",
      ],
    },
    routes: [
      {
        id: "exactCopy",
        when: DRAW_EXACT,
        prefer: true,
        why: "离线渲染是确定性的、逐像素一致，且只产生 1 个画布元素；画笔路线受圆头软边、网格与 2000 元素上限三重限制。",
        steps: [
          "node scripts/draw-image.mjs --image <ref.png> --url <design-url>（内部：drawplan → plan-to-png.py → CDP 上传并点缩略图放置）",
          "cu_screenshot 对比 plan 预览；若不像，检查缩放是否为 100% 与缩略图宽高比",
        ],
        tools: ["cu_paint_plan", "scripts/plan-to-png.py", "scripts/draw-image.mjs", "cu_screenshot"],
        cost: { roundTrips: 1, needsForeground: false, focusRisk: false, elements: 1, level: "low",
                note: "一条命令完成；不需要逐层换色、不需要 armBrush" },
        avoid: ["不要用自由笔刷做像素级复制：默认 36px 圆头 + 50% 不透明度会糊成块", "不要 Page.reload 编辑器"],
        preflight: ["启动 owned debug Chrome（launch:true），不要 attach 日常浏览器", "确认 vision.supported"],
        verifiedAt: "2026-11-08",
        source: "docs/2026-11-08-computer-use-playbook.md 第二、五节 Canva 实测",
      },
      {
        id: "handDrawn",
        when: DRAW_HAND,
        why: "只在用户明确要手绘笔触时使用；逐层描线能满足笔迹质感，但无法逐像素还原。",
        steps: [
          "cu_paint_plan → 读 flows.drawImage",
          "lib/canva-brush.mjs: clearCanvas / setZoom(100) / armBrush / setBrushStyle / 逐层 setBrushColor + armBrush",
          "每层 +sy/2 补缝，跳过近白层；cu_screenshot 验证",
        ],
        tools: ["cu_paint_plan", "cu_cdp_paint", "cu_discover", "cu_screenshot"],
        cost: { roundTrips: 16, needsForeground: false, focusRisk: false, elements: 350, level: "high",
                note: "每种颜色都要开颜色面板、重新 armBrush、验证；受 2000 元素上限约束" },
        avoid: ["逐条 run 一个元素会超 2000 上限；用 planLayerToRegionStrokes 按连通区域合并", "Cmd+Z 进不了 Canva 撤销栈"],
        preflight: ["缩放必须 100%", "粗细致少为网格 cell 的 2 倍"],
        verifiedAt: "2026-11-08",
        source: "docs/2026-11-08-computer-use-playbook.md 第二、六节",
      },
    ],
    pitfalls: [
      "分层覆盖法（关键）：不要一条横线一个元素——把每层按连通区域串成蛇形连续笔迹，一层只需几十个元素。实测 3321 runs 从 6642 个元素降到 350 个，远低于上限。planLayerToRegionStrokes() 已实现。",
      "白板有 2000 个素材上限（实测 3321 runs × 2 pass 会触发「超出 2,000 个素材」，无法保存）；逐笔细画必须控制在 ~1500 笔以内，否则改走 plan→PNG→上传（1 个元素）",
      "Cmd+Z 通过 CDP 键盘事件进不了 Canva 撤销栈，重画只能全选删除",
      "换颜色后面板会关闭且工具可能回到「选择」，落笔前必须再 armBrush",
      "换色不会重置粗细（已验证 25 保持 25）",
      "绝不能 Page.reload 编辑器：会掉到模板/落地页并丢失画布",
      "上传面板里是账号历史素材，点击缩略图容易点错：用 img.naturalWidth/naturalHeight 的宽高比区分目标（本次像素版 1900x1680≈1.131，原图 1080x1080=1.0），或上传后按 DOM 中最后一张 img 定位",
      "打开颜色/设置浮层时不要点画布，否则会把浮层点掉或误画",
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
        "选择笔宽（Extra-fine）与笔型（Pen）",
        "osascript 'tell application \"Freeform\" to activate' 把窗口带到前台（关键！）",
        "逐扫描线绘制：planLayerToStrokes() 每行一条水平线，全部合并成一个 strokes 文件，一次 cu strokes 调用（实测 1,466 笔 / 5,864 点 / 16 秒）",
        "用 Medium 笔宽（约 4px）配 grid 180（cell≈3.9px）刚好填满行距；Extra-fine 会留白缝",
        "截图验证",
      ],
    },
    routes: [
      {
        id: "exactCopy",
        when: DRAW_EXACT,
        prefer: true,
        why: "一次粘贴就是逐像素一致、零错色、零横纹；Freeform 的画笔是圆头软边，逐扫描线必然留下横向条纹，且 16 色意味着 16 次开/关颜色面板与重新 arm。",
        steps: [
          "node scripts/draw-image.mjs --image <ref.png> --target freeform（内部：drawplan → plan-to-png.py --local --transparent → 剪贴板 PNG → Cmd+V）",
          "点画布空白取消选择，cu_screenshot 对比 plan 预览",
        ],
        tools: ["cu_paint_plan", "scripts/plan-to-png.py", "scripts/draw-image.mjs", "cu_screenshot"],
        cost: { roundTrips: 1, needsForeground: true, focusRisk: true, elements: 1, level: "low",
                note: "1 次粘贴；不换色、不 arm、无横纹" },
        avoid: [
          "不要用 16 色逐扫描线画笔做像素级复制：圆头笔必然留横向条纹，Extra-heavy 还会盖住相邻行糊掉五官",
          "不要假设换色后画笔仍激活：Freeform 换色会让工具跳回「选择」，落笔前必须重新点 Drawing tool",
          "Colors 是独立 axOnly 窗口（windowId 0），cu_snapshot 读不到，后台 AXPress 对颜色按钮也不生效，需前台真实点击 + osascript 定位",
        ],
        preflight: [
          "osascript -e 'tell application \"Freeform\" to activate'（不在前台则 hid-events 不落笔）",
          "PNG 必须透明背景且用局部坐标渲染（--local --transparent），否则会带白底方块和偏移空白",
          "粘贴前 Cmd+A → Delete 清空画布",
        ],
        verifiedAt: "2026-11-08",
        source: "本轮 Freeform 大肥鱼任务实测：16 色画笔版有横纹与错色，plan→PNG→粘贴版逐像素一致",
      },
      {
        id: "handDrawn",
        when: DRAW_HAND,
        why: "只在明确要手绘笔迹时使用；Freeform 没有元素上限，可以逐扫描线一次画完。",
        steps: [
          "cu_paint_plan → flows.drawImage",
          "每种颜色：前台点 Choose a color → Show Colors… → 填 hex → 关闭面板 → 重新点 Drawing tool → cu_paint 该层",
          "Medium 笔宽 + grid 180；cu_screenshot 验证",
        ],
        tools: ["cu_paint_plan", "cu_paint", "cu_discover", "cu_screenshot"],
        cost: { roundTrips: 16, needsForeground: true, focusRisk: true, elements: 3177, level: "high",
                note: "16 层 × (开面板/填 hex/关面板/重新 arm/验证)；扫描线留横纹" },
        avoid: ["不要用 planLayerToRegionStrokes 折线合并：跨行连接线会拉出大量长斜线", "不要漏掉换色后的重新 arm，否则画到画布外或不落笔"],
        preflight: ["Freeform 必须前台", "换色流程先在一笔上验证闭环再批量"],
        verifiedAt: "2026-11-08",
        source: "docs/2026-11-08-computer-use-playbook.md 第七节 + 本轮回填",
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
      "逐扫描线画笔必留横向条纹，这是圆头笔的物理上限；像素级还原应走 plan→PNG→粘贴",
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
    routes: [
      {
        id: "discoverFirst",
        when: { keywords: ["画", "绘制", "操作", "编辑", "draw", "edit", "automate"], boost: [], summary: "未知网页应用，先做能力发现" },
        prefer: true,
        why: "没有验证过的控件地图时，任何点击都是猜；先枚举 DOM 再决定通道。",
        steps: ["cu_discover({urlMatch})", "读 controls / playbook.pitfalls", "有 input[type=range] 优先用原生 setter", "坐标注入前确认 zoom 100%"],
        tools: ["cu_discover", "cu_cdp_paint", "cu_screenshot"],
        cost: { roundTrips: 3, needsForeground: false, focusRisk: false, elements: 0, level: "low", note: "探测是只读的" },
        avoid: ["不要对网页 canvas 用 cu_paint（CGEvent 会被渲染循环丢弃）"],
        preflight: ["owned debug Chrome"],
        verifiedAt: "2026-11-08",
        source: "docs/2026-11-08-computer-use-playbook.md 第一节",
      },
    ],
    pitfalls: ["不要假设页面没有控件；先 discover 再操作"],
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
  "像素级还原优先 plan→PNG→放置（1 次调用）；画笔逐扫描线会留横纹且需逐层换色。",
  "换色/换工具后先在一笔上验证闭环（动作 → 截图 → 确认生效），再批量，别把错误放大 N 倍。",
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
  // An explicit exclusion wins over any keyword overlap, so "用画笔画" can
  // never be routed to the pixel-exact path even though it contains "画".
  for (const kw of route.when.exclude ?? []) if (intent.includes(kw)) return -1;
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
 * plus the generic methodology.
 */
export function routeFor({ intent = "", appName = "", windowTitle = "", url = "", playbook = null } = {}) {
  const pb = playbook ?? detectTargetPlaybook({ url, title: windowTitle, appName });
  const app = pb && pb.id !== "web-canvas-generic" ? pb.id : (appName || url || null);
  const goal = String(intent || "").trim();
  const routes = pb?.routes ?? [];
  const base = {
    goal,
    app,
    playbook: playbookSummary(pb),
    channels: usedChannels(routes),
  };
  // No intent, no verified app playbook, or no routes at all: say so plainly
  // instead of inventing a plan. The generic methodology is still returned.
  const isGeneric = !pb || pb.id === "web-canvas-generic";
  if (!goal || isGeneric || !routes.length) {
    return {
      ...base,
      recommended: null,
      alternatives: isGeneric ? routes.map(publicRoute) : [],
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
             preflight: GENERIC_METHOD, noRoute: true, fallback: GENERIC_METHOD };
  }
  return {
    ...base,
    recommended: { ...publicRoute(top.route), matchScore: top.score },
    alternatives: ranked.slice(1).map((x) => ({ ...publicRoute(x.route), matchScore: x.score })),
    preflight: top.route.preflight ?? GENERIC_METHOD,
    noRoute: false,
  };
}
