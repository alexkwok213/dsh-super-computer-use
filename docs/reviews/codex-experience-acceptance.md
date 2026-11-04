# Super Computer Use · 综合验收与交付报告（2026-11-04 最终修复版）

> 本文件是统一验收结论文档，消除旧报告中 103/115/117 测试数矛盾、Task 7/8 既称“部分完成”又称“未实现”、以及录像仅含 56 条点击事件等不一致之处。
> 原则：**证据先于断言，未测如实标为 null/未测，不将工具返回值 ok:true 等同于业务完成，不以“测试全绿”掩盖未覆盖路径。**

构建身份：`engine/bin/cu`（SHA-256 / buildId：`0078f89bd85f22c9f0788584d1e573bc01a746d8964c4500c0ca220bb06f6216`）
底座环境：macOS (darwin 26.0.0)，单显示器（内置 Retina 3456×2234 @2x），Node v26.0.0，Apple Swift 6.3.1，部署目标 `arm64-apple-macos14.0`。
基线分支：`codex-experience`，审查基线提交 `4bfe1ca`。工作区他人未提交改动（`idleStopSeconds`、`turn/end` hook）已完整保留。

---

## 1. 自动化测试套件执行证据

| 测试套件 | 命令 | 结果 | 说明 |
|---|---|---|---|
| 新增审查缺陷回归 | `node --test test/third_review_regressions.mjs` | **14/14 通过 (100%)** | 覆盖 R1–R6、R9、R10。复现缺陷 RED 14/14 → 修复后 GREEN 14/14 |
| 仓库纯单元测试 | `node --test test/action_events.mjs test/ax_wiring.mjs ... (15 文件)` | **120/120 通过 (100%)** | 覆盖目标整体解析、deadline、事件规范、AX 绑定、取消、生命周期等 |
| 本地服务集成回归 | `node --test --test-force-exit test/core.test.mjs` | **11/11 通过 (100%)** | 真实本地服务 + demo 窗口端到端交互、DSH 插件注册、窗口停靠与恢复 |
| 协议与数据流原生测试 | `python3 -B engine/tests/service_ndjson.py` | **通过 (exit 0)** | 验证 `/v1/exec` 接受 `eventsVersion:1` 并以分块 chunked NDJSON 实时转发原生事件 |
| 原生阶段事件流测试 | `python3 -B engine/tests/action_event_stream.py` | **通过 (exit 0)** | 验证 click, expect, type, key, scroll 的 `targetReady→dispatched` 均在终态前发出，默认 CLI 保持单 JSON |
| 视觉有界调度与回执 | `python3 -B engine/tests/visual_mailbox.py` | **通过 (exit 0)** | 500 突发瞬态指令限制在 ≤64 队列内，丢弃 436 条过时瞬态，提交并输出 `renderAck` |
| 原生预览目标切换 | `python3 -B engine/tests/preview_target_switch.py` | **通过 (exit 0)** | 切换到新窗口时老预览子进程被精确结束，新预览窗口成功绑定，无孤儿进程 |
| 原生预览子进程生命周期 | `python3 -B engine/tests/helper_eof_cleanup.py` | **通过 (exit 0)** | 父 helper EOF 或异常退出时，自建的 preview 子进程立即退出，存活数为 0 (R8) |
| 首帧失败静态降级 | `python3 -B engine/tests/preview_first_frame_fallback.py` | **通过 (exit 0)** | 模拟流式捕获在 1500 ms 内无帧回调，确定性降级为带 `static-fallback` 状态的静态帧 |
| 离屏与几何系列测试 | `visual_event_view.py`、`aura_view.py`、`preview_geometry.py`、`preview_panel.py`、`ax_identity.py` 等 | **全部通过 (exit 0)** | 验证边缘光、字素裁剪、单屏几何、AX 身份、窗口重排定向至原对象等离屏规则 |
| 仓库统一全量快速回归 | `bash engine/tests/run_all.sh --quick` | **通过 (exit 0)** | 引擎各底层子集 0 failed |

---

## 2. 审查缺陷（R1–R11）处理状态与修改位置

