# 双目标后台操控 + 双浮窗 验收报告

- 结果：**通过（PASSED）**
- 时间：2026-11-06 00:47 – 00:56 (+08:00)
- 运行版本：host `793cabcded39` / client `9ce9ac87a356` / native `5b63bd8e672b`
- 约束遵守：仅用 cu_* 工具操控界面；未用 foreground:true；未切换设置；未安装插件；未移动/激活窗口；
  未触碰 Claude 的 “Enable computer use” 开关。

## 两个 targetId

| 应用 | pid | windowId | targetId |
|---|---|---|---|
| ZCode | 60081 | 32739 | `60081:32739` |
| Claude | 59967 | 32722 | `59967:32722` |

启动参数：`dockDsh:false, splitScreen:false, capsule:false, halo:false, cursor:false, preview:false`。
`cu_status` 确认 `targetCount=2`，两个 target `stopped:false, gateClosed:false`。

## 导航证据（AX 文本）

**ZCode → GitHub 插件详情页**
- 面包屑：`插件市场 > Github`
- `AXHeading "Github" @802,298`
- 描述：`基于 GitHub CLI 的 GitHub 工作流，覆盖提交、Pull Request、Issue、Release、Actions、仓库、Codespaces 等资源。`
- `立即试用` 按钮 + `技能 10` 列表（codespace / commit / gist / issue / pr / release / repo …）

**Claude → Settings → System → Computer use Beta**
- `AXButton "System" @242,428`（设置侧栏）
- `AXHeading "Computer use Beta" @466,626`
- `AXCheckBox "Enable computer use" @1450,709`
- 开关状态：**开启（ON，蓝色）** — 仅读取，未点击

## 三张截图（真实文件，已转为真 PNG）

1. `/Users/johnkwok/Downloads/work/dsh-super-computer-use/docs/demo/two-floats-test/01-zcode-github-detail.png`
2. `/Users/johnkwok/Downloads/work/dsh-super-computer-use/docs/demo/two-floats-test/02-claude-computer-use-settings.png`
3. `/Users/johnkwok/Downloads/work/dsh-super-computer-use/docs/demo/two-floats-test/03-dsh-two-floats.png`

第 3 张为 DSH 窗口全幅：右上/右下可见**两个独立半透明浮动控制窗**，分别标 `ZCode #32739`、
`Claude #32722`，各自带 LIVE 缩略图与 Stop 按钮。

## 逐项核对

| 项 | 结果 |
|---|---|
| 初始 pause | 无（paused=false, pauseLatched=false），未调用 resume |
| 双目标同时存在 | 是，targetCount=2 |
| 两个目标各对应一个 DSH 内独立浮窗 | 是，截图 03 可见两张独立卡片 |
| 操作期间 DSH 前台 | 是，每次动作后 `frontmostAfter` 均为 DeepSeek Harness，`cu_windows.frontmost` 也是 DSH |
| Claude Computer use 开关未被修改 | 是，仅按过 `Settings` 菜单项与 `System` 侧栏项，从未按 checkbox |
| 停止 ZCode 后 Claude 仍可用 | 是，`remainingTargets=1`，Claude 的 “Computer use Beta” 标题仍可读 |
| 全部停止后 | `targetCount=0`、`inputGateClosed=false`、`pauseLatched=false`、`activeSession=null` |
| 原生 capsule/halo/cursor | 全程未出现（start 时三者均 false） |

## 本轮发现并修复的问题

1. **ZCode 冷启动慢于重试窗口**（约 90s 才出窗口），`cu_launch` 提前返回 `pid:-1, ok:true`，
   上一轮据此误判为“启动失败”。本轮改为按窗口出现判定，而不是按 launch 返回判定。
2. **AX ref 在动态 WebView 中必然失效**：ZCode/Claude 的树在每次聚焦、渲染后都会重排，
   snapshot 记录的 `k2.x.x` 路径与点击时重走的路径不一致，引擎返回 `stale_ref`；
   直接坐标点击又进不了 WKWebView 内容区（树会刷新，但页面不导航）。
   修复：新增 `cu_click_text` —— 按可见文案一次遍历定位并 `AXPress`，不依赖 ref 或坐标。
   改动 `lib/index.mjs`，同步更新 `README.md` 与 `test/core.test.mjs`（工具数 13→14）。
   `npm run dev:sync` 退出 0：253 测试全过、native 重建、Host 重载、真实版本核验 OK。
3. 附带修正：`cu_screenshot` 返回的字节实际是 WebP，本轮交付前用 `sips` 转成真 PNG，
   避免扩展名与内容不符。

