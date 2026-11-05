# Super Computer Use Codex 式体验 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 CU 上实现与真实动作同步的流畅反馈、独立观看预览，以及可验证的目标身份、执行预算和停止能力。

**Architecture:** 复用 Node 适配器和 Swift 引擎，先统一事件，再让原生执行阶段提供事件。原生视觉 helper 常驻，用户预览流与模型关键帧分开；持续 AX worker 最后接入，不阻塞动画首版。

**Tech Stack:** Node ESM、Swift、AppKit、Core Animation、Accessibility、ScreenCaptureKit、AVFoundation；沿用现有构建方式。

**Spec:** [技术方案](/Users/johnkwok/Downloads/work/dsh-super-computer-use/docs/2026-11-04-cu-codex-experience-technical-design.md)。开发前同时阅读该文与 [第二轮复查](/Users/johnkwok/Downloads/work/dsh-super-computer-use/docs/reviews/second-review.md)。本清单尚未执行；所有“新增”文件和命令选项都是待实现内容。

## Global Constraints

- 保持当前 `arm64-apple-macos14.0` 构建目标，不为本轮动画提高最低系统版本；新增 API 要检查 availability。
- 执行器不等动画、不等可选预览。
- 展开预览只改变 SCU 自己的观看窗口，不应隐式改变目标应用尺寸或进入系统全屏。
- `rimEnabled=false` 必须成为渲染器持久状态；后续 cursor/click/label 不能重新点亮它。
- `(0, 0)` 是合法点。
- `verified` 必须有后置条件证据。没有条件则终态为 `unverified`。
- 原生阶段时间缺失必须保留为 null。
- 不重构无关模块，不替换签名身份、不自动重置 TCC、不改用户业务文件。

## Review Focus

- 混合缩放、负坐标、屏幕之间有空隙：高亮和标签仍位于实际目标屏幕，预览换算无漂移。Task 5、7。
- 旧会话事件和旧截图迟到：不能重新点亮、移动或覆盖新会话。Task 2、4、5、7。
- 输入已提交 OS 后发生停止：不得报告为“未执行”，不得自动重放；收尾未知则 unknown。Task 3、4、8。
- 打包后的 SCK 首帧永不回调或权限改变：预算内降级，释放资源，动作通路可用。Task 7。
- 工具 execute 支持缺省目标但宿主 schema 拒绝：必须通过真实宿主校验路径验证。Task 1、9。

---

路径相对 `/Users/johnkwok/Downloads/work/dsh-super-computer-use`。现有文件及基线定位见 Spec §8。各任务独立提交，执行顺序为 1→2→3→4→5→6→7→8→9；Task 6 先建立基准，Task 9 再用于验收。

## Task 1：目标整体解析与工具 schema（M0 / F1、F8）

**Files:** 修改 `lib/index.mjs`、`lib/core.mjs`、`engine/Sources/main.swift`、`test/identity.mjs`、`test/tool_schema.mjs`；新增 `test/target_resolution.mjs`。

**Interfaces:** `resolveTargetArgs(explicit)` 保留现有工具输入格式，输出完整目标或明确错误；引擎不匹配返回 `{ok:false,error:"target_mismatch"}`，不派发输入。

- [ ] 写失败测试：会话 A 为 pid=42/window=7；显式 pid=99 时断言 `argv` 不含 `--window 7`。补只给 window、同时给不匹配 pid/window、同 app 多窗口、完全省略目标五个用例。
- [ ] 在真实宿主参数校验路径中执行会话内省略 pid 的 `cu_snapshot` / `cu_expect`；断言通过校验且最终绑定会话目标。现有 `test/tool_schema.mjs` 的镜像规则不能替代这次集成检查。
- [ ] 运行 `node --test test/target_resolution.mjs test/identity.mjs test/tool_schema.mjs`，保存修复前失败断言。
- [ ] 按 Spec §7.1 修改目标解析与 native owner 校验；设置层和视觉层消费同一目标结果。
- [ ] 重跑上述命令；使用隔离 demo 确认不匹配时计数器保持不变。提交 `fix: resolve application and window as one target`。