| 审查项 | 处理状态 | 核心代码修改位置 | 关键验证证据 |
|---|---|---|---|
| **R1**：跨目标 token 点击 | **已解决** | `lib/core.mjs` (`resolveBoundToken`, `_sameAXTarget`)<br>`lib/index.mjs` (`cu_click`)<br>`engine/Sources/AXSessionWorker.swift` (`bindingMismatch`) | `test/third_review_regressions.mjs`：A 目标 token 显式发往 B 目标（或同 pid 不同 window）均明确返回错误，禁止路径误点；`e2e_fourth_round.mjs` 实测拒绝 |
| **R2**：展示节点与 token 来自两次观察 | **已解决** | `lib/index.mjs` (`cu_snapshot`)<br>`engine/Sources/AXSessionWorker.swift` (`observeAndRetain`, `runAXWorker`)<br>`AXIdentity.swift` (`AXCandidate.frame`) | `cu_snapshot` worker 路径改为**单次 retained observation** 同时返回带 frame 的 nodes 和 tokens，赋予唯一 `observationId`，不再二次遍历拼接 |
| **R3**：验证异常放行与路径回退竞态 | **已解决** | `lib/core.mjs` (`axInput`)<br>`lib/index.mjs` (`cu_type`)<br>`engine/Sources/AXSessionWorker.swift` (`input`) | `cu_type` token 分支将身份校验与 `AXSetAttributeValue` 合并为**单条原生命令**；异常立即终止输入，不回退按路径向替代对象输入 |
| **R4**：worker 超时后迟到响应错配与不明重放 | **已解决** | `lib/core.mjs` (`_ensureAXWorkerReader`, `_axRequest`, `_invalidateAXWorkerAfterTimeout`)<br>`AXSessionWorker.swift` (`requestId` 回显) | 常驻单一 reader，所有请求携带唯一 `requestId` 并按 ID 路由，过期/迟到行直接丢弃；超时立即销毁 worker 使旧 token 失效，标记 `outcomeUnknown: true, actionReplaySafe: false` |
| **R5**：停止后排队动作继续执行 | **已解决** | `lib/core.mjs` (`exec`, `stopVisualSession`)<br>`lib/index.mjs` (`{control: true}`) | `stopVisualSession` 率先关闭 `inputGateClosed` 并递增 `sessionGeneration`，排队动作出队时直接返回 `cancelled/outcomeUnknown`，不进入执行链路 |
| **R6**：预览超时阻塞动作队列 | **已解决** | `lib/index.mjs` (`capturePreviewObject`)<br>`lib/core.mjs` (`exec` 的 `bypassQueue`) | 预览读取通过 `bypassQueue: true` 彻底脱离动作串行队列；`captureController` 在预算耗尽时主动 abort 在途的 fallback 抓图 |
| **R7**：原生观看预览接入插件会话入口 | **已解决** | `lib/core.mjs` (`startNativePreview`, `setNativePreviewVisible`, `stopNativePreview`, `switchNativePreview`)<br>`lib/index.mjs` (`cu_session`)<br>`main.swift` (`PreviewChild`)<br>`PreviewCapture.swift` (1500ms 降级) | 真实 `cu_session` 启停、恢复、目标切换均通过 helper 控制原生预览卡片；流超时 1500 ms 确定性降级为静态帧（`preview_first_frame_fallback.py` 实测） |
| **R8**：helper EOF/异常退出遗留子进程 | **已解决** | `engine/Sources/main.swift` (`runCursorOverlay` EOF 清理)<br>`engine/Sources/PreviewCapture.swift` (stdin EOF 清理)<br>`CU_PREVIEW_OWNED_BY_HELPER` 环境变量 | `helper_eof_cleanup.py` 实测：关闭 helper stdin 后，父进程退出，preview 子进程存活数为 0。仅清理自身创建 PID，禁止全局 pkill |
| **R9**：native 事件贯通服务/manager/renderer | **已解决** | `engine/Sources/main.swift` (`runEngineNDJSON`, `/v1/exec`)<br>`engine/Sources/main.swift` (click, type, key, scroll, drag 原生派发点事件)<br>`lib/index.mjs` (`execWithNativeEvents`, 全动作 `publishPhase`) | `/v1/exec` 增加分块 NDJSON 流；click, key, scroll, type 均可在派发边界产出原生阶段；`service_ndjson.py` 与 e2e 日志证实原生事件流存在 |
| **R10**：token click 丢失公开语义 | **已解决** | `lib/index.mjs` (`cu_click`) | 对非 left 或 count!=1 的 token click 显式拒绝并返回 `unsupported_click_semantics`；坐标入口保持完整语义 |
| **R11**：主线程有界 mailbox 与 RenderAck | **已解决** | `engine/Sources/main.swift` (`VisualMailbox`) | 进入主线程前设立容量上限 64 的 mailbox，cursor/label 实时合并为最新值，瞬态过多时丢弃老事件；提交后向 stdout 发送 `renderAck` (包含 committedAtNs、dropped 等) |

---

## 3. 同一构建集成与实操演示成果

*本次验证采用同一构建 `buildId=0078f89bd85f22c9f0788584d1e573bc01a746d8964c4500c0ca220bb06f6216`（对应当前工作树最新源码），避免旧版本散乱测试导致数据失真。*

### 3.1 端到端多动作验证（`engine/tests/e2e_fourth_round.mjs`）
- **覆盖动作**：`cu_session` start → `cu_snapshot` (验证 `observationId` + `elementTokens`) → 跨目标调用拒绝 (R1) → 右键双击拒绝 (R10) → `cu_click` (带 expect 验证计数器 0→1) → `cu_type` (retained input 校验并写值) → 坐标 click / key / scroll → 排队 stop 拦截 (R5) → `cu_session` stop (验证无遗留预览后代)。
- **结果**：全项断言通过，退出码 0。输出包含 28 条事件（原生 6 条，适配器 22 条），`nativeKinds: ["click", "key", "scroll"]`。

