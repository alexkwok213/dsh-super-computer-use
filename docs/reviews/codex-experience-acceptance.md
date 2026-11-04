# Codex 式体验 · 实施验收记录（2026-11-04 计划）

本文件按计划 Task 9 要求，逐项记录「通过 / 失败 / 未测」，并明确区分**已实现并有测试证据**、**已实现但仅单屏验证**、**尚未实现**。原则：未测就是未测，不写 0 ms，不把工具 ok 当业务成功。

构建身份：`engine/bin/cu`（ad-hoc / 本地签名，SHA-256 由 `cu status` 的 `buildId` 给出）。底座：macOS，单显示器（本机），Node v26，Swift 6.3.1，部署目标 `arm64-apple-macos14.0`。

## 1. 自动化回归（可复跑）

| 命令 | 结果 |
|---|---|
| `npm test` | **103/103 通过** |
| `bash engine/tests/run_prototypes.sh` | 通过（ControlLease / ProcessSupervisor） |
| `python3 -B engine/tests/service_responsiveness.py` | 通过（长 expect 期间 status 24 ms、pause 1 ms、gate 关闭、新输入被拒） |
| `python3 -B engine/tests/action_event_stream.py` | 通过（click `targetReady→dispatched→result`，expect `targetReady→verified`，默认单 JSON） |
| `python3 -B engine/tests/visual_event_view.py` | 通过（rim 持久、10→1 调度、Reduce-Motion 4→0 动画、字素 28、单屏几何负坐标/空隙） |
| `python3 -B engine/tests/aura_view.py` | 通过（边缘光 ≤65pt 四边、中心透明、淡出） |
| `bash engine/build.sh`（**仓库根目录**执行） | 通过（已修复 `$0` 二次 `cd` 的旧问题） |
| `bash engine/tests/run_all.sh --quick` | 通过（connection / batch / expect / observe / import / server / execution / state_adapter / import_flow / indicator 各子集均 0 failed） |

## 2. 按任务验收

