# 2026-11-05 多目标后台操控：实现与验收

本文记录本轮把 Computer Use 从“单 activeSession + 全局队列”改为“聊天 owner + 多个目标”的实现、真实 helper 验收和能力边界。它刻意区分：

- 工具返回 `ok`；
- 目标状态被显式后置条件证明；
- 用户桌面确实没有被抢焦点/移动鼠标/覆盖剪贴板；
- 真实 DSH 是否已经加载本轮代码。

## 结论

- 同一聊天现在可持有多个目标；每个目标有独立 `targetId`（pid + window + 代次）、快照/引用基线、执行队列、停止闸门和预览状态。
- 单目标停止只影响该目标；全部停止关闭全局闸门、清空队列，迟到结果不能复活目标。
- 默认 `cu_session start` / `autoSession` / 观察 / 截图 / 预览 **不激活、不移动、不 dock、不 stage** 目标窗口。`dockDsh`、`splitScreen`、`bringOnStage` 是显式 opt-in。
- 前台动作必须同时带 `foreground:true` 与 `authorizeForeground:true`，否则在发送任何输入前拒绝。
- 原生服务按目标 PID 分 lane：不同 PID 的读取/截图/安全后台操作可并发；同一 PID（包括同进程多窗口）和全局焦点/键鼠/剪贴板/窗口布局仍串行。
- 原始 PID 鼠标/键盘事件不再因为“已派发”而算成功：没有显式 `expect` 时返回 `ok:false, error:"effect_not_verified"`。AXPress/AXSetValue + 明确后置条件仍是可靠路径。

## 真实验收（隔离 service + 两个自有 fixture 窗口）

环境：`engine/tests/multi_target_acceptance.mjs` 自建临时 `CU_STATE_DIR`、随机端口和 token，启动两个 `engine/tests/fixtures/acceptance_target.swift` 实例（自有测试应用，不使用真实聊天/邮件/业务数据）。第三个应用保持前台（最近一次为 DeepSeek Harness，更早一次为 Antigravity；记录值取实际 frontmost）。

| 检查 | 结果 |
| --- | --- |
| 两个目标的 AXPress（并发） | A `AXPress-background`、B `ax-worker-token`；两次并发点击总耗时 ~535 ms，计数 0→1 均由目标自身状态证实 |
| 两个目标的 AXSetValue（并发） | A/B 文本均通过 `expect` 读回，`verified:true`；两次并发输入总耗时 ~297 ms |
| 不同目标并发读取 | 两个 1600 ms 的 `cu_expect` 并行总耗时 ~1833 ms（串行应 ~3200 ms） |
| 预览隔离 | 两条 `preview-stream` 分别带 `--target-id`；首帧 meta 的 `targetId` 与目标一致 |
| 前台应用 | `frontmost` 前后均为同一个应用（最近一次 DeepSeek Harness pid 46926；更早一次 Antigravity pid 99659） |
| 真实鼠标位置 | `NSEvent.mouseLocation` 前后完全一致 |
| 剪贴板 | `pbpaste` 前后一致 |
| 停止 A 后 B 继续 | A 目标停止；B 的 AXPress + `expect` 仍 verified |
| 停止 A 后操作 A | 被拒绝，没有派发输入 |
| 全部停止 | `activeTargets=0`、`inputGateClosed=true`、`targets.size=0`；之后入队按键被拒 |
| 无 AXPress 自绘画布 | PID 鼠标事件后画布值仍为 `Canvas 0`；工具返回 `ok:false, error:"effect_not_verified"`，`dispatchOnly:true` |

最后一次通过的验收输出中的关键值：

```json
{
  "backgroundClicksVerified": true,
  "backgroundClicksMs": 535,
  "backgroundTypingMs": 297,
  "backgroundTextVerified": true,
  "pidDispatchNotReportedAsSuccess": true,
  "concurrentReadsAcrossTargets": true,
  "concurrentExpectMs": 1833,
  "previewsBoundToTarget": true,
  "frontmostUnchanged": true,
  "cursorUnchanged": true,
  "clipboardUnchanged": true,
  "afterStopABStillWorks": true,
  "stoppedATargetRefused": true,
  "stopAllClosedEverything": true,
  "queuedInputRefused": true
}
```

## 能力边界（实测）

**可可靠后台执行（有显式效果证据）**

- `AXPress`：标准按钮等暴露 `AXPress` 的控件；不激活、不移动窗口。
- `AXSetValue`：文本字段写值后读回，`expect` 命中；不碰剪贴板。
- 不同目标的只读 `snapshot` / `expect` / `window` 截图可并行；同一目标保持顺序。
- 预览流：每个目标独立子进程，meta 带 `targetId`；关闭/停止/代次变化后 stream 关闭。

**只能观察、不能仅靠 PID 事件后台操作**

