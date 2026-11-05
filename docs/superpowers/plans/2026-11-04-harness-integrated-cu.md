# Harness Integrated Computer Use Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（本机名称 `executing-plans`）逐任务实施。Steps use checkbox (`- [ ]`) syntax for tracking. 本文件是交接方案，作者没有执行以下实现。

**Goal:** 在真实 DeepSeek Harness 内提供会话绑定的 CU 观看卡片、流式预览、明确状态和可靠停止，接近 Codex 的整合体验。

**Architecture:** 优先扩展现有 SCU Host bundle 与新 Client 模块，使用 Harness slots 和认证 Fetch routes。原生 SCStream 输出有界二进制画面，现有 manager 继续负责控制。只有宿主接入 gate 失败才做最小 Harness 源码适配。

**Tech Stack:** 现有 Node ESM/Cordis、宿主 React 18、Electron、Swift/AppKit/ScreenCaptureKit、Node test runner。

**Spec:** [本机调查与设计](../../2026-11-04-harness-integrated-cu-design.md)；同时阅读 [证据摘录](../../research/2026-11-04-harness-local-evidence.json)。本文件所有新文件和 HTTP 接口都是待实现设计。

## Global Constraints

- 工作区 `/Users/johnkwok/Downloads/work/dsh-super-computer-use`；最终调查基线 main `2a0bdb713467e011599e6d56eb8793f6b1ba242e`。先看当前 HEAD/dirty 状态，不回退他人改动。
- 本机 Harness 0.2.1-rc.5，构建 `d4db512a969fccf0c5cc7ec8fe38e9c1d27af916`。执行前复核，不假设未来版本兼容。
- 不修改安装包、不上传／发布、不自动更新 Harness；实际部署使用现有插件管理流程并保留回滚路径。
- 复用现有工具和停止闸门；模型截图与观看视频分开。不开无认证端口，不绕过宿主认证／CSP。
- UI 不显示完整输入正文，不往模型上下文灌视频；不修改目标应用布局；预览首版仅观看。
- 原生预览保留兼容路径；默认开启内嵌模式前必须通过真实宿主验收。
- 每个任务完成后仅提交本任务文件；未提交的既有改动不得夹带。所有计时目标是验收指标，不是既有成绩。

## Review Focus

- 第二个聊天／Agent 与当前 owner 冲突：Task 2 验证拒绝，不能串画面或停错任务。
- Desktop custom carrier 不支持标准网页流：Task 1 做真实宿主 gate，失败走 Task 1B。
- 最小化／退出／切目标时迟到视频：Task 4、5 检查 generation 与 stale，不绘制错误目标。
- 停止与正在执行、排队动作竞态：Task 2、3 测输入闸门与幂等，不能仅关闭界面。
- UI 卸载／宿主退出导致残留捕获：Task 4、6 测取消、EOF、无订阅停止以及进程清理。

---

## Task 1：验证外部 Client 插件接入（依赖 gate）

**Files:** 新建 `client/index.js`、`client/scu-card.js`、`lib/harness-ui-bridge.mjs`、`test/harness_ui_manifest.mjs`；修改 `package.json`、`lib/index.mjs`、`locale/en.json`、`locale/zh.json`。gate 记录写 `docs/reviews/harness-ui-gate.md`。

**Consumes:** 设计文档中的安装包模板、session scope dock、connection fetch registry。
**Produces:** `installHarnessUiBridge(ctx, { registry }) -> disposer`；前端 module id 固定 `dsh-super-computer-use`，与 package name 相同。`registry` 在本任务用无动作 fixture，Task 2 接真实实现。

