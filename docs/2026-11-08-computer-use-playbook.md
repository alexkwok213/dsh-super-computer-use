# Computer Use 经验手册：从"会点"到"会做"

日期：2026-11-08
适用：`dsh-super-computer-use` 插件 v0.13.x

## 一句话结论

**Computer use 的瓶颈从来不是"能不能点"，而是"知不知道这个应用有什么可点、以及这类任务该走哪条路"。**
工具能精准落点，但如果不知道 Canva 的画笔有一个藏在「设置」里的「粗细」滑块，再好的手也只能画出一团粗块；如果不知道像素级还原应该走 `plan→PNG→粘贴`，就会用 16 色画笔反复换色、画出一堆横纹。

所以顺序是 **路由（route）→ 能力发现（discover）→ 最小闭环验证 → 操作（operate）**。
这就是 `cu_route`、`cu_discover`、`lib/app-playbooks.mjs` 里的 `routes` 字段，以及工具返回值里的 `guidance` 存在的理由：**知识必须在执行的那一刻被推到模型眼前，而不是躺在一份需要模型记得去读的文档里**。

---

## 一、通用方法论（按顺序）

### 0. 路由（Route）— 新增，且必须最先做

`cu_route({intent, appName|url|pid|windowId})` 是确定性的意图→路线查表（无 LLM、无 I/O、可单测）。返回：

- `recommended`：`why / steps / tools / cost / avoid / preflight`
- `alternatives`：其余路线，可按 `cost.roundTrips` 比价
- `playbook`：命中的能力图（含 `routes` / `flows` / `pitfalls`）
- `noRoute:true` + `fallback`：未命中已知 app 时**明确说没命中**，不编造计划

**读 `recommended.avoid` 再动手**。本次 Freeform 任务的关键错误就是跳过了这一步：把「画一幅参考图」直接翻译成「16 色逐扫描线画笔」，而正确路线是一次粘贴。

### 1. 探测（Discover）

| 目标类型 | 怎么探 |
|---|---|
| **网页应用**（Canva / Figma / 在线工具） | `cu_discover({urlMatch})` → 返回所有 `aria-label` 控件、`input`（含 type/min/max/value）、大画布表面、命中的 playbook |
| **原生 App**（Freeform / Finder / 剪映 / 备忘录） | `cu_discover({appName, pid, windowId})` → **AX 树 + 命中的原生 playbook**，不需要 Chrome；补充用 `cu_find(mode:"ocr")` 找可见文字 |
| **未知窗口** | `cu_windows` → 拿 windowId/pid → 再 discover/snapshot/截图 |

> 2026-11-08 之前 `cu_discover` 只支持 CDP/网页，而 `detectNativePlaybook` 定义了却从未被生产代码调用——Freeform 的 playbook 是「测试通过但运行时拿不到」的死知识。这是本次翻车的根因之一。
>
> 还有更硬的一层：`cu_discover` 的 `output` 只声明了 JSON schema、**没有 `render` 函数**，真实宿主一调用就报 `userRender is not a function`。单元测试直接调 `execute()` 发现不了，只有端到端跑才会暴露——所以这个工具当时等于不存在。已补 `renderWithOptionalImage()`，并在 `test/tool_schema.mjs` 加了「每个工具必须有可用 renderer」的回归断言。**能力 discover 不可用，是「先 discover 再操作」这条原则写了却做不到的直接原因。**

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
| `cu_route` 工具 | `lib/index.mjs` | 确定性意图→路线查表，动手前先给出「该走哪条路、代价、坑」 |
| `routes` + `TOOL_CHANNELS` | `lib/app-playbooks.mjs` | 决策规则表与 20 个工具的通道/代价模型，`verifiedAt` + `source` 可追溯 |
| `cu_discover` 双通道 | `lib/index.mjs` | 网页走 CDP DOM；原生 App 走 AX 树，**不需要 Chrome** |
| `guidance` 注入 | `lib/index.mjs` register 包装 | 每次操作工具返回时把路线/坑推进模型上下文（push 而非 pull） |
| `activeAppPlaybook` | `lib/index.mjs` | `cu_status` / `cu_windows` 直接告诉你前台是不是已知 app |
| `app-playbooks.mjs` | `lib/app-playbooks.mjs` | 已验证的 App 能力地图（Canva / Freeform / 通用 Canvas） |
| `canva-brush.mjs` | `lib/canva-brush.mjs` | 白板画笔的确定性控制（笔刷/颜色/缩放/清屏） |
| `plan-to-png.py` | `scripts/plan-to-png.py` | 计划 → 像素级 PNG；`--local --transparent` 产出可粘贴的透明图 |
| `draw-image.mjs` | `scripts/draw-image.mjs` | 一键 编译→PNG→放入画布；`--target freeform` 走剪贴板粘贴，无需 Chrome |
| `lastRoute` 修复 | `lib/index.mjs` | `cu_status` 真实记录视觉投递路径 |