- 自绘 `NSView`/canvas 没有 `AXPress` 时，PID 鼠标事件在非活动窗口上没有改变其状态。工具会返回 `effect_not_verified`，而不是成功；坐标点击不再被无限重试。
- 这类目标需要显式 `expect` 仍可证明真实变化；若没有，结果保持未验证/失败。需要前台操作时必须走 `foreground:true + authorizeForeground:true`，由用户明确授权。

**需要授权前台**

- 真实前台点击、前台键盘/快捷键、需要真实剪贴板的输入。工具会先返回 `foreground_requires_authorization` 和影响范围，不发送输入。
- Stage Manager 缩略图、目标窗口移动、DSH dock/并排布局：只有显式 `bringOnStage` / `splitScreen` / `dockDsh` 才执行。

**仍需串行**

- 同一目标的所有操作。
- 同一 PID 的多个窗口（原生 lane 以 pid 为键）。
- 系统焦点、全局键鼠、剪贴板、窗口布局、全屏截图。
- 当前常驻 AX worker 只保留最近一次观察的目标；其他目标自动走一次性 pid/window + snapshot provenance 校验路径，不共享 token。

## 测试与构建

- `npm test`：**253 passed / 0 failed / 0 skipped**。
- 新增：
  - `test/multi_target.mjs`：9 项多目标/停止/队列/代次/只读选择/窗口失效测试；`test/harness_ui_bridge.mjs`：新增 bridge 等待异步 connection 服务测试；
  - `test/harness_client_lifecycle.mjs`：两个目标各自预览流、停 A 保 B、全停关闭；
  - `engine/tests/multi_target_acceptance.mjs`：真实 helper 双目标验收。
- 原生构建：当前 `bin/cu` SHA-256 `bebc8cb10c717bde375f6f9d9cdecc9d4259d0dadffd9dfc06913c723f634d4e`（包含可靠 frontmost 修复），universal (x86_64 + arm64)。
- Client source SHA-256：`f500662d917d664d81a5b36f50c18c6f51f1a56f9c88e6a6709d0c0e9d8980dd`。
- Client source SHA-256：`f500662d917d664d81a5b36f50c18c6f51f1a56f9c88e6a6709d0c0e9d8980dd`。
- 测试使用临时 `CU_STATE_DIR`/端口；结束后核对真实 `~/.cu/config.json` 与 `pause` 未变。

## 真实 DSH 加载状态（已生效，真实工具验收通过）

第三次正常重启后，真实 DSH 加载了最新 Host/Client：

- hostPid `55115`，loadedAt `2026-11-05T16:03:37Z`
- Host `sourceHash 38a127e5…`，与当前仓库一致
- 启动日志：`Harness UI bridge installed after connection service became ready`
- Client 实际 hello `ef29a1540637`，`matchesCurrent:true`
- Client slot `conversation.input.dock` 中 `super-computer-use` 已注册且 `active:true`
- 新会话实际调用 `cu_status` 成功，`plugin.native.runningServiceBuildId` 与 `runningPid` 均存在

随后原生-only 更新通过**插件自己的 helper 生命周期**完成：

- 旧 helper `55136` 退出，新 helper `55927` 由插件自动拉起，父进程仍为 DSH host
- 新 helper `buildId bebc8cb1…`；旧 helper 已退出
- `cu_status.frontmost` 修正：真实前台 TextEdit (pid 55304) 被正确报告，不再错误返回 DSH
- `/v1/status`：`ok:true`、`frontmost TextEdit`、`inputGateClosed:false`、`cleanupState:"complete"`

### 真实 DSH 双目标工具验收

由新会话通过真实 `cu_*` 工具完成（不是 Node 测试进程）：

- 两个 `CU Acceptance DSH A/B` fixture 目标；两个都保留 `ax-worker-token`
- A/B 按钮计数 0→1 均由 `expect` 验证
- `cu_status.targets` 同时显示 2 个不同 targetId
- 停止 A 后 B 仍可点击并 verified；A 的 input gate 关闭
- 全部停止后 `targetCount:0`，旧 B targetId 再点击被拒
- 全程 `foreground:false`、未移动窗口、未写剪贴板

### 用户持续前台输入验收

用户按约定在 TextEdit（临时 `cu-typing-test.txt`）持续输入，期间对 A/B 执行 8 轮后台动作（13.2 秒，全部 verified，全部 `ax-worker-token`）：

- TextEdit 文档哈希变化：`398ca66e…` → `da502400…`，证明输入真实发生
- 前台应用保持 TextEdit
- 真实鼠标位置：`752.0450,751.3589` → 完全一致
- 剪贴板 SHA-256：`04281137…` → 完全一致
- 停止 A 后 B 仍可点击；全部停止 `pause:false`，0 targets
- 说明：`cu_status.frontmost` 在旧 helper 中是陈旧的；新 helper `bebc8cb1…` 已修复并用真实前台 TextEdit 验证

