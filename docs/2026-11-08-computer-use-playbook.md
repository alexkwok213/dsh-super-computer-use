# Computer Use 经验手册：从"会点"到"会做"

日期：2026-11-08
适用：`dsh-super-computer-use` 插件 v0.13.x

## 一句话结论

**Computer use 的瓶颈从来不是"能不能点"，而是"知不知道这个应用有什么可点"。**
工具能精准落点，但如果不知道 Canva 的画笔有一个藏在「设置」里的「粗细」滑块，再好的手也只能画出一团粗块。

所以先做**能力发现（discover）**，再做操作（operate）。这就是 `cu_discover` 和 `lib/app-playbooks.mjs` 存在的理由。

---

## 一、通用方法论（按顺序）

### 1. 探测（Discover）

| 目标类型 | 怎么探 |
|---|---|
| **网页应用**（Canva / Figma / 在线工具） | `cu_discover({urlMatch})` → 返回所有 `aria-label` 控件、`input`（含 type/min/max/value）、大画布表面、命中的 playbook |
| **原生 App**（Finder / 剪映 / 备忘录） | `cu_snapshot` → AX 树；`cu_find(mode:"ocr")` 找可见文字 |
| **未知窗口** | `cu_windows` → 拿 windowId/pid → 再 snapshot/截图 |

**关键**：网页的 AX 树通常只到 Chrome 外壳（实测只有 49 个节点，全是浏览器 UI），页面内控件必须**读 DOM**，不能靠 `cu_click_text`。

### 2. 建图（Map）

把发现结果按类分组：
- 轨道工具（左/上工具栏）
- 浮层面板（设置、颜色、图层）
- 输入控件（`input[type=range|text]`、`contenteditable`）
- 画布表面（`canvas`、大尺寸可拖拽 div）

**有 `input[type=range]` 就优先用它**——比拖滑块准得多（原生 setter + `input`/`change` 事件）。

### 3. 操作（Operate）

- **DOM 控件** → 读 `getBoundingClientRect()` 拿坐标，用 **CDP `Input.dispatchMouseEvent`** 点，或用原生 setter 直接改值
- **画布落笔** → CDP `mousePressed → mouseMoved… → mouseReleased`（Codex 同款）
- **原生 App** → `cu_click(ref)` / `cu_type(ref)` / `cu_drag`

### 4. 校验（Verify）

每次操作后**必须截图看**：
- `cu_screenshot({region})` 局部放大（2× / 1.5×）比全屏截图有用得多
- 读 DOM 状态回读（如色块 `aria-label`、滑块 `value`）

---

## 二、Canva 白板案例（完整复盘）

### 走过的弯路（都是真实发生的）

| 尝试 | 结果 | 教训 |
|---|---|---|
| `cu_paint`（CGEvent 原生指针） | 画不上 | 浏览器 Canvas 过滤 CGEvent |
| CDP 直连日常 Chrome | 每次弹「Allow remote debugging」 | Chrome 144+ 对 attach 日常浏览器每次征询 |
| 盲点截图坐标点画笔图标 | 反复点错、工具在"选择/画笔"间乱切 | 必须读 DOM 找 `aria-label` |
| 直接画整张图 | 糊成黑块 | 默认笔刷 36px + 不透明度 50% |
| 用 `Page.reload` 重置 | 掉到模板落地页，画布丢失 | 重画只能全选删除 |
| Cmd+Z 撤销 | 无效 | CDP 键盘事件进不了 Canva 撤销栈 |

### 最终的可用控制（已固化为 `lib/canva-brush.mjs`）

```
画笔按钮   [aria-label='画笔']        激活态背景 rgba(57,70,96,.14)
颜色按钮   [aria-label='颜色']        打开调色板
添加新颜色 [aria-label='添加新颜色']  再出现 hex 文本框
设置按钮   [aria-label='设置']        打开「粗细」+「不透明度」两个 range
缩放选项   [aria-label='缩放选项']    画布坐标只在 100% 对齐
```

### 绘制配方

```
1. cu drawplan --grid 140~200 --colors 8~10     # 分层笔画计划
2. clearCanvas()   全选删×2 + Esc×3（Esc 关键：残留选择会让拖拽变框选）
3. setZoom(100)    清屏会 fit 到 ~15%，必须重置
4. armBrush()      真实鼠标点画笔 + 校验背景（JS .click() 会切回"选择"）
5. setBrushStyle({thickness:24, opacity:100})
6. 逐层: setBrushColor(hex) → closePopovers → armBrush → paintStrokes(paceMs 5)
7. 每层再画一遍 y+半格 的偏移，补横向白缝
8. 跳过接近白色的层（白底不可见）
```

### 像素级 vs 笔刷级

- **笔刷级**（本项目实测）：块状多色，受圆头软边 + 网格限制，肉眼可辨但非逐像素一致。
- **像素级**：走 `cu drawplan` → `scripts/plan-to-png.py` 光栅化 → 上传放置到画布（离线渲染，像素精确）。

---

## 三、把经验变成能力（插件改进）

| 改进 | 文件 | 作用 |
|---|---|---|
| `cu_discover` 工具 | `lib/index.mjs` | 一次调用枚举页面所有可控元素 + 命中 playbook |
| `app-playbooks.mjs` | `lib/app-playbooks.mjs` | 已验证的 App 能力地图（Canva 白板 + 通用 Canvas） |
| `canva-brush.mjs` | `lib/canva-brush.mjs` | 白板画笔的确定性控制（笔刷/颜色/缩放/清屏） |
| `plan-to-png.py` | `scripts/plan-to-png.py` | 计划 → 像素级 PNG |
| `draw-image.mjs` | `scripts/draw-image.mjs` | 一键 编译→PNG→放入画布 |
| `lastRoute` 修复 | `lib/index.mjs` | `cu_status` 真实记录视觉投递路径 |

### 新增 App 的正确姿势

1. 用 `cu_discover` 枚举控件
2. 逐个试验（改一个值 → 截图确认）
3. 把验证过的控件写进 `lib/app-playbooks.mjs` 的 `controls` / `flows` / `pitfalls`
4. 加一条 `test/app_playbooks.mjs` 断言

---

## 四、给下一个 AI 的检查清单

- [ ] 先 `cu_status`：确认 vision 支持 + 目标列表
- [ ] 先 `cu_discover`：知道这个 App 有什么
- [ ] 读 playbook 的 pitfalls，别重踩
- [ ] 每步用 `cu_screenshot({region})` 放大验证
- [ ] 不要 `Page.reload` 编辑器
- [ ] 不要假设能撤销；准备"全选删除重画"
- [ ] 落笔前确认工具真的激活（读状态，不靠猜）