| 计划任务 | 状态 | 证据 / 说明 |
|---|---|---|
| Task 1 目标整体解析 + schema（F1/F8） | **通过** | `test/target_resolution.mjs`；原生 demo 不匹配 → `target_mismatch` 且计数器不变 |
| Task 2 预览链共享 deadline（F3/F7） | **通过** | `test/preview_budget.mjs` RED→GREEN；超时不幽灵 shot、慢附件不写 `lastImage`、四路径互斥 |
| Task 3 状态/停止独立通路（F2） | **通过（核心）** | `service_responsiveness.py` 2310 ms→24 ms；拖拽中输入持有释放与后代进程清理**未测**（账本已记） |
| Task 4 统一动作事件 + native 流（M1） | **通过** | `test/action_events.mjs` + `action_event_stream.py`；服务端 `/v1/exec` 分块 NDJSON 转发**未做**（JS 已安全回退单 JSON） |
| Task 5 常驻可打断多屏动画（M1/F6） | **通过（单屏）** | rim 持久 + 默认关、latest-wins 调度、Reduce-Motion 拆除、字素标签、per-display 面板、类迁出；**多显示器真机（混合缩放/上下错位/热插拔）未测** |
| Task 6 基准纠正 + 呈现测量（F5） | **通过** | `bench/results.mjs` + 真实 demo（click 2/2 计数变化）；`firstVisibleMs` 在本机**未测**（如实标 untested，非 0） |
| Task 7 原生观看预览（M2 / SCK） | **部分（核心通过）** | 几何/降级契约离屏通过；`PreviewCapture` 真实 SCStream 抓窗口（首帧 68 ms）；**可见预览卡片** `cu preview`（AVSampleBufferDisplayLayer，`cu windows` 见 `cu preview`，首帧 73 ms、88 帧）；**visible/stop/status 控制协议**：隐藏暂停抓流实测 **pausedGrowth=0**，恢复后续抓到 35 帧。**静态帧回退**已实现并测：`cu preview --static` 用 SCScreenshotManager 取单帧静态显示（demo 520×502、155 ms、卡片上屏），非逐帧循环。**120 ms 卡片淡入**已实现并有离屏测试（`preview_card_anim.py` before/after）。**并入 cursor helper** 已完成：cursor-overlay 的 stdin 新增 `preview.start/visible/stop`，start 生成子进程 `cu preview`、visible 转发、stop 结束（`helper_preview_control.py`：spawned/stopped 均 true）。剩：目标切换交叉淡化、30 分钟资源**未测**。 |
| Task 8 持续 AX 身份（M3 / F4） | **部分** | `AXIdentity.swift` 身份契约离屏通过：`elementToken`(opaque)+epoch+pid+window+container 绑定；epoch 重建→`epoch_rebuilt`，换应用/窗口→`stale_target`，同名控件换对象/容器或改标题→`identity_unproven`，仅 snapshotRevision 变化仍 `matched`，路径相同**不**等于身份。`resolveDispatchTarget` 离屏验证：同名控件重排后仍按 elementToken 作用于**原对象**、对象消失则拒绝，绝不按路径误点；ambiguous/disabled/换窗口/换容器均拒绝。**常驻 `AXSessionWorker` 已实现并 demo 验证**：retain 真实 AXUIElement → 派发前按对象自身校验 → AXPress，计数器 0→1；**重新观察后旧 token 仍作用于原对象**（0→1→2，证明身份不是路径）；**改名安全**（同对象改 label 仍 matched，title 只作提示）；`invalidate()`(epoch 重建)后旧 token 被拒 `identity_unproven`。另加**常驻 `ax-worker` 子命令**（stdin：observe/click/invalidate/stop，进程内保留 epoch 与对象）：一次 observe 的 token 由后续 click 派发（计数器 0→1），re-observe 后旧 token 仍 1→2，伪 token 与 invalidate 后均 `identity_unproven`。JS 侧已接：真实会话 `cu_snapshot` 附带 `elementTokens`，`cu_click(ref)` 有 token 时走 worker 派发、身份被拒**不回退按路径点击**（`test/ax_wiring.mjs` 4 项）；无会话时回退旧 snapshotId 路径。`cu_type(ref)` 先对 retained token 做 `verify`（不动作）再输入，身份被拒则**不输入**；原生 worker 的 `verify` 命令在常驻测试中对 retained token 通过、对伪 token 拒绝。AX worker 绑定单一目标、切换目标即重启（旧 token 不跨目标复用），已测。AXObserver 通知失效仍缺，但派发前对 retained 对象**即时校验**，正确性不依赖通知（通知只是提前失效的优化，**未测**）。**在途取消**已实现：`stopVisualSession` 调 `cancelInFlight()` abort 在途 `exec`，被取消的动作返回 `cancelled` + `outcomeUnknown:true`（不谎称未执行）；外部 abort 亦然（`test/inflight_cancel.mjs` 4 项）。 |
| Task 9 宿主集成 / 录像 | **部分** | 本记录 + 回归 + build 修复完成；**真实 DSH 大模型端到端任务、30–60 s 演示录像、30 分钟长跑资源**，未测 |

## 3. 明确未测项（不得当作成绩）

- 真实大模型 + DSH 宿主 + 真实业务应用的端到端完成率与任务时间：**未测**（本机仅有引擎/适配层回归与 demo）。
- 60 Hz 呈现帧间隔、首帧可见延迟（`firstVisibleMs`）：**未测**（无屏幕帧分析设施；`bench/visual-latency.mjs` 只报 `commandWrittenMs`，其余为 null）。
- 多显示器：混合缩放、负坐标、屏幕空隙、热插拔、全屏 Space：仅**单屏几何**离屏断言通过，真机多屏**未测**。
- 拖拽中停止的输入持有释放、后代进程资源清理、30 分钟长跑资源稳定性：**未测**。
- Task 7（连续观看预览）与 Task 8（真实控件身份）：**未实现**，因此 M2/M3 未能宣称达成。

## 4. 结论

M0（可信基础：F1/F2/F3/F7/F8）与 M1 的可测试部分（F5/F6 + 统一事件 + 常驻可打断视觉）已落地并有失败→通过证据；M1 的多屏真机验收、M2（观看预览）、M3（真实身份）**尚未完成**。本记录如实反映，不将未测项标为已完成。

