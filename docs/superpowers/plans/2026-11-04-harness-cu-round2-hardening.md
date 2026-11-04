# Harness CU Round 2 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 `executing-plans` 逐任务执行。勾选项只在验证通过后完成。本文件是新一轮计划，不是已经完成的修复。

**Goal:** 修复内嵌 CU 的停止、旧帧、旧结果和资源生命周期问题，交付版本一致、能回滚的日常可用版，再收敛观看布局。

**Architecture:** 保留 Harness 插件＋现有 manager＋SCStream；给异步边界增加明确身份和生命周期，停止使用独立幂等通路。沿用已验证的 conversation.input.dock / shell.overlay，不 fork Harness。

**Tech Stack:** 现有 JavaScript ESM、宿主 React、Node test runner、Swift/AppKit/ScreenCaptureKit。

**Spec:** [第二轮设计复核](../../reviews/2026-11-04-harness-design-review-round2.md)。它对原方案 STOP expectedRevision 的纠正优先。

## Global Constraints

- 基线 `52b244f`；实施前重新检查 git status、AGENTS、HEAD、安装版本，保留未跟踪的原方案和他人改动。
- 不新增可点击预览、浏览器 DOM 通道、30 fps 目标或无认证服务；不大规模拆分无关代码。
- UI 用户停止锁存；普通动作不得解除；明确 start/resume 恢复。自然结束与用户停止区分。
- 所有旧结果、旧帧、旧异步收尾不得修改新会话；不以 hostSessionId 单独判断动作归属。
- 不直接照搬旧回滚 D 段；不直接补丁 app.asar，不提交用户数据或凭证。
- 产品默认 uiProbe=false，技术诊断默认折叠；模型截图与观看视频仍独立。

## Review Focus

- 停止发生在状态更新与下一次轮询之间：Task 1 验证旧 revision 仍停止当前 CU session。
- 同一聊天停止后立即重启：Task 2 验证旧动作 ticket 无效。
- 卸载时 poll/decode 尚未完成：Task 3 验证不会复活计时器或绘制旧帧。
- helper 自然退出／报错／换代：Task 4 验证所有收尾走同一 finalize。
- 应用重启与回滚后组件不一致：Task 5、6 核对代码、二进制和实际运行版本。

## Task 1：停止真正可靠

**Files:** `lib/cu-ui-session.mjs`、`lib/harness-ui-bridge.mjs`、`lib/index.mjs`、`lib/core.mjs`、`client.js`；新建 `test/cu_ui_stop_regressions.mjs`。

**Interfaces:** UI `control({hostSessionId,cuSessionId,command})`，STOP/TAKEOVER 不依赖普通状态 revision；cuSessionId 必须匹配。已有工具主动 stop 经可信包装器取得当前 session，不能放宽 HTTP 输入校验。

- [ ] 将探针 R4 改成期望正确行为的失败测试；增加旧 cuSessionId 409、同 session 两个 stop 合并、缺失/错误字段拒绝。
- [ ] 用真实 registerCuTools＋模拟 native executor 构造：UI stop 后，当前模型继续 cu_click(坐标)/cu_type/cu_batch；断言 native 输入计数=0。这个测试不能 stub 掉 assertCanAct 或 startVisualSession 的开闸逻辑。
- [ ] `node --test test/cu_ui_stop_regressions.mjs` 确认红灯。
- [ ] STOP 先确认 owner/session，再关闭闸门／设置 user-stop latch；清理异步进行。旧 revision 不拒绝该同会话停止；明确 start/resume 才重置 latch。不要让自动 autoSession 路径清除用户暂停。
- [ ] Client 不伪造 snapshot.revision+1；响应返回 authoritative snapshot 或按响应 revision 更新。409 stale_session 不自动对新会话重放停止。
- [ ] 复跑新测试及 `test/cu_ui_session.mjs test/harness_ui_bridge.mjs test/third_review_regressions.mjs`；报告模拟 native 与真实执行的边界。提交本任务。

## Task 2：动作 ticket 与状态统一

**Files:** `lib/cu-ui-session.mjs`、`lib/index.mjs`、`lib/core.mjs`；新建 `test/cu_ui_event_lifecycle.mjs`。

**Interfaces:** `beginAction(hostSessionId,action) -> {ok,ticket}`；ticket=`{hostSessionId,cuSessionId,actionId}`；`endAction(ticket,result)`。manager 提供 effect-scoped 会话结束通知，payload 含 CU session identity、原因及 cleanupState。