### 3.2 演示录像与真实事件日志（`engine/tests/e2e_fourth_round_demo.mjs`）
- **录像文件**：`docs/reviews/fourth-round-demo.mov`
  - 格式：H.264, 1040×940（Retina 2x 录制 demo 窗口专属区域，不录制用户其它桌面内容），48.5~60 fps。
  - 时长：**39.00 秒**（完全符合 30–60 秒要求）。
  - 文件大小：**6.5 MB (6,833,475 bytes)**。
- **关联事件日志**：`docs/reviews/fourth-round-demo-events.jsonl`
  - 事件条数：**512 条**（与录像同一次运行产生）。
  - 来源统计：`native`: 106 条，`adapter`: 406 条。
  - 动作种类：`click`: 128 条，`type`: 96 条，`key`: 144 条，`scroll`: 144 条。
  - 失败路径验证（录像镜头内触发）：
    - `crossTargetRefused`: 2 次
    - `unsupportedSemantics`: 2 次
    - `queuedCancelled`: 1 次
- **元数据摘要**：`docs/reviews/fourth-round-demo-result.json`。

### 3.3 呈现与延迟测量（真实口径）
按规范要求，将三项时间戳严格分离，绝不拿回调时刻或写管道时刻充当首帧上屏时刻：
- `commandWrittenMs`：记录写入 helper 管道的时刻（微基准实测 P50 ≤ 1 ms）。
- `renderCommittedMs`：记录图层事务提交并返回 `renderAck` 的时刻（本机 mailbox 离屏验证 commit 延后于 receive，但端到端未接入插桩链路，**如实标为 null**）。
- `firstVisibleMs`：真实屏幕像素点亮上屏时间（因无专用高速外部相机或屏幕抓帧分析器，**必须如实标为 null**，绝不填 0 ms 制造假象）。

---

## 4. 真实通过、失败与未测清单

### 4.1 实际通过项（Verified PASS）
1. 身份链完整性（R1–R4）：跨目标/跨窗口拒绝、单次观察同源、retained 独占原子写入、worker 超时销毁与 requestId 过滤。
2. 停止与生命周期可靠性（R5, R6, R8）：停止闸门前置拦截、预览脱离串行队列与超时 abort、helper 退出自动回收自建 preview。
3. 动画与事件链路（R7, R9–R11）：原生预览会话接线与降级、多动作原生阶段事件流、右键/双击参数校验拒绝、主线程前有界 mailbox（≤64 队列与 drop 计数）及 renderAck。
4. 单元与回归套件：14 项针对性回归全部通过，120 项单元测试全部通过。
5. 同一构建完整交付：生成了 39 秒标准录像及包含原生事件的 512 条日志。

### 4.2 实际失败项（Failed）
- 无（本轮针对 R1–R11 编写的失败重现测试已全部转为 GREEN 通过）。

### 4.3 明确未测项（Untested，不得计入完成成绩）
1. **真实大模型 + DSH 宿主端到端完成率**：本机全部验证均基于真实工具层、协议栈及 demo 应用驱动，未连接大模型跑完多轮业务任务。
2. **硬件多显示器特性**：混合缩放、负坐标、屏幕空隙、热插拔、全屏 Space 仅在离屏几何断言中通过，**未在真实多台物理显示器上测试**。
3. **真实上屏可见延迟（`firstVisibleMs`）**：缺乏光学/显示器垂直同步硬件抓帧观测，保持为 null。
4. **长时间（30 分钟）资源稳定性与泄漏**：未执行 30 分钟连续跑批（为避免长期独占并干扰开发桌面）。
5. **`bench/run.mjs` 隔离服务基准**：本轮未取得可用基准。诊断结果：直接引擎 CLI 连打 `snapshot --pid --window` **30/30 成功**，工具层 + 显式二进制 + 隔离服务循环 **10/10 成功**；但 `bench/run.mjs` 自建 demo（经 `resolveBinaryPath()`）与隔离服务配对时，间歇返回 `window_scope_unavailable` 或 `cancelled`，属 bench harness 的 demo/service 生命周期问题，**不是 R1–R11 修复路径**。为避免把红色样本当基准，本轮**不提交 bench JSON**，该项记未测。

---

## 5. 剩余限制及下一步建议

1. **日常应用生效需用户显式重装**
   本轮修改全在仓库源码内完成，并通过构建独立产物 `engine/bin/cu` 与独立端口服务进行全面验证。日常使用的 `/Applications/Computer Use.app` 与 `~/Library/Application Support/cu/bin/cu` 仍为旧构建 `d0325ebc…`。按安全与隔离规范未自动执行覆盖安装。后续用户若需在主程序中使用，执行 `./install-app.sh` 即可。
2. **`cu_type` 语义细化**
   对于传入 `ref` 且命中 retained token 的输入，现采用原子 AXValue 设值以根治路径竞态；如果未来必须支持富文本逐字敲击并触发特定前端按键事件，可进一步扩展 `ax-worker` 原生输入模式。
3. **多目标平滑交叉淡化**
   当前切换目标采用停用老预览子进程、拉起新预览子进程（`preview_target_switch.py` 证实单进程干净切换）；若需实现像素级两帧渐变交叉淡化，未来可重构为单个常驻 controller 内切换捕获源。