## Task 2：整个预览链共享 deadline（M0 / F3、F7）

**Files:** 新增 `lib/preview-deadline.mjs`；修改 `lib/index.mjs`、`lib/core.mjs`、`test/preview_budget.mjs`、`test/plugin_lifecycle.mjs`。

**Interfaces:** 新增 `createPreviewDeadline({budgetMs, signal, generation, isCurrent})`，返回 `{signal, remainingMs(), check(), dispose()}`。`check()` 在超时、取消或 generation 失效时抛出可区分错误。`budgetMs=0` 兼容原有“不设置本层预算”含义，仍服从外部取消和底层超时。

- [ ] 写失败测试：20 ms 预算，daemon 被终止后失败，断言 fallback 调用次数为 0；随后 key 不等待 130 ms 的模拟 shot。
- [ ] 写慢附件与旧会话测试：获取像素立即完成、保存耗时 130 ms；预算到期返回 degraded，迟到结果不写 `lastImage`。再覆盖 generation 切换和所有迟到 promise 拒绝均被处理。
- [ ] 写默认 preview 省略/true/false/无窗口四条路径测试：同一次启动，预热与实际预览不得同时触发。
- [ ] 运行 `node --test test/preview_budget.mjs test/plugin_lifecycle.mjs`，确认新增断言先失败。
- [ ] 将 deadline 检查接入排队、出队、fallback、附件保存与发布；捕获不排进动作队列。合并 `shouldPreview` 判定；只取消本次 generation 的捕获，不误杀新会话的 daemon。
- [ ] 重跑上述命令；断言超时后下一动作无幽灵截图排队。提交 `fix: bound preview work through delivery and cancellation`。

## Task 3：独立状态/停止通路与真实收尾（M0）

**Files:** 修改 `engine/Sources/main.swift`、`lib/core.mjs`、必要时 `engine/Sources/ProcessSupervisor.swift`；新增 `engine/tests/service_responsiveness.py`；扩展 `test/plugin_lifecycle.mjs`。

**Interfaces:** 既有 `/v1/status`、`/v1/pause` 保持兼容；暂停响应新增 `inputGateClosed`、`cleanupState`（`pending/complete/unknown`），不以 `paused:true` 冒充收尾完成。共享状态查询不得等待动作队列。

- [ ] 建立隔离 demo 测试：启动 2400 ms expect，300 ms 后发送 status/pause；断言受理 ≤100 ms，且暂停闸门确认后没有新增输入派发。
- [ ] 增加慢请求体、已派发后取消、拖拽中停止、迟到子进程退出测试。断言未知结果为 unknown；只释放本工具持有的输入；直接子进程退出不能冒充所有资源已清理。
- [ ] 运行 `python3 -B engine/tests/service_responsiveness.py` 和 `node --test test/plugin_lifecycle.mjs`，确认失败来自现有串行分类/取消缺口。
- [ ] 将有上限的请求读取和分类前移，动作继续串行，状态/取消独立；读取并发上限 8，分类后立即释放读取名额。共享锁不包住 I/O 或 expect。
- [ ] 让停止先关闭闸门，再取消等待和在途任务，最后确认 helper/输入/布局收尾；同目标续期不清除用户暂停。测试使用独立配置/端口，不能触发用户日常服务的全局暂停。
- [ ] 重跑上述命令及 `bash engine/tests/run_prototypes.sh`；保存受理/闸门/收尾三个时间。提交 `fix: keep control requests responsive during execution`。

## Task 4：统一动作事件与 native 阶段流（M1）

**Files:** 新增 `lib/action-events.mjs`、`test/action_events.mjs`、`engine/tests/action_event_stream.py`；修改 `lib/core.mjs`、`lib/index.mjs`、`engine/Sources/main.swift`、`test/visual_feedback.mjs`。