`dev:sync` 的 HMR 通道在这个宿主仍不可用（退出 3），但真实 DSH 的 Host/Client/native 身份、真实工具调用和用户前台输入均已独立核验。

## Control Deck 与后台打开应用（真实 DSH 已加载）

针对“像 DSH 自己的功能”这一轮新增并已在真实 DSH 生效：

- `cu_launch` 默认 `background:true`：真实 DSH 调用 `com.apple.calculator`，前台保持 DeepSeek Harness，Calculator 窗口创建为非前台，`targetCount` 仍为 0；应用本身没有抢焦点。`background:false` 需要 `authorizeForeground:true`。
- Client `ControlDeck` 注册在 `shell.overlay`：真实 DSH 的 slot 检查显示 `super-computer-use-deck`（order 39）`active:true`，与原有 Overlay（order 40）并存。
- **每个活动目标一个独立浮窗**，右下角层叠排列；两个目标就是两个浮窗。每个浮窗有独立实时画面、状态、收起/展开、关闭和停止；多目标时顶部有“全部停止”胶囊。
- Apple 风格：SF 字体栈、半透明层叠玻璃、柔和双层阴影、20px 圆角、进入动画和 stagger、hover lift、LIVE 状态胶囊、reduced-motion 支持。
- 浮窗绑定当前聊天，关闭单个浮窗不影响其他目标；全部隐藏后从聊天卡片“控制台”重新打开。
- Deck 绑定当前挂载聊天，不串其他聊天的目标；关闭时释放预览流。
- 嵌入模式默认关闭桌面原生 capsule，避免 DSH 内一套、桌面外一套；窗口高亮与点击反馈保留。

真实运行身份（2026-11-05 16:34 重启）：

- hostPid `58504`，Host `sourceHash 3df65ecd…`
- Client 实际 hello `9ce9ac87a356` / source `f30b2cdd…`，`matchesCurrent:true`
- native helper pid `58525`，`buildId 94e1d709…`，与磁盘 `bin/cu` 一致
- `shell.overlay` 下 `super-computer-use-deck` 已激活
- 完整测试 **253 passed / 0 failed / 0 skipped**

真实 DSH 中的 Control Deck 视觉截图尚未生成；本轮通过真实 slot 注册、真实客户端 bundle、真实 helper 后台 launch 和客户端渲染测试核验。用户在新聊天发起 CU 目标时会看到 Deck，当前这个长会话的 agent 工具表是重启前建立的，不能作为发起目标的入口。

## 两应用同时后台操作实测（2026-11-06 00:38）

两个目标同时 active：

- ZCode `21162:31596`
- Claude `56241:32553`
- DSH 前台在开始和结束时都是 `DeepSeek Harness`（pid 58481）
- ZCode：后台 AXPress `返回` → 市场列表 → `Github`，回到 GitHub 详情页
- Claude：后台 AXPress `General` → `System`，回到 Computer use Beta 页，未点击开关
- 截图：[two-zcode.png](../demo/two-zcode.png)、[two-claude.png](../demo/two-claude.png)
- 录屏：[two-apps-background.mov](../demo/two-apps-background.mov)，120.01s，3456×2234

测试中暴露了一个真实的瞬态问题：两次操作之间超过默认 60 秒，idleStop 结束了会话；随后普通点击自动恢复视觉会话时，在没有 DSH client 的验收会话里启动了原生 capsule，短暂出现前台进程 `cu`。窗口级前台检查在开始/结束仍是 DSH，但这不满足“全程无前台弹跳”。

已修复但尚未加载到运行中的 Host：

- idle 默认从 60s 提高到 300s；
- autoSession 只在 DSH client 存在时启动；没有 client 时不再创建原生 capsule；
- `cursor:false` 在首次启动时真正被遵守。
- Host 当前代码 `45e0247e…`（运行中 `3df65ecd…`），Client `f30b2cdd…`（HMR 已实际执行），native `94e1d709…`。

## 未完成/限制

- 真实 DSH 的 `super-computer-use-deck` slot 已确认 active，Client bundle 已实际执行；但没有从真实 DSH 页面截取一张带活动目标的 Control Deck 视觉截图。本轮由真实 slot 注册、真实后台 launch 和客户端渲染测试覆盖。
- 当前这个长会话的 agent 工具表是插件重载前建立的，不能在当前聊天直接调用 `cu_*` 发起目标；新聊天会使用新工具表。因此真实 DSH 的 Deck 视觉验收留给新聊天/用户实际使用。
- `dev:sync` 在该宿主没有 Host HMR，无法打印 `OK`；本轮用运行中 host/client/helper 身份和真实工具调用核验，而不是用另一个 Node 进程冒充 DSH。