### 新增 App / 新踩坑的正确姿势

1. 用 `cu_discover` 枚举控件（网页用 `urlMatch`，原生用 `appName` / `pid`）
2. 逐个试验（改一个值 → 截图确认）
3. 把验证过的控件写进 `controls` / `flows` / `pitfalls`
4. 把「什么意图该选哪条路」写成 `routes`，**必填 `verifiedAt` + `source`**，并填 `cost` 以便比价
5. 加 `test/app_playbooks.mjs` 与 `test/strategy_router.mjs` 断言

经验必须有固定落点，否则下一轮又会重新踩一遍。

---

## 四、给下一个 AI 的检查清单

- [ ] 先 `cu_route`：读 `recommended.avoid`，别自己猜路线
- [ ] 先 `cu_status`：确认 vision 支持 + 目标列表 + `activeAppPlaybook`
- [ ] 先 `cu_discover`：知道这个 App 有什么（原生 App 用 `appName`/`pid`）
- [ ] 读 playbook 的 `routes` / `pitfalls`，别重踩
- [ ] 先跑一笔最小闭环（动作 → expect/截图 → 确认生效）再批量
- [ ] 每步用 `cu_screenshot({region})` 放大验证
- [ ] 不要 `Page.reload` 编辑器
- [ ] 不要假设能撤销；准备"全选删除重画"
- [ ] 落笔前确认工具真的激活（读状态，不靠猜）
- [ ] 原生 App 落笔前 `activate` 到前台

---

## 五、把 PNG 放进 Canva（像素级路线的最后一公里）

`drawplan → plan-to-png.py` 生成 PNG 后，如何可靠地放进画布：

1. 打开左侧「上传」面板（`[aria-label='上传']`），等 `input[type=file]` 出现；
2. `DOM.setFileInputFiles(nodeId, [png])` 上传——这是唯一稳定的上传入口（点「上传文件」会弹系统对话框，反而难控）；
3. 上传后面板出现新缩略图。**不要盲点**：面板里混着账号历史素材。用 `img.naturalWidth / naturalHeight` 的宽高比区分——
   - 本次像素版 1900×1680 ≈ **1.131**
   - 原图 1080×1080 = **1.0**
4. 点中目标缩略图 → 作为**单个图片元素**落到画布（不占 2000 素材额度）；
5. 校验：`document.querySelectorAll('img')` 中大于 300px 的那张，`naturalWidth/naturalHeight` 应与目标一致（Canva 会等比缩放，宽高比不变），并读 `已保存所有更改` 确认落盘。

---

## 六、突破 2000 元素上限：分层覆盖法（用户提出的关键思路）

**问题**：按"一条横线一个元素"画，3321 条 run × 2 遍 = 6642 个元素，触发白板 2000 上限。

**解法**：像画家一样——**每个颜色层是一笔连续笔迹，而不是几千个点**。

实现（`lib/cdp.mjs`）：

| 函数 | 做法 | 元素数 |
|---|---|---|
| `planLayerToSerpentine` | 整层所有横条按行蛇形串成**一条**折线 | 1 / 层 |
| `planLayerToRegionStrokes` | 先按**连通区域**分组，每个区域一条蛇形折线 | 实测 350 总计 |

**实测对比（grid 200、10 色、8 个可见层）**：

| 方式 | 元素数 | 能否保存 |
|---|---|---|
| 逐条 run | 6,642 | ❌ 超 2000 |
| 整层一条 | 8 | ✅ |
| 按连通区域 | **350** | ✅ |

**取舍**：
- 整层一条最省元素，但远端 run 之间的连接线会横穿画面（可见长划线）。
- 按连通区域是**最佳平衡**：连接线只在各自区域内，元素数仍远低于上限。

---

## 七、Apple Freeform（原生 App 绘图）实测

与 Canva（网页/CDP）完全不同的通道：**Freeform 是原生 App，用真实指针（CGEvent）就能画**。

### 能力清单（`cu_snapshot` 读 AX 树得到）