- [ ] 写 manifest 回归：保留已有 exports，增加 `./client`；`files` 包含 client；`dsh.client.platform === 'web'`，`immediately === true`，inject 包含 conversation 与 connection 所需插件。缺少这些字段时测试应失败。
- [ ] 运行 `node --test test/harness_ui_manifest.mjs`，确认红灯；再按随包 decoration 模板实现，复跑绿灯。从宿主 require React，不捆绑第二份 React，不碰 app root。
- [ ] 使用 `conversation.composer.dock` 注册一个静态 CU 卡片；从宿主 scope props／公开 API 获取 session identity，记录真实字段。不得猜 `props.sessionId` 或用 DOM 文本推断；需要查接口时按随包技能使用 `Slots.listSubTree`／cordis inspection。
- [ ] Host 注册临时 `/api/scu/probe`，精确 GET 路由返回两个相隔 300 ms 的小二进制块；Client 使用 desktop 的受支持 fetch carrier 读取。检查首块不是等 EOF 才收到、abort 释放连接、未认证 401／跨 Origin 403。记录实际 carrier 与调用入口。
- [ ] 在测试 profile 或明确标记的本地插件版本中观察客户端真实激活：两个聊天能显示不同 session identity；深浅色显示正确；卸载后 slot、计时器和路由消失。
- [ ] Gate PASS 后删除 probe route，保留测试及记录。若 FAIL，停止依赖开发，执行 Task 1B。不要把浏览器版成功算作桌面版成功。
- [ ] 检查 diff，提交 `feat: validate Harness CU client integration`。

## Task 1B：仅当 gate 失败，最小宿主适配

**Files:** 在新的 Harness checkout 中定位，不能伪造未见过的源文件路径。已证实包目录 `packages/client/ui-conversation`；其余路径从各包 repository.directory 和源码定位。新增 `docs/reviews/harness-host-adapter.md` 记录准确改动路径与 commit。

**Produces:** Task 1 原有接口和 gate 能通过的最小 slot 或 Fetch carrier 补丁。

- [ ] 获取 `https://github.com/deepseek-ai/deepseek-harness.git`，对齐安装 commit，阅读许可证、AGENTS 和构建文档；若无法取得对应版本，记录阻塞，不改安装包。
- [ ] 根据 gate 唯一失败点写复现测试：缺 slot 才增加 session scope slot；缺 streaming/abort 才修 Desktop carrier。不要同时重写聊天布局、Remote 层或应用主题。
- [ ] 按仓库要求构建独立开发应用与测试 profile；复跑 Task 1 全 gate，记录命令、版本和结果。若依然失败，交付原生 fallback 的明确限制，不声称内嵌完成。
- [ ] 单独提交宿主补丁，记录 SCU/Harness 两仓库版本映射，再返回 Task 2。

## Task 2：会话归属和单一控制 owner

**Files:** 新建 `lib/cu-ui-session.mjs`、`test/cu_ui_session.mjs`；修改 `lib/core.mjs`、`lib/index.mjs`、`lib/action-events.mjs`、`test/action_events.mjs`。

**Interfaces（新增）:**

```js
createCuUiRegistry({ manager, clock })
// claim({hostSessionId}) -> {ok, cuSessionId} | {ok:false,error:'cu_busy'}
// snapshot(hostSessionId) -> CuUiSnapshot
// subscribe(hostSessionId, listener) -> unsubscribe
// control({hostSessionId,cuSessionId,expectedRevision,command}) -> Promise<ControlResult>
// release({hostSessionId,cuSessionId}) -> void
```

`CuUiSnapshot`：`{version:1,revision,hostSessionId,cuSessionId,targetGeneration,target:{pid,windowId,appName}|null,state,label,previewStatus,cleanupState}`。无活动时 cuSessionId 为 null。state 与设计 §3 一致，用稳定英文 enum、locale 显示。

- [ ] 写失败测试：A claim 后 B claim 返回 cu_busy；B stop A 被拒绝；A 结束后 B 能开始；旧 cuSessionId、旧 revision 409；同一次 stop 重复调用幂等；owner 消失停止而非转移控制权。
- [ ] 写事件回归：实际发布的 `batch` 能被 normalize 接受；检查现有 stop 是否发布，如有则补完整语义／测试；统一 adapter/native 的终态归约，失败后迟到 dispatched 不回到 running。
- [ ] 运行 `node --test test/cu_ui_session.mjs test/action_events.mjs` 确认失败后实现 registry；不要把 manager 分裂成多个能同时控制桌面的实例。
- [ ] 在工具开始入口从真实 `exec` 的宿主会话身份 claim，工具、session/end、agent dispose 使用同一归属服务。缺失身份返回明确不可绑定，不能挂到随便一个当前聊天。
- [ ] 为 `publishActionEvent` 增加受控订阅 hook（dispose 可移除），不靠读日志文件刷新 UI。对日志／UI 标签进行脱敏，不回传输入正文。
- [ ] 接入现有停止通路：先关闸门和取消排队，再清理；不能仅执行 stopVisualSession 就假设所有输入终止。明确 cleanupState unknown。
- [ ] 复跑上述测试和 `node --test test/third_review_regressions.mjs`，通过后提交 `feat: bind CU ownership to Harness sessions`。