## 浮窗改版（第二轮：控制窗极简化）

原浮窗是白色大卡片：整块浅色底 + 16:10 大预览 + 独立“2 targets / Stop all”药丸，
两个目标叠出三块白框。改为：

- **默认只保留控制信息**：一行 `orb + 应用名 + 状态/动作 + Stop + 展开箭头`，高度 38pt，
  宽 284pt。预览改为点箭头才展开，不再常驻常亮。
- **材质换成深色半透明玻璃**：`rgba(22,22,24,.74)` + `backdrop-filter: blur(34px) saturate(180%)`，
  0.5pt 高光描边 + 内顶高光，去掉原来的白色渐变高光层。
- **去掉聚合药丸**：deck 现在严格是一目标一浮窗；`Stop all` 仍可在输入框下方那张卡片上用。
- **次要操作延迟显形**：`↗` 与 `×` 只在 hover/focus 出现，静止态只有 Stop 和一个箭头。
- 状态副标题从“状态 · 动作”改为“有动作显示动作，否则显示状态”，不再截断成 `St…`。

对应改动：`client.js`（浮窗 CSS + `TargetFloat` + deck 渲染 + `collapsedTargets`→`expandedTargets`），
`test/harness_client_lifecycle.mjs` 同步新契约。视觉验证：client rev `df60f15dbaf6`，
截图 `03-dsh-two-floats.png`（改版后），`03-dsh-two-floats-before.png`（改版前，留作对比）。

改版后又跑了 4 次 `npm run dev:sync`，每次都退出 0、253 测试全过、真实版本核验通过。

## 录屏授权为什么会反复弹（第三轮）

现象：系统弹窗 “DeepSeek Harness is requesting to bypass the system private window
picker and directly access your screen and audio.”

定位过程：
1. 抓屏全部走 ScreenCaptureKit —— `engine/Sources/PreviewCapture.swift` 用
   `SCShareableContent` / `SCStream` / `SCScreenshotManager`。这个“绕过系统窗口选择器”
   的弹窗是 macOS 15 对 **直接调用 SCK** 的同意弹窗，和系统设置里那个老的
   “屏幕录制”开关不是同一件事。
2. 更关键的是**会话一开始就抓图**：`startVisualSession()` 里调 `warmCaptureDaemon()`，
   预热会真截一张 64px 全屏图；同时给菜单栏 REC 指示器开一条 SCK 显示流。
   也就是说每次 `cu_session start` 都会开一次抓屏——不管这次要不要看图。
3. 做抓屏的是独立二进制 `bin/cu` / `bin/cu-preview`（`codesign -dv` 显示
   `Identifier=cu`、`Info.plist=not bound`、Team `65JNWZ4UK4`，本次会话内
   buildId 从 `94e1d709…` 变成 `5b63bd8e…`）。每次 `dev:sync` 重建重签，
   macOS 之前记下的那份授权就不再对应这个二进制。
4. 无法进一步取证：本 shell 没有完全磁盘访问权限，
   `~/Library/Application Support/com.apple.TCC/TCC.db` 打不开，所以“授权到底记在
   哈希还是 code requirement 上”这一点我**没有验证**，只按弹窗条件与二进制变化推断。

已改（控制型会话不再碰 SCK）：
- 会话启动不再开 REC 显示流；`ensureScreenIndicator()` 改为**第一次真正抓屏时**才开。
- deck 显示不再自动开预览流，只有展开某张卡片 / Watch / 大面板才开。
- `warmCaptureDaemon()` 只在确实要预览时才预热；纯控制会话不再为预热截那一张图。
- 测试相应改为：`a control-only session never opens a ScreenCaptureKit stream`。

实测：`cu_session start` 两个目标后，
`bin/cu screen-indicator`、`bin/cu capture-daemon`、`cu-preview` **三个进程都不存在**；
调用一次 `cu_screenshot` 后 `capture-daemon` 才出现（67127）。测试从 253 增到 254，全过。

## 未验证/限制

- 浮窗固定在视口右侧 `right:20px; bottom:96px`，不是严格“右下角”贴合聊天面板；
  窗口未做任何移动（按约束不移动窗口）。
- `cu_launch` 仍然无法等到窗口真正出现；建议后续让它轮询窗口或用 `--wait`。
- 深色材质是刻意的设计选择（HUD 对照页面内容），没有跟随 DSH 明暗主题切换；
  若希望浅色主题下改回浅色玻璃，需要再加一套 `prefers-color-scheme` 分支。
