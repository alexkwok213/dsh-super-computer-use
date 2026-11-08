# CDP 通道：为什么、能不能三条路径一起做、怎么落地

日期：2026-11-08
状态：路径 B（CDP 通道）已实现 `lib/cdp.mjs` + `cu_cdp_paint`，端到端实测通过（含 owned debug Chrome 无授权框绘制）。

## 一句话结论

**A、B、C 三条路径功能上能一起存在，但不该「并列都做」：A 和 C 是同一套代码且对 Web Canvas 无效；B（CDP）实测有效，是唯一能把画笔画到浏览器 Canvas 上的通道。落地形式是「A/C 复用同一 plan 编译器 + B 作为浏览器目标的执行后端」。**

## 三条路径到底是什么

| 路径 | 本质 | 现状 | 对 Canva 这类 Web Canvas |
|---|---|---|---|
| A `cu_synthesize_drawing` | 图像→分层笔画计划编译器 | 已存在：`cu_paint_plan` + `engine/Sources/DrawPlan.swift` | ✅ 生成计划没问题（实测 8 色、1446 runs） |
| C 原生 `strokes` | 单进程批量 CGEvent 注入 | 已存在：`bin/cu strokes` + `cu_paint` | ❌ **实测画不上** |
| B CDP | 通过 Chrome DevTools Protocol `Input.dispatchMouseEvent` 注入 | 本次新增：`lib/cdp.mjs` + `cu_cdp_paint` | ✅ **实测画得上** |

## 实测证据（本次会话）

1. **原生指针对 Canva 无效**：`./bin/cu strokes ... --pace 13` 返回 `ok:true via:hid-events`，但截图前后画布**零变化**。即使 Chrome 处于前台，Canva 的渲染循环过滤了 CGEvent 合成的指针事件。
2. **CDP 有效**：`Input.dispatchMouseEvent` 注入后，Canva 画布**立即出现笔画**。
3. **owned debug Chrome 全链路通**：`launchDebugChrome` 拉起专用 profile 的 Chrome → attach → `paintStrokes` → 读取 canvas 像素，**701 个非透明像素**，证明笔迹真实落上去了。

## 为什么会反复弹「Allow remote debugging?」

Chrome 144+ 对**附加到用户日常浏览器**（`chrome://inspect#remote-debugging` 那套 autoConnect）**每次请求调试会话都征询一次授权**。这正是本机 Chrome 156 的行为。

**关键点**：这不是 Chrome 的必然规矩，而是「attach 到日常浏览器」这一种接法才踩到的安全闸。`browser-use` / Playwright 从来不弹，是因为它们**用专用 `--user-data-dir` 自己拉起一个 Chrome**，那个实例的调试端口对自身进程是可信的，不触发 autoConnect 授权。

## 正确落地：owned debug Chrome（已实现）

`cu_cdp_paint` 的 `launch:true` 会：
1. 用 `--remote-debugging-port=<port> --remote-allow-origins=* --user-data-dir=<专用目录>` 拉起一个**插件自己的** Chrome（默认 `~/.cu/cdp-profile`）；
2. 从 `/json/version` 拿 `webSocketDebuggerUrl`（新实例 HTTP 端点正常，不像日常实例被 404 限制）；
3. 连接、attach、注入，**全程无授权框**；
4. 长连接池复用（`acquirePage`/`releasePages`），同一页面后续调用不再重连。

首次在这个专用 profile 里登录一次 Canva，登录态长期保存在该 profile，后续 run 直接可用。

## 「三条路径一起做」的最终建议

- **代码层面**：A（`cu_paint_plan`）与 B（`cu_cdp_paint`）**共享同一个 plan 文件格式**，A 编译、B 执行。C 保留给原生 App（剪映/Photoshop 这类能接受 CGEvent 的），对浏览器不用。
- **不需要也不建议**把 C 硬塞给浏览器：那是白费功夫（实测无效）。
- **选择执行后端**：目标是网页 → `cu_cdp_paint`（owned 模式）；目标是原生 App → `cu_paint`（native strokes）。二者共同消费 `cu_paint_plan` 的计划。

## 使用示例

```
# 1. 编译参考图得到计划（一次性）
cu_paint_plan { imagePath:"/path/fish.png", x:330, y:500, width:760, height:450, colors:8 }

# 2. 拉起专用调试 Chrome（首次需在该 profile 登录 Canva）
cu_cdp_paint { action:"status", launch:true, startUrl:"https://www.canva.com/" }
cu_cdp_paint { action:"status", urlMatch:"canva.com" }

# 3. 逐层绘制（先设好画笔颜色为该层 hex）
cu_cdp_paint { planPath:".../plan.json", layerIndex:7, urlMatch:"canva.com", paceMs:14 }
...

# 收尾断开长连接
cu_cdp_paint { action:"disconnect", urlMatch:"canva.com" }
```

## 已知边界

- `Input.dispatchMouseEvent` 对使用 PointerEvent 的站点也有效（Canva 实测通过），但个别站点若只认 `pointerdown` 可能需要补 `pointerType`（后续可按需增强）。
- 密码、Cookie 等敏感数据保持在专用 profile，不应导出。
- 该通道仅用于浏览器页面绘制；不替代原生 App 自动化。

## 可靠复刻一张图：`scripts/draw-image.mjs`（一条命令）

驱动 Web 应用的"自由画笔"不可靠（笔刷默认过粗糊成一团、颜色/粗细是自绘控件点不中、hex 打了不生效、Cmd+Z 不进撤销栈、坐标受缩放影响）。可靠做法是**编译→光栅化→放置**，一条命令跑完：

```bash
node scripts/draw-image.mjs \
  --image ./ref.png \
  --url https://www.canva.com/design/<id>/edit \
  --colors 9 --grid 130 \
  --out ./out/fish.png
```

步骤：
1. `cu drawplan` 把参考图编译成分层笔画计划（确定性）。
2. `scripts/plan-to-png.py` 把计划**光栅化成像素级精确的 PNG**（离线、可复现、可单测 —— 见 `test/plan_to_png.mjs`）。
3. 通过 CDP 打开/复用 owned debug Chrome，把 PNG **上传进设计并点到画布上**（自动打开"上传"面板、`DOM.setFileInputFiles`、点缩略图）。

`--no-place` 只出 PNG。这是复刻参考图最稳的路，避免与自绘画笔 UI 搏斗。

## 实测结论（Canva 白板）

- `cu_paint_plan` + `cu_cdp_paint`（逐笔画）能画，但 Canva 画笔默认极粗 + 缩放相关性 + 颜色/撤销控件不可靠 → 逐笔复刻难出好效果。
- **plan→PNG→上传放置** 稳定、像素级、可复现，是推荐路径。
- 全链路零 "Allow remote debugging" 弹框（owned profile）。