- [ ] 将 R3 改成失败回归；增加同一 session action2 开始后 action1 返回、不同聊天接手、stop 的迟到 finally 四类测试。
- [ ] 增加 idle timeout/session timeout/agent dispose 时 registry 释放 owner 的测试；cu_expect 通过必须显示 verified，有限证据缺失保持 unverified，不把“未验证”等同于“等待中”。
- [ ] `node --test test/cu_ui_event_lifecycle.mjs` 先红后绿：包装器捕获 ticket，异步 end 校验；订阅统一动作事件／manager 结束通知，不让 UI 与引擎独立猜状态。
- [ ] watcher presence 不等于输入活动；决定并测试 idle 策略：等待中的真实动作不超时误停，只有观看的会话不能无限占 owner；预览可保留最后画面，标明已结束。
- [ ] 所有 dispose 移除事件订阅。复跑 `test/action_events.mjs test/cu_ui_session.mjs`，提交本任务。

## Task 3：Client 生命周期与旧帧隔离

**Files:** `client.js`；新建 `test/harness_client_lifecycle.mjs`。按需抽出小型纯状态模块，但不要为了分文件重写 UI 架构。

**Interfaces:** Store 使用 active + lifecycleEpoch；Preview 使用 streamToken + `{cuSessionId,targetGeneration}`，所有 pending 操作捕获身份。

- [ ] 将 R1、R2 转成期望正确行为的失败测试。使用可控 fetch、createImageBitmap、fake timers，测试真实类，而非正则判断源码含某些字符串。
- [ ] 添加 start→stop→start→旧请求 finally；target A decode pending→B open→A resolve；cuSessionId 变但 generation 相同；B 新流无首帧；mount/unmount 50 次。
- [ ] `node --test test/harness_client_lifecycle.mjs` 确认失败后，实现 epoch 校验；stop 后旧 finally 不 schedule、不改新 inflight；旧 decode 不画图、不改变新 decoding，不更新 live。
- [ ] 新 stream 清首帧 deadline／计数／canvas，按身份丢旧 frame；本 stream 无首帧 1500 ms 后中止或明确降级，不能只有 stale 标签而继续无界等待。重连使用限速和全量快照。
- [ ] previewInfo / connection / stopping 等 UI 变化通过一致的 React snapshot 更新，不能仅 notify 却返回完全相同对象，使 UI 必须等下一次 poll 才刷新。用组件测试验证状态可见。
- [ ] 运行新测试与既有四个 UI 测试文件，提交本任务。

## Task 4：Host/native 收尾和背压

**Files:** `lib/preview-stream.mjs`、`engine/Sources/PreviewFrameOutput.swift`、`test/preview_stream_transport.mjs`；新建 `engine/tests/preview_stream_lifecycle.py`。

**Interfaces:** 每个 stream 一个幂等 finalize(reason)，拥有 child、interval、监听器、byOwner 条目、response controller；旧实例不能更新新实例 previewStatus。

- [ ] 写失败测试：helper 自然 exit/error/被 SIGTERM、request.signal abort、response.cancel、dispose、同 owner 换代；检查 active child=0、interval=0、owner 引用=0，而非只测 pgrep。
- [ ] 为慢 reader 增加一帧 pending latest（覆盖旧待发帧）；验证读到的是最新可用帧且内存有界。不要报告“丢新帧”的实现为 latest-wins。
- [ ] 统一 finalize，绑定 abort signal；exit 分支不另设 closed 跳过清理；readable cancel 释放所有资源。连续自然退出/重连 100 次，无遗留计时器。
- [ ] Swift 将 encoding/stopped/dropped 的读写置于明确同步机制；保持 encodeQueue 不阻塞 captureQueue。实现捕获终止回调、首帧失败退出和有效帧检查。
- [ ] `node --test test/preview_stream_transport.mjs`；`bash engine/build.sh`；`python3 engine/tests/preview_stream_lifecycle.py`（本任务新建，使用自有测试窗口）；可行时跑 Thread Sanitizer，不能运行则标未测。
- [ ] 提交本任务；不用提升 fps 参数掩盖生命周期问题。

## Task 5：安装一致与可执行回滚

**Files:** `engine/install-app.sh`、`engine/install-service.sh`、`README.md`、`docs/reviews/2026-11-04-harness-integrated-cu-rollback.md`、原验收报告；新增 `docs/reviews/harness-round2-installation.md`。

**Produces:** 同一发布构建的 App/service/preview helper，独立版本和签名核对，配置可回滚。