**Interfaces:** `ActionEvent` 完全使用 Spec §5.2；新增 `normalizeActionEvent(raw)` 返回通过验证的事件或结构化错误；manager 新增 `publishActionEvent(eventWithoutSeq)`，先按 eventId 去重再分配 seq；`exec(argv, signal, {eventContext,onEvent})` 第三参数可选。

- [ ] 写表驱动测试：全部动作种类使用相同阶段；拒绝派发无 dispatched；未声明 expect 为 unverified；验证失败不变成 verified；accepted 可无目标但 targetReady 不可；事件重复、旧会话、原点坐标、非法数值各有断言。
- [ ] 写流解析测试：JSON 跨 chunk、同 chunk 多行、事件后断开、缺失 final result、旧引擎单 JSON、单/批动作不重复发布。缺少可靠终态不得转为成功。
- [ ] 运行 `node --test test/action_events.mjs test/visual_feedback.mjs`，确认新增失败。
- [ ] 实现兼容的 `eventsVersion:1` 协商及 NDJSON；原生命令显式 `--events-v1` 才进入流模式，事件上下文由服务传入。默认 CLI 输出保持单 JSON。
- [ ] 在实际解析/派发点发布 native 阶段，JS 发布其实际负责的验证阶段。胶囊/halo/cursor 由同一归一化事件更新；不要另外从日志文本猜状态。
- [ ] 为 capsule 增加与 cursor helper 相同的非阻塞 stdin 更新入口，停止按钮交互保留；旧独立 CLI 可保留兼容路径。取消原来的文件轮询作为实时动作状态的主要通路。
- [ ] 运行 `python3 -B engine/tests/action_event_stream.py` 及 Node 测试；用原生 demo 证明 dispatched 在观察/预览结束之前抵达。提交 `feat: stream consistent action phases to visual feedback`。

## Task 5：常驻、可打断的多屏动画（M1 / F6）

**Files:** 新增 `engine/Sources/VisualFeedback.swift`、`engine/tests/visual_event_view.py`；修改 `engine/Sources/main.swift`、`lib/core.mjs`、`lib/index.mjs`、`engine/tests/aura_view.py`、`engine/tests/halo_view.py`、`test/plugin_lifecycle.mjs`。

**Interfaces:** `VisualFeedbackController.handle(event:)` 消费 Task 4；`configure(sessionId:rimEnabled:reduceMotion:mode:)` 存储会话配置；`shutdown()` 清空动画和窗口。ack 字段使用 Spec §5.4，只代表事务提交。

- [ ] 写离屏测试：rim=false 后依次 cursor/click/label，边缘 alpha 仍为 0；Reduce Motion 没有位置/扩散/呼吸动画，运行中切换会移除已有动画。
- [ ] 写事件调度测试：10 个快速目标只保留最新定位；队列≤64；涟漪≤2；旧会话事件无效；shutdown 后没有任何延迟任务重新点亮；首次光标直接落在目标点。
- [ ] 运行 `python3 -B engine/tests/visual_event_view.py`，确认失败；将现有按文本提取类的测试改为从迁出后的真实类编译，禁止复制测试专用实现。
- [ ] 定点迁出 `CursorLayerView` 与 overlay 路由；每屏独立 panel，按 Spec §4 的尺寸和时长实现。geometry、backing scale、可见区域分别处理，跨屏不从“屏幕并集”推导位置。
- [ ] session 继续时复用 helper，不销毁/重建光标、胶囊和 halo；rim 默认日常关闭、演示可选。标签按字素裁剪，贴边时选择不遮挡目标的可用位置。
- [ ] 重跑视觉与生命周期测试；真机录制 click/type/scroll/drag/失败/停止，覆盖负坐标和混合缩放（无相应硬件则明确未测）。验证实际输入不等待动画。提交 `feat: make visual feedback continuous and interruptible`。

## Task 6：纠正基准并建立呈现测量（M1 / F5）

**Files:** 修改 `bench/run.mjs`；新增 `test/benchmark_results.mjs`、`bench/visual-latency.mjs`、`bench/README.md`。