## 5. 实测基线（本机 demo，隔离服务）

`node bench/run.mjs --runs 2 --json docs/reviews/codex-experience-bench.json`（时间所限 2 轮/任务，非计划建议的 20 轮；完整原始样本已保存）。构建 `buildId=09a3ca53…`。所有任务均为真实 demo，成功由计数/唯一 token 判定，`firstVisibleMs` 因无屏幕帧分析记为 **untested(null)**，不是 0。

| 任务 | 成功 | P50 ms | P95 ms |
|---|---|---|---|
| AX snapshot | 2/2 | 190 | 617 |
| click by ref（计数必须变化） | 2/2 | 357 | 379 |
| type 唯一 token + expect | 2/2 | 568 | 590 |
| batch click→key | 2/2 | 445 | 490 |
| screenshot preview | 2/2 | 304 | 328 |
| stop in-flight（受理/收尾） | 2/2 | 0 | 0 |

说明：修了一个 bench 取窗缺陷——它曾把 `windowId 0` 的离屏/应用级条目当成 demo 窗口，导致多数任务 0/2；现要求 `windowId>0 && !offStage`。此为本地执行微基准，不含模型/宿主，不能当业务成功率或端到端模型对比。

## 6. 构建身份核对（Task 9）

| 产物 | SHA-256 | 说明 |
|---|---|---|
| `engine/bin/cu`（仓库构建） | `598b5923b67b45c599456603974a235bd8b537b3604f76bd877aed261e95d177` | 与本次隔离启动的 service 的 `buildId` **一致**，accessibility/screenRecording 均 true（开发目录路径一致） |
| `/Applications/Computer Use.app/…/Computer Use` | `51986b7300f3b1512210bd322522c46016a80446d3cb47280e00859f4bf8ae5a` | **落后于仓库构建** |
| `~/Library/Application Support/cu/bin/cu` | `51986b73…`（同上） | 安装/日常服务指向的旧构建 |

签名：`Identifier=cu`、`TeamIdentifier=65JNWZ4UK4`。

**结论**：仓库构建与「从仓库二进制启动的 service」一致，但**已安装 app / 日常服务仍是旧构建**。本轮所有新能力要在日常使用中生效，须由用户重新安装（`engine/install-app.sh` / `package-plugin.sh`）——这涉及签名身份与 TCC，按计划约束**不自动执行**，仅记录。开发目录验证与安装验证分别记录，不混为一谈。

## 7. 复跑命令与续跑说明（handoff）

**全绿复跑（本机，2026-11-04 最后一轮）**

- `npm test` → 115/115
- `bash engine/tests/run_all.sh --quick` → exit 0（各子集 0 failed）
- `bash engine/build.sh`（仓库根）→ 通过
- 原生批均 exit 0：`service_responsiveness` / `action_event_stream` / `preview_stream` / `preview_panel` / `preview_control` / `preview_static` / `visual_event_view` / `aura_view` / `ax_worker` / `ax_worker_resident` / `preview_geometry` / `preview_card_anim` / `ax_identity` / `ax_dispatch_resolution` / `helper_preview_control`

**要看到本轮改动，需先重装**（当前安装产物是旧构建，见 §6）：`engine/install-app.sh` / `engine/package-plugin.sh`。重装涉及签名身份与 TCC，未自动执行。

**仍未完成（需真机/宿主，环境无法在本机代跑）**

1. Task 7 目标切换交叉淡化：当前架构是「每个目标一个独立 `cu preview` 进程」，跨进程无法交叉淡化；要做需改成单预览进程内切流，属架构改动，**未做**。30 分钟长跑资源：**未测**。
2. Task 8 AXObserver 通知失效：正确性已由「派发前对 retained 对象即时校验」保证，AXObserver 只是提前失效的优化，**未测**。
3. Task 9 真实 DSH 宿主 + 大模型端到端任务、30–60 s 演示录像、30 分钟资源曲线：**未测**。

**推荐续跑顺序**：重装 → 真实会话里跑「开始→定位→点击→输入→等待→验证→停止」并录 30–60 s → 记录事件 JSONL 与耗时 → 按 §10 固定任务集填「通过/失败/未测」。
