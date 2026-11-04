# 第四轮修复台账（third-review 后续）

目标：在 `codex-experience` / `4bfe1ca` + 工作区既有 `idleStopSeconds`、`turn/end` 改动之上，修复 R1–R11 并验证。
工作区既有改动（他人）：`lib/core.mjs` `armIdleStop`、`lib/index.mjs` `idleStopSeconds` config / execute 包裹 / `turn/end` hook。**保留，未覆盖、未回退。**

## 基线（已复现，2026-11-04）

- `npm test` → 117/117，0 failed（exit 0）。
- `node docs/reviews/third-review-probes.mjs` → exit 0，8 个 `reproduced:true`。exit 0 表示**缺陷存在**，不是产品通过。
- 缺失：仓库及父目录无 AGENTS.md（已查 `/Users/johnkwok/AGENTS.md`、`/Users/johnkwok/Downloads/work/AGENTS.md`、仓库内 glob）。
- 引擎二进制基线 `engine/bin/cu` sha256 `cbc33d77…`；本机无 `timeout` 命令。
- 已安装服务 `buildId=d0325ebc…`（旧构建）。真实 `cu_*` 工具入口连的是旧构建，不能用来证明本轮新行为。

## 过程记录

- 中途 harness 自动复核（WorkBuddy）429 限流约 2 小时，所有工具调用被拦截；恢复后继续。没有据此宣布完成。
- 新增 `test/third_review_regressions.mjs`（14 项，把探针翻转为期望正确行为）。RED 14/14 → 修复后 **GREEN 14/14**。
- `npm test` 分子集跑通：单元 **120/120**，`test/core.test.mjs`（live service）**11/11**（默认 runner 收尾有 open handle，需 `--test-force-exit`，见"已知限制"）。
- `test/ax_wiring.mjs` 2 项按**有意的新契约**更新：`cu_snapshot` 的 nodes+tokens 同源；`cu_type` 改为 retained 对象单命令输入。
- Swift 引擎已多次 `bash engine/build.sh` 构建通过；新增 `engine/bin/cu` buildId 以各次 `cu status` 为准。

## R 编号 → 修改位置 → 验证证据

| R | 修改位置 | 验证 | 状态 |
|---|---|---|---|
| R1 | `lib/core.mjs` `resolveBoundToken`/`_sameAXTarget`/`_recordAXObservation`；`lib/index.mjs` `cu_click`；`engine/Sources/AXSessionWorker.swift` `bindingMismatch` | 回归测试 R1×3；e2e `crossTargetRefused:true` | 已修+已测 |
| R2 | `lib/index.mjs` `cu_snapshot`（单次 retained observation + `snapshotObservations`）；`AXSessionWorker.swift` `observe` 返回 `nodes`/`observationId`/`frame`；`AXIdentity.swift` `AXCandidate.frame` | 回归 R2；e2e `observationId:"w1-obs1"`,`elementTokens:true` | 已修+已测 |
| R3 | `lib/core.mjs` `axInput`；`lib/index.mjs` `cu_type`；`AXSessionWorker.swift` `input()`（同一命令校验+写值） | 回归 R3×2；e2e `retainedInputVerified:true` | 已修+已测 |
| R4 | `lib/core.mjs` `_ensureAXWorkerReader`（requestId 常驻 reader）、`_axRequest`、`_invalidateAXWorkerAfterTimeout`；`AXSessionWorker.swift` 回显 `requestId` | 回归 R4×2 | 已修+已测（模拟）；真实 worker 超时未单测 |
| R5 | `lib/core.mjs` `exec`（generation/gate）、`stopVisualSession`（先关闸门）；`index.mjs` 控制通路 `{control:true}` | 回归 R5×2；e2e `queuedCancelled:true`,`inputGateClosed:true`,`cleanupState:"unknown"`；`service_responsiveness.py` | 已修+已测；原生按键释放收尾仍 unknown |
| R6 | `lib/index.mjs` `capturePreviewObject`（`bypassQueue` + deadline abort 在途 shot） | 回归 R6（下一动作 <80ms） | 已修+已测 |
| R7 | `lib/core.mjs` `startNativePreview`/`setNativePreviewVisible`/`stopNativePreview`/`switchNativePreview`；`startVisualSession`；`index.mjs` `cu_session` start/resume/visible；`main.swift` `PreviewChild`；`PreviewCapture.swift` 首帧 1500ms 静态降级 | `preview_target_switch.py`、`preview_first_frame_fallback.py`；e2e `previewStarted:true` | 已修+已测（启动/切目标/停止/首帧降级）；隐藏/恢复由既有 `preview_control.py` 覆盖 |
| R8 | `main.swift` `PreviewChild`（EOF/stop 清理）+ `CU_PREVIEW_OWNED_BY_HELPER`；`PreviewCapture.swift` 子进程 EOF 退出 | `helper_eof_cleanup.py`（parentExited:true, survivors:[]） | 已修+已测 |
| R9 | `main.swift` `runEngineNDJSON` + `/v1/exec` `eventsVersion`/`eventContext`；native `--events-v1` 补 type/key/scroll/drag/setvalue；`index.mjs` `execWithNativeEvents` + 全动作 `publishPhase`；`action-events.mjs` KINDS 增 batch/stop | `action_event_stream.py`（click/expect/type/key/scroll）、`service_ndjson.py`；e2e `nativeKinds:[click,key,scroll]` | 已修+已测；batch/stop 为 adapter 来源 |
| R10 | `lib/index.mjs` `cu_click`（非 left/非 1 次 → `unsupported_click_semantics`） | 回归 R10×2；e2e `unsupportedSemantics:true` | 已修+已测 |
| R11 | `main.swift` `VisualMailbox`（主线程前有界 mailbox，cursor/label 合并最新，瞬态队列 ≤64，终止即时）+ `RenderAck`；`VisualFeedback.swift` 未改 | `visual_mailbox.py`（applied:64, dropped:436, ack clock/order ok） | 已修+已测；firstVisible 仍未测(null) |