**Interfaces:** 每轮样本保存 `{scenario,buildId,timings,evidence,error}`；timings 不存在时为 null。视觉测量独立保存 `commandWrittenMs / renderCommittedMs / firstVisibleMs`，三个值不能互相替代。

- [ ] 写结果处理失败测试：`assert.equal(sample.firstVisibleMs,null)`；工具 ok 但计数未变化的轮次必须失败；残留旧文本不能满足新一轮唯一输入的精确匹配；任一失败使进程退出码非零。
- [ ] 写停止场景：实际启动在途任务，分别断言受理、闸门、收尾。首帧用例必须真实启动 overlay，禁止 mock 图片附件的基准命名为真实模型端到端。
- [ ] 运行 `node --test test/benchmark_results.mjs`，确认失败，再修复聚合、样本保留和成功条件。
- [ ] 实现 `node bench/visual-latency.mjs --runs 20`：用独立单调时钟记录受理；原生录屏帧包含测试 marker 与事件编号，分析首次出现该 marker 的有效帧。测试捕获明确包含 overlay，与产品默认干净捕获分开；标明采集帧率、时钟映射和误差，缺帧则 null。不要每帧截图 CLI。
- [ ] 运行 `npm run bench -- --runs 20`，保存完整 JSON；在动画活跃时测实际呈现间隔与中断，记录开关视觉 A/B。若捕获/分析设施不可用，报告未测而不是写 0 ms。
- [ ] 提交 `test: measure real action outcomes and visible feedback`。此阶段的结果是后续 M2/M3 的基线。

## Task 7：原生观看预览及稳定降级（M2）

**Files:** 新增 `engine/Sources/PreviewController.swift`、`engine/tests/preview_stream.py`、`engine/tests/preview_geometry.py`；修改 `VisualFeedback.swift`、`main.swift`、`ConsoleApp.swift`、`ConsoleWindow.swift`、`engine/build.sh`、`lib/core.mjs`。

**Interfaces:** `PreviewController.start(target:generation:) async`、`setVisible(_:)`、`stop() async`；帧元数据完全使用 Spec §6.2。通过 visual helper stdin 的 `preview.start / preview.visible / preview.stop` 配置，视频 buffer 不跨 Node 管道；停止完成返回 ack。

- [ ] 先做实际 GUI helper 的 SCK 小实验：有效首帧≤1500 ms，连续 30 秒能收到并显示有效更新。记录签名、启动方式、权限、SDK/OS 和 buildId；服务上下文结果不能替代 GUI 结果。
- [ ] 写故障/几何测试：无首帧、旧 generation、最小化、隐藏、退出、跨屏、裁切和 letterbox。断言旧帧不标实时，旧几何不画光标，启动失败不会继续循环开流。
- [ ] 运行 `python3 -B engine/tests/preview_stream.py` 和 `python3 -B engine/tests/preview_geometry.py`，确认行为测试先失败。
- [ ] 实现最长边 1280 px、活跃上限 15 fps/空闲 2 fps、隐藏暂停、queueDepth=3、应用待显示 buffer=1、无音频。使用兼容 macOS 14 的 AVSampleBufferDisplayLayer 路径；设置时间基准与即时显示策略，迟到帧丢弃。
- [ ] 实现默认 320 pt 卡片、120 ms 首帧/切换淡化、180 ms 自身展开收起。显式过滤装饰窗口，检查镜中镜；用户预览合成指示，模型截图保持干净。
- [ ] 实现启动超时与捕获故障降级：取消流、提示最近画面，改为动作/用户触发静态帧且最多每秒一次。复用 Task 2 的预算与 generation，不阻塞执行。
- [ ] 重跑测试及 Task 6 测量；录制 30 分钟样例任务，记录更新率、数据年龄、CPU/RSS/WindowServer；50 次开关后资源无泄漏。提交 `feat: add independent native operation preview`。

## Task 8：持续 AX 身份、短任务与在途取消（M3 / F4）

**Files:** 新增 `engine/Sources/AXSessionWorker.swift`、`engine/tests/ax_identity_live.py`；修改 `StateInspection.swift`、`main.swift`、`lib/core.mjs`、`lib/index.mjs`、`test/identity.mjs`、`test/verification.mjs`。

