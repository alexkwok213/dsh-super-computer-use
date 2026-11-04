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

## 2. 按任务验收

| 计划任务 | 状态 | 证据 / 说明 |
|---|---|---|
| Task 1 目标整体解析 + schema（F1/F8） | **通过** | `test/target_resolution.mjs`；原生 demo 不匹配 → `target_mismatch` 且计数器不变 |
| Task 2 预览链共享 deadline（F3/F7） | **通过** | `test/preview_budget.mjs` RED→GREEN；超时不幽灵 shot、慢附件不写 `lastImage`、四路径互斥 |
| Task 3 状态/停止独立通路（F2） | **通过（核心）** | `service_responsiveness.py` 2310 ms→24 ms；拖拽中输入持有释放与后代进程清理**未测**（账本已记） |
| Task 4 统一动作事件 + native 流（M1） | **通过** | `test/action_events.mjs` + `action_event_stream.py`；服务端 `/v1/exec` 分块 NDJSON 转发**未做**（JS 已安全回退单 JSON） |
| Task 5 常驻可打断多屏动画（M1/F6） | **通过（单屏）** | rim 持久 + 默认关、latest-wins 调度、Reduce-Motion 拆除、字素标签、per-display 面板、类迁出；**多显示器真机（混合缩放/上下错位/热插拔）未测** |
| Task 6 基准纠正 + 呈现测量（F5） | **通过** | `bench/results.mjs` + 真实 demo（click 2/2 计数变化）；`firstVisibleMs` 在本机**未测**（如实标 untested，非 0） |
| Task 7 原生观看预览（M2 / SCK） | **部分** | 已加 `PreviewController.swift` 的几何/降级契约（letterbox、`offset+(point-origin)*scale`、无首帧/最小化/隐藏/退出=不可用、代际/几何不符=stale）与 `engine/tests/preview_geometry.py`（离屏通过）；本机 SCK 首帧实测 **134 ms**（≤1500 ms）。**连续预览面板 / AVSampleBufferDisplayLayer / preview.start-stop 协议未接**。 |
| Task 8 持续 AX 身份（M3 / F4） | **未实现** | `AXSessionWorker.swift`、elementToken 身份校验未开发 |
| Task 9 宿主集成 / 录像 | **部分** | 本记录 + 回归 + build 修复完成；**真实 DSH 大模型端到端任务、30–60 s 演示录像、30 分钟长跑资源**，未测 |

## 3. 明确未测项（不得当作成绩）

- 真实大模型 + DSH 宿主 + 真实业务应用的端到端完成率与任务时间：**未测**（本机仅有引擎/适配层回归与 demo）。
- 60 Hz 呈现帧间隔、首帧可见延迟（`firstVisibleMs`）：**未测**（无屏幕帧分析设施；`bench/visual-latency.mjs` 只报 `commandWrittenMs`，其余为 null）。
- 多显示器：混合缩放、负坐标、屏幕空隙、热插拔、全屏 Space：仅**单屏几何**离屏断言通过，真机多屏**未测**。
- 拖拽中停止的输入持有释放、后代进程资源清理、30 分钟长跑资源稳定性：**未测**。
- Task 7（连续观看预览）与 Task 8（真实控件身份）：**未实现**，因此 M2/M3 未能宣称达成。

## 4. 结论

M0（可信基础：F1/F2/F3/F7/F8）与 M1 的可测试部分（F5/F6 + 统一事件 + 常驻可打断视觉）已落地并有失败→通过证据；M1 的多屏真机验收、M2（观看预览）、M3（真实身份）**尚未完成**。本记录如实反映，不将未测项标为已完成。