## 同一构建集成证据

`node engine/tests/e2e_fourth_round.mjs`（隔离 service + 自有 demo，真实工具定义）：
buildId `0078f89b…`；previewStarted、observationId、elementTokens、crossTargetRefused、unsupportedSemantics、clickVerified、retainedInputVerified、queuedCancelled、inputGateClosed、previewChildrenAfterStop:0、nativeKinds[click,key,scroll] 全部通过；28 事件（native 6 / adapter 22）。

`node engine/tests/e2e_fourth_round_demo.mjs 34`：同一构建生成 `docs/reviews/fourth-round-demo.mov`、`fourth-round-demo-events.jsonl`、`fourth-round-demo-result.json`。

## 已知限制 / 未测

- `firstVisibleMs`：无屏幕帧分析设施，**未测，记 null**；`renderCommittedMs` 虽有 RenderAck，但未接入测量管线，记 null；`commandWrittenMs` 未测。
- `test/core.test.mjs` 在默认 `node --test` 下测试全过但进程不退出（open handle），需 `--test-force-exit`；未进一步定位是否为本轮引入。
- 原生在途输入的按键/鼠标释放与所有后代进程收尾**仍报 unknown**，未伪造 complete。
- 模型 + DSH 端到端完成率、多显示器（混合缩放/热插拔/全屏 Space）、30 分钟长跑：**未测**。
- 已安装 app/日常服务仍是旧构建 `d0325ebc…`，未重装（按要求）；真实 `cu_*` 工具入口连旧构建。
- `cu_type` 带 ref 且有 retained token 时，现在用 AX 写值（`setvalue` 语义），不再逐键 `type`；这是有意的原子性取舍，已在验收文档注明。

## 决策 / Ruling

- R10：retained-token 点击只支持单次左键 `AXPress`；右击/双击**显式拒绝**（不静默丢参数、不按几何补发鼠标事件），与"不支持时明确返回错误"一致。坐标入口的右击/双击不受影响。
- R3：token 输入统一为"同一原生命令校验+写值"，避免 verify 与写入之间的竞态；`mode:'type'` 在 token 路径同样走写值。
- R11：RenderAck 只表示"收到+图层事务提交"，**不命名为首帧可见**；firstVisible 保持 null。
- 预览 EOF 清理用 `CU_PREVIEW_OWNED_BY_HELPER` 环境变量区分 helper 子进程与独立 `cu preview` CLI，避免独立 CLI 因 stdin EOF 误退出（`preview_panel.py` 曾因此失败，已修复）。