| 控件 | AX 标识 | 内容 |
|---|---|---|
| Drawing Tools | `AXCheckBox "Drawing Tools"` | 工具栏铅笔图标，勾选后出现底部绘图条 |
| Drawing tool | `AXButton "Drawing tool"` | 当前笔型（value=Pen） |
| Choose a drawing tool | `AXButton "Choose a drawing tool"` | **5 档笔宽**：Extra-fine / Fine / Medium / Heavy / Extra-heavy；**10 种笔**：Pen / Monoline / Marker / Pencil / Crayon / Fountain Pen / Reed / Watercolor / **Fill** / Eraser |
| Choose a color | `AXButton "Choose a color"` | 颜色选择，value 显示当前色名 |

### 关键坑

1. **必须先把 Freeform 激活到前台**：`osascript -e 'tell application "Freeform" to activate'`。
   否则 `cu strokes`（hid-events）会发给别的窗口——实测第一次完全没反应，activate 后立刻画出线。
2. 画笔浮层打开时会挡住颜色按钮，先关闭再点颜色。
3 **Fill 工具**（填充）对闭合区域很有效，可大幅减少笔画数。

### 两条路线（2026-11-08 修正：先选路线，再动手）

| | `exactCopy`（**像素级还原首选**） | `handDrawn`（仅在明确要手绘笔触时） |
|---|---|---|
| 做法 | `cu_paint_plan` → `plan-to-png.py --local --transparent` → 剪贴板 → `Cmd+V` | 逐扫描线画笔，每层换色 |
| 一条命令 | `node scripts/draw-image.mjs --image <ref> --target freeform` | 无，需 16 次「开颜色面板→填 hex→关面板→重新 arm→画」 |
| 往返 | **1 次** | 16 层 × 5+ 步 ≈ 80+ 次 |
| 结果 | 逐像素一致、零横纹、零错色 | 圆头笔必留横向条纹；Extra-heavy 会糊掉五官 |
| 风险 | PNG 必须透明 + 局部坐标，否则带白底方块 | 换色后工具跳回「选择」→ 不落笔或画到别处 |

> 旧版本这里写的是「Freeform 没有元素上限，所以应该逐扫描线画」——**这个结论对单色草图成立，对彩色像素级还原是错的**。它只回答了"能不能画"，没回答"该走哪条路"。本次 16 分钟翻车正是因为它被当成了唯一正解。

### 手绘路线的实测数据（保留，供需要笔触时使用）

- `cu drawplan --rect "200,150,800,700" --grid 180 --colors 5`（cell ≈ 4.4×3.9px）
- Medium 笔宽（≈4px）刚好填满行距；Extra-fine 留白缝，Extra-heavy 盖住相邻行
- `planLayerToStrokes()` 每行一条水平线，合并成一个 strokes 文件，一次 `cu strokes` 调用
- 实测：**1,466 笔 / 5,864 点 / 16 秒**，画出完整的黑白像素大肥鱼

**错误示范**：`planLayerToRegionStrokes()` 的折线合并法会在跨行处拉长斜线，画面像草稿——同一张图用它会得到一堆乱线。

### 本次彩色版复盘（16 分钟 / 多次画错）

1. 没先 `cu_route`，把「画一幅图」直接翻译成 16 色逐扫描线画笔；
2. 没先跑一笔最小闭环就批量：换色流程的坑被放大 16 倍；
3. 换色后工具跳回「选择」，有几层没重新 arm，加上工具栏颜色值没变，画出了大块错色；
4. 笔宽在 Heavy / Extra-heavy / Medium 之间反复试，横纹始终去不掉；
5. 最后改用 `plan → 透明 PNG → 粘贴`，**一次就得到逐像素一致的成品**。

**教训**：`cu_paint` 是「手」，`cu_route` 才是「先想清楚」。知识写在文档里不算数，必须在工具返回时送到模型面前（`guidance`）。

### 与 Canva 的路线对比

| | Canva 白板 | Freeform |
|---|---|---|
| 通道 | CDP `Input.dispatchMouseEvent` | 原生 `CGEvent`（cu strokes / cu_paint） |
| 前提 | Chrome 带调试端口（owned profile） | **App 必须前台** |
| 元素上限 | **2,000**（超了不能保存） | 无此限制 |
| 画笔控制 | 自绘 UI，读 DOM 驱动 | AX 树直接暴露按钮/复选框 |
| 适合 | 需要登录态的网页设计 | 本地快速草图、原生体验 |