**Interfaces:** worker `observe(target) -> {epoch,snapshotRevision,nodes}`；节点可带 opaque `elementToken`。`resolveAndDispatch(token,action) -> ActionResult` 校验 retained AX 身份、窗口归属、enabled 和实时几何后派发；epoch 重建即全部失效。沿用 Task 4 事件协议。

- [ ] 构造隔离原生 demo：两个同标题按钮指向不同计数器；在不请求第二次 snapshot 的情况下交换位置/容器，旧 token 只能作用于原对象或拒绝，绝不按路径点击另一对象。
- [ ] 补窗口复用/退出、同应用多窗口、worker 重启、通知不支持、键值查询失败、取消发生于最终校验后的测试。未知身份返回 identity_unproven，已派发后未知返回 unknown。
- [ ] 运行 `python3 -B engine/tests/ax_identity_live.py` 与 `node --test test/identity.mjs test/verification.mjs`，先确认旧实现未满足断言。
- [ ] 接入常驻 retained AX worker，通知失效 + 有预算轮询；检查原型实际契约，不只导入原型文件。单一活动会话，释放旧对象和通知订阅；异常退出与服务重启清空 epoch。
- [ ] 接入短 batch 的检查点，明确每步派发与验证结果；恢复会话重新观察，不复用停止前 token。补齐 Task 3 中所有未完成的取消收尾路径。
- [ ] 在同配置下跑 20 轮身份测试和 Task 6 基准，记录对象复用、启动次数、P50/P95；不得用成功率掩盖明确拒绝率。提交 `feat: retain and validate accessibility target identity`。

## Task 9：宿主集成、录像与最终交付

**Files:** 修改 `README.md`、`bench/README.md`；新增 `docs/reviews/codex-experience-acceptance.md`。若 MCP 路径启用，修改 `engine/mcp/server.py`、`execution.py` 并更新其对应测试。

**Interfaces:** 对外保持既有 `cu_*` 工具调用方式；能力状态明确声明事件、图像交付、流预览、身份和取消的支持/降级情况，缺失能力不伪装为成功。

- [ ] 执行 `npm test`、受影响的原生测试、`bash engine/tests/run_prototypes.sh` 和 `bash engine/build.sh`；只按新改动与失败扩展回归，不无限重复相同测试。
- [ ] 在真实 DSH 校验、工具调用、图片交付和结果显示链上完成一个带唯一输入的完整任务；MCP 启用时重复相同语义检查。记录使用的模型与宿主，mock 结果单列。
- [ ] 录制 30–60 秒展示：会话开始→定位→点击→输入→等待→验证→停止。附对应事件 JSONL、屏幕帧证据与耗时；视频与日志必须来自同一构建同一次运行。
- [ ] 按 Spec §10 执行固定任务集，逐项填写“通过/失败/未测”，包括所有 Review Focus；60 Hz 呈现指标与 30 fps 参考片分开。
- [ ] 核对构建/安装/运行服务身份；准备可回退构建，不自动修改签名身份或 TCC。记录未解决项、运行环境和回归范围。
- [ ] 提交 `docs: record verified computer use experience acceptance`；交付源码差异、测试结果、完整原始样本和录像链接。未达标项不得标成已完成。

## 计划自检结果

- Spec §2 的参考证据只用于视觉方向，不作为性能成绩；Task 6、9 定义独立测量。
- Spec §4 动画由 Task 4、5、7 覆盖；Spec §5 协议由 Task 4 覆盖；Spec §6 预览由 Task 2、7 覆盖。
- Spec §7 的目标、队列、身份、batch、停止分别由 Task 1、3、8 负责；F5/F6/F7/F8 均有对应任务。
- Review Focus 五项都分配了失败条件和验收任务；原生阶段事件、RenderAck 和首屏呈现没有混成一个指标。
- 本清单用于外部 AI 接手执行，本次不启动上述实现。