- [ ] 记录更新前四处二进制哈希、代码 commit、签名身份与当前运行 buildId，备份已知可用构建和精确配置 diff。不要输出密钥。
- [ ] 通过已有 installer 更新所有组件；沿用 bundle identifier 与稳定签名，验证权限而不是假设保留。无权限时明确交接系统授权，不擅自重置 TCC。
- [ ] 核对 app、service、cu-preview 与构建一致；从应用入口打开菜单栏、真实工具入口、预览入口各验证一次。
- [ ] 删除回滚文档“未提交”等失效描述及危险的已跟踪文件 rm 清单；先还原配置/完整构建，再对明确 commit 生成 revert 或切换已验证发布快照。对配置只撤本次块，不覆盖之后其他修改。
- [ ] 在隔离安装目的地或可恢复的完整快照验证回滚：native 模式能工作、工具能加载、无残留 helper。报告实际演练范围。
- [ ] 更新原报告中已过时状态但保留历史结果，附本轮 commit/buildId。提交本任务。

## Task 6：真实异常验收，达到日常可用门槛

**Files:** 新建 `docs/reviews/harness-round2-acceptance.md`、对应 evidence 结果；测试驱动放 `engine/tests/`，不要塞入产品入口。

- [ ] 运行完整 `npm test`、`bash engine/tests/run_all.sh --quick` 及新增测试；未正常退出必须诊断，强制退出不算生命周期通过。
- [ ] 在真实 Harness 两个会话做并发控制竞争；B 不夺 A owner、不显示 A 画面、不停止 A。可使用测试客户端驱动两个会话，无需为测试购买额外模型调用。
- [ ] 自有 demo 窗口中跑目标关闭、最小化、20 次目标切换、隐藏预览、Client reload、Host 重启；使用隔离 profile 验证破坏性场景，避免中断用户其他任务。权限失败用受控 fixture 补覆盖，实际撤权未经测试就保留未测。
- [ ] 连续完成 ≥1800 秒长测，自动结束而非等 AI 手动收尾；采样包含 Host、helper、renderer RSS/CPU、活跃计时器/订阅/子进程，区分静止窗口与持续变化画面。异常重连另测，不拿静态 22 分钟代替。
- [ ] 统计 Client 实际 draw 的 FPS／帧间隔，不仅 helper 输出数；点击停止→Client 反馈、Host 收到→关闸、最后输入、资源归零分别计时。至少 30 次测 P50/P95。
- [ ] 预览开关分别 ≥30 次相同 demo 动作，比较 P95（相对回退目标≤20%）；报告次数、失败、环境，删除“6 次 median 就是上限”的结论。
- [ ] 录制实际发生输入的 30–60 秒演示：定位→点击→输入→等待→验证→切目标→停止→后续动作被拒绝。不得从动作已结束才开始录而声称录到了完整流程。
- [ ] 按通过/失败/未测交付；上述 P1 回归和真实停止失败时不宣布稳定版，不用新功能代替修复。

## Task 7：视觉与布局收敛（稳定性门槛后）

**Files:** `client.js`、`lib/index.mjs`、locale、`test/harness_ui_manifest.mjs`；新增 `docs/reviews/harness-round2-visual.md`。

- [ ] 设置 uiProbe 默认 false；禁用时 Client 不发 probe。诊断默认折叠，不再常驻显示 Carrier/Generation/内部时序。
- [ ] 当前聊天输入框上方保持三级：约40 px状态条 → 用户点观看的320 px卡片 → 用户点展开的大面板。空闲无占位、无等待点击的空黑框，不自动打开大遮罩。
- [ ] 收起只停止采集／显示，不隐式停止执行；停止才锁存输入。任何状态都有清晰停止入口；独立原生模式不丢能力。
- [ ] 模态补焦点约束、Esc和焦点归还；点击/键盘/AXPress各只触发一次，避免 pointerdown + click 两条触发靠时间去抖掩盖语义。
- [ ] 深浅色、窄窗、Reduce Motion 验证；真实录屏确认不抢聊天焦点、不移动用户目标窗口。维持 8–10 fps 起点，若用户任务需要更高流畅度再立项。
- [ ] 复跑 Client 生命周期和 Host 控制测试，记录视觉截图与源码版本，提交本任务。

## 交付提示词

请实施本计划，不重新写大架构。先阅读 Spec 和探针结果，按 Task 1–6 修复并验收后再做 Task 7。旧探针 `reproduced:true` 是缺陷证据，将它们转为正确行为回归，而不是维持绿灯。保留用户其他改动和会话；只修改本轮范围。最后提供 commit、实际加载版本、真实演示、验收表和可执行回滚，失败或未测如实写明。
