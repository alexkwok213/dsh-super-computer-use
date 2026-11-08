// App playbooks — the "capability router".
//
// The hard part of computer use is not clicking; it is knowing what an
// application can do and where its controls live. A blind agent with perfect
// mouse control still cannot draw in a whiteboard if it does not know the
// brush has separate thickness/opacity/colour controls.
//
// This module keeps verified capability maps per application. `cu_discover`
// matches the live window/page against these signatures and returns the
// relevant playbook together with a live enumeration of the controls it can
// see, so the caller starts from "what exists here" instead of guessing.
//
// Keep entries factual: only record controls that were verified by actually
// driving them. Add new apps as they are learned.

export const PLAYBOOKS = [
  {
    id: "canva-whiteboard",
    match: /canva\.com\/design\//i,
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
    pitfalls: [
      "Freeform 不在前台时 hid-events 不落笔（实测第一次全无反应，activate 后成功）",
      "画笔浮层（Choose a drawing tool）打开时会挡住颜色按钮，先 Escape 关闭",
      "Fill 工具可填充闭合区域，比逐笔刷更快",
      "不要用 planLayerToRegionStrokes 的折线合并法：跨行连接线会在画面里拉出大量长斜线，看起来像草稿（实测被用户指正）",
      "跳过近白层（如 #f3e8e9）否则整片涂黑；单色时只画中暗层，白纸自然当高光",
    ],
  },
  {
    id: "web-canvas-generic",
    match: /.*/,
    title: "通用网页 Canvas",
    summary: "网页画布通常只接受 CDP Input.dispatchMouseEvent；CGEvent/pid 事件会被渲染循环丢弃。",
    controls: [],
    flows: {
      drawImage: ["先用 cu_discover 枚举 [aria-label]、button、input[type=range]、canvas；再决定用 DOM 控件还是坐标注入"],
    },
    pitfalls: ["不要假设页面没有控件；先 discover 再操作"],
  },
];

/** Match a URL (and optional page title) to a playbook. */
export function detectPlaybook(url = "", title = "") {
  const text = `${url} ${title}`;
  for (const pb of PLAYBOOKS) {
    if (pb.id === "web-canvas-generic") continue;
    if (pb.match.test(text)) return pb;
  }
  return PLAYBOOKS.find((p) => p.id === "web-canvas-generic") ?? null;
}

/** Match a native application name (window title / app name) to a playbook. */
export function detectNativePlaybook(appName = "", title = "") {
  const text = `${appName} ${title}`;
  return PLAYBOOKS.find((pb) => pb.id === "apple-freeform" && pb.match.test(text)) ?? null;
}

/** Compact playbook for tool output (drops the regex). */
export function playbookSummary(pb) {
  if (!pb) return null;
  return {
    id: pb.id,
    title: pb.title,
    summary: pb.summary,
    controls: pb.controls,
    flows: pb.flows,
    pitfalls: pb.pitfalls,
  };
}