## Task 3：认证状态与控制桥

**Files:** 完成 `lib/harness-ui-bridge.mjs`；新建 `client/scu-transport.js`、`test/harness_ui_bridge.mjs`。

**Consumes:** Task 2 registry；Task 1 验证的 desktop Fetch carrier。
**Produces:** 设计 §4 的 `/api/scu/state`、`/api/scu/control`，前端 `getState(hostSessionId, signal)`、`control(request, signal)`。

- [ ] 用 Host registry fixture 写失败测试：跨会话、过期 revision、未认证、非 owner Peer、未知 command、非法 JSON、插件卸载均拒绝／清理；错误不能落成 HTTP 200 的假成功状态。
- [ ] `ctx.connection.fetch.register` 使用精确 path、methods、requestBody 和 fetch handler；注册字段按当前宿主实际契约。限制控制 body ≤16 KiB；复用宿主身份检查，不在 UI 持有引擎密钥。
- [ ] state 获取当前快照；control 委托 registry。stop／takeover 不等待模型回复、不排在动作队列末尾。retry 只用于只读 state，禁止自动重放非幂等输入。
- [ ] 前端每 250 ms 拉取 state，前一请求未结束则不重叠；切聊天或卸载 abort。断线显示 reconnecting，恢复后取完整快照，拒绝 revision 回退。
- [ ] 运行 `node --test test/harness_ui_bridge.mjs test/cu_ui_session.mjs`；真实宿主按钮停止验证闸门，记录 P95，不将 mocked 延迟当实测。
- [ ] 提交 `feat: expose authenticated CU state and stop controls`。

## Task 4：有界视频出口与代理

**Files:** 新建 `engine/Sources/PreviewFrameOutput.swift`、`lib/preview-stream.mjs`、`client/preview-decoder.js`、`test/preview_stream_transport.mjs`、`engine/tests/preview_frame_output.py`；修改 `engine/Sources/PreviewCapture.swift`、`engine/Sources/main.swift`、`lib/harness-ui-bridge.mjs`。

**Consumes:** Task 2 owner、当前 target generation；现有 SCStream。
**Produces:** 新命令 `cu preview-stream --window <id> --session <id> --generation <n>`；stdout 只输出设计规定的 length-prefixed 帧，stderr 诊断。`openPreview({hostSessionId,cuSessionId},signal) -> ReadableStream<Uint8Array>`。

- [ ] 先写协议失败测试：任意分块／半包、多帧、超大声明长度、错误 JPEG、旧 generation、慢消费者、EOF／abort。断开后子进程退出；每层待呈现帧最多 1。
- [ ] 用现有 SCStream 回调建立捕获出口；10 fps、最长边 960 px、独立编码队列；不对每帧启动 shot 命令，不阻塞主输入线程。共享可复用捕获代码时保持原生 preview CLI 可用。
- [ ] Host 基于 manager 当前绑定目标启动进程，只代理 stdout；帧长度验证通过才转发，缓冲有上限、拥塞丢旧帧。客户端无法选择 pid/window 或执行 argv。
- [ ] 实现精确 `/api/scu/preview` route：宿主认证、owner 校验、no-store、请求 abort 清理，最后观看者离开停止捕获。目标切换旧 stream 结束，重新绑定新 generation。
- [ ] Client 增量 parser + createImageBitmap，释放旧 bitmap；晚到 decode 丢弃。首帧 1500 ms deadline；2 秒无帧 stale；失败回退至明确标记的原生观看入口，不做高频截图轮询冒充视频。
- [ ] `node --test test/preview_stream_transport.mjs`；`bash engine/build.sh`；`python3 engine/tests/preview_frame_output.py`。测试脚本由本任务创建，使用自有 demo 窗口；实际权限不足记阻塞。
- [ ] 测 30 秒 delivered FPS、CPU、输入延迟开／关对照。失败先修背压与编码成本，再继续 UI。
- [ ] 提交 `feat: stream bounded CU preview frames to Harness`。

## Task 5：观看卡片与展开面板

**Files:** 完成 `client/scu-card.js`、`client/index.js`；新增 `client/scu-store.js`、`client/scu-overlay.js`、`test/cu_ui_store.mjs`；修改 locale。

**Consumes:** state/control 接口、preview decoder；宿主 slot session identity。
**Produces:** `createCuUiStore({hostSessionId,transport})` 的 `getSnapshot/subscribe/dispose`；320 px 卡片及 overlay。

- [ ] 写 store 失败测试：不同聊天隔离、过期 snapshot 丢弃、断线禁用依赖连接的动作、stopping 不等于 stopped、错误 generation 不呈现、隐藏清理所有轮询和视频。
- [ ] store 中管理通信生命周期，React 组件只展示与触发命令；使用宿主支持的 observable/slot hook，或自身 store 的 useSyncExternalStore，不导入宿主私有组件。
- [ ] 卡片显示目标、状态、画面年龄、展开和停止；非 owner 卡片不可操作他人会话。展开时显式携带 owner 到 shell.overlay；关闭只结束观看，不结束执行。
- [ ] 实现主题 token、12 px 圆角、120/180 ms 动画、网页范围毛玻璃。Reduce Motion 关闭移动动画；tab/escape/焦点返回可用；预览无点击转发。
- [ ] `node --test test/cu_ui_store.mjs`；在真实 Harness 截取深浅色、窄窗、展开、停止中、stale 五类状态。确认不覆盖输入区重要按钮，不出现重复 React/root。
- [ ] 提交 `feat: add integrated CU viewer and status card`。

## Task 6：原生回退、完整验收与交付

**Files:** 修改 `lib/core.mjs`、`lib/index.mjs`、`README.md`；新增 `test/cu_viewer_lifecycle.mjs`、`docs/reviews/harness-integrated-cu-acceptance.md`。

**Interfaces:** 新增配置 `viewerMode: 'native'|'embedded'`，先保持 native 默认；embedded 仅在前端握手可用时生效。不自动缩放 DSH；明确用户旧配置优先及迁移说明。

- [ ] 写生命周期回归：embedded 成功时不再启动原生预览窗／胶囊；native 模式不依赖 Client；Client 故障保留一个有效停止入口；unload/owner end/host exit 释放捕获和订阅。
- [ ] 处理默认 autoDockDsh 与内嵌模式冲突，不悄悄移动目标窗口；保留现有其他 Agent 的原生模式。
- [ ] 运行 `npm test`、`bash engine/tests/run_all.sh --quick` 及本计划新测试。若 runner open handle 不退出，诊断并记录；强制退出不算生命周期通过。
- [ ] 在真实 DSH 使用实际模型跑一次“开始→定位→点击→输入→等待→验证→切目标→停止”，另跑第二聊天竞争、目标退出／最小化、权限失败、Host restart、30 分钟资源测试。记录模型／路由及是否支持图片，不混淆模型能力与 UI。
- [ ] 录制 30–60 秒演示；同一场景对照已有 Codex 参考录像，检查操作状态与画面同步。报告实际 FPS、停止延迟、输入 P95 开关对照、CPU/RSS 和残留进程。
- [ ] 核对 installed buildId 与本轮构建、插件软链接、Client 模块版本；保存可还原的配置 diff，经过实际安装后再次验收。不要提交凭证或用户画面到公开仓库。
- [ ] 完成报告按“通过／失败／未测”逐项填写。只有真实宿主完整通过才把 embedded 设置为日常默认；失败保持 native 并记录原因。
- [ ] 提交 `feat: ship verified Harness-integrated CU experience`，交付源码、准确构建步骤、验收记录、演示文件与回滚步骤。

## 给执行 AI 的启动指令

先阅读本计划、Spec 和证据 JSON，再检查当前 AGENTS、git status 与实际版本。只执行本轮内嵌体验范围。先完成 Task 1 gate，不要跳过 Desktop carrier 实测，不要直接补丁安装包。不得把旧报告成绩当作本轮结果，也不得把测试输出存在当作测试通过。遇到 gate 阻塞，给出具体复现和 Task 1B 最小修复，不自行扩大为整套 Harness 重写。
