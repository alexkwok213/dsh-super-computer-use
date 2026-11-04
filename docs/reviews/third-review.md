# Codex 式体验交付复查与修复任务单

审查日期：2026-11-04。结论：**已有实质进步，但不能按“9 项全部完成”验收；建议修复下述阻断问题后再合并为完成版。**

审查基线为 `codex-experience` 的 `4bfe1ca`，相对 `8e1f6ce` 共 39 个提交。审查开始时工作树干净。过程中 `lib/core.mjs`、`lib/index.mjs` 出现其他工作产生的 `idleStopSeconds`、`turn/end` 清理 hook 等未提交修改，仍在继续变化；本审查没有改动或验收它们。8 个逻辑复现随后在 `git archive 4bfe1ca` 的独立目录重新运行，避免混用版本。下文源码行号均指 **4bfe1ca**，当前工作树行号可能变化。

本轮交付是审查、复现和修复建议，没有修改产品实现、提交、合并或重装应用。

**证据与边界**

| 检查 | 本轮结果 | 能证明的范围 |
|---|---|---|
| `npm test` | 117/117，通过，0 failed | 现有测试通过；不代表未覆盖的路径正确。首次沙箱运行的两项本机连接 EPERM，放行本机连接后重跑通过 |
| 已安装服务，长 expect 期间读 status | 3 次分别 7 / 11 / 11 ms；服务 buildId `d0325ebc…` | 状态读取独立通路有效；不是停止收尾耗时，也不是模型任务耗时 |
| 真实工具定义与 manager，模拟引擎/worker | 8 个问题均复现 | 适配器路由、队列和协议逻辑；没有操作用户业务应用以制造误点 |
| 原生 cursor helper EOF | 父进程退出后，自己创建的 preview 子进程仍存活 | 真实生命周期缺陷。本轮测试进程已按精确 PID 清理，并确认该 preview PID 不再存在 |
| 已有录像及日志 | 32 秒左右；56 条事件全部为 `source:adapter`、`kind:click` | demo 循环和点击反馈；不能证明所有动作的 native 事件链或完整观看预览 |
| 呈现和业务完成率 | 未测 | 没有“与内置 CU 一样流畅”的量化结论；没有模型 + DSH 端到端完成率 |

原始结果见 [third-review-evidence.json](/Users/johnkwok/Downloads/work/super-computer-use/docs/reviews/third-review-evidence.json)。模拟探针的 `reproduced:true` 和退出码 0 表示**缺陷成功复现**，不是产品验收通过。

**R1 · P1：显式切换目标后，token 点击仍可作用于旧目标**

定位：[lib/index.mjs](/Users/johnkwok/Downloads/work/super-computer-use/lib/index.mjs) `1322–1331`；[lib/core.mjs](/Users/johnkwok/Downloads/work/super-computer-use/lib/core.mjs) `936–939`。

`resolveTargetArgs` 正确解析了新目标，但 token 分支只执行 `axTokenFor(ref)`，随后将 token 交给原 worker。此处分支没有比较请求的 pid/window 与 worker 的绑定目标，也没有把请求目标传到原生派发端。`startAXWorker` 内部的目标重启判断不能覆盖绕过该方法的点击。

复现 `cross_target_token_click`：worker 绑定 pid=42/window=7；请求 pid=99/window=9 且使用同一路径 ref，实际调用仍为 `axClick('token-for-A','AXPress')`，返回成功。原生 worker 检查的是自己持有的 pid，无法知道调用者刚请求了另一个目标。

最小修复：token 查询必须绑定完整 target、worker generation 和 observation；派发前验证请求目标与 worker 目标一致。不一致时拒绝并要求重新观察，不能复用旧 token。原生请求也应携带并检查相同目标绑定。

验收：先观察 A，再显式对 B 调用相同 ref；A、B 均不得被旧 token 点击，结果应为明确的目标/身份错误。包括同 pid 不同 window 的情况。

**R2 · P1：展示给模型的节点与 token 来自两次不同观察**

定位：[lib/index.mjs](/Users/johnkwok/Downloads/work/super-computer-use/lib/index.mjs) `794–806`。

`cu_snapshot` 先运行一次 snapshot 并保存节点和 snapshotId，再通过 worker 重新观察，最后把第二次观察的 path→token 映射附到第一次观察的结果中。控件在两次观察之间重排时，同一路径可以指向不同对象。

复现 `snapshot_token_observation_race`：返回文本仍是 Object A，返回/使用的 token 却属于移动到同一路径的 Object B；即使 click 传入刚收到的 snapshotId，仍派发 B 的 token。

最小修复：由一次 retained observation 同时生成节点、token、目标绑定与 observationId；JS 从这一份结果生成快照和 delta。不能把两个遍历结果按 path 拼接。

验收：在观察边界注入同名或异名控件重排。模型收到的节点与 token 必须属于同一次观察；后续操作只能作用于原对象或明确失败。

**R3 · P1：输入前的身份验证异常会放行，而且实际输入仍按路径执行**

定位：[lib/index.mjs](/Users/johnkwok/Downloads/work/super-computer-use/lib/index.mjs) `1496–1512`。

`axVerify` 抛错后被转成 null，只有“存在 verdict 且非 ok”才拒绝。因此超时、worker 退出等无法证明身份的情况，会继续执行旧路径输入。即使 verify 成功，后续另一个命令仍重新按 ref 解析；验证与实际作用对象之间仍有竞态。

复现 `verify_error_still_types_by_path`：verify 抛出 worker unavailable 后，仍执行 `setvalue --pid 42 --ref k0.3.2 --text probe --window 7`，并返回成功。

最小修复：身份验证异常应停止输入；对 token 输入，将校验和对 retained 对象的操作放进同一原生命令。键盘输入还需在派发边界确认焦点目标。不要在身份不明时静默降级到路径。

验收：verify 超时、进程退出、控件移除、验证后重排均不得向替代对象写入。成功分支证明文本写入 retained 目标，而不只是证明曾验证过该目标。

**R4 · P1：worker 超时后的迟到响应会被当作下一请求的结果**

定位：[lib/core.mjs](/Users/johnkwok/Downloads/work/super-computer-use/lib/core.mjs) `896–920`。

`_axRequest` 按“收到的第一行 JSON”完成当前请求。超时只移除监听器；worker 没有重启，协议也没有 requestId。下一个请求安装监听器后，会接收到前一个请求的迟到结果。

复现 `late_worker_reply_misattributed`：first 请求 10 ms 超时、40 ms 返回；second 请求拿到 `{forRequest:'first'}`。observe、verify、click 共用通路时，响应类型和操作结果都可能错配。

最小修复：最小应急方案是在超时后销毁 worker 并使其 token/generation 失效；随后只允许重新观察。完整方案为常驻单一 reader，按 requestId 和 worker generation 路由响应，丢弃过期响应。动作超时仍应返回 outcomeUnknown，不能自动重放。

验收：迟到、重复、乱序响应不得满足另一请求；重启前的 token 不能继续使用。

**R5 · P1：停止只取消已创建的请求，排队动作仍可在停止后启动**

定位：[lib/core.mjs](/Users/johnkwok/Downloads/work/super-computer-use/lib/core.mjs) `1110–1147`、`1914–1918`、`1971–1986`。

AbortController 在队列任务实际运行时才创建。stop 只能遍历当前 `_inflight`，无法取消尚未启动的任务；任务出队也不检查 session generation。默认 stop 不调用原生 pause。取消 HTTP fetch 本身亦不证明服务器已取消其子进程。

复现 `queued_exec_survives_stop`：顺序为 `dispatch:first → stop-called → dispatch:second`；first 返回 cancelled/unknown，second 返回成功。stop 返回 `session:stopped, paused:false`。

最小修复：stop 入口立即使当前 session generation 失效并关闭该会话输入闸门；入队和出队都检查 generation。控制/清理操作走独立通路。原生层按会话或动作 ID 取消对应在途输入，确认按键/鼠标释放后再报告 cleanup 完成；无法证明收尾时保留 unknown。

验收：长动作 A + 已入队输入 B，停止后 B 从未派发；新增动作也须经明确的新会话/恢复流程。另测原生在途动作与 AX worker，不能仅断言 fetch 已 abort。

**R6 · P1：预览在 deadline 前开始 fallback，超时后仍堵住动作队列**

定位：[lib/index.mjs](/Users/johnkwok/Downloads/work/super-computer-use/lib/index.mjs) `284–306`。

已有修复可以阻止“daemon 超时后才启动”的幽灵 shot，但 deadline 前已启动的 fallback 仍通过 `manager.exec` 占用动作队列。预算到期只结束调用者等待，没有取消这个 shot。

复现 `inflight_fallback_blocks_next_action`：预算 20 ms，模拟 shot 耗时 150 ms；click 返回 preview_budget_exceeded 后，下一条 key 仍等约 128 ms，队列顺序为 click→shot→key。这里的 128 ms 是受控模拟结果，不是本机截图实测。

最小修复：deadline 拥有自己的取消信号，超时需传递到实际捕获；预览读请求不应进入输入动作串行队列。两侧都要处理已开始工作，不能只在 fallback 开始前检查一次时间。

验收：分别覆盖超时发生在 daemon、排队、fallback 执行、附件上传期间；旧预览不得占用下一输入动作，也不得覆盖新会话画面。

**R7 · P1：原生预览有独立组件，但插件入口尚未接通，默认路径也没有自动降级**

定位：[lib/index.mjs](/Users/johnkwok/Downloads/work/super-computer-use/lib/index.mjs) session/preview 路径；[engine/Sources/main.swift](/Users/johnkwok/Downloads/work/super-computer-use/engine/Sources/main.swift) `2258–2284`；[PreviewCapture.swift](/Users/johnkwok/Downloads/work/super-computer-use/engine/Sources/PreviewCapture.swift) `180–200`、`219–225`、`275–295`。

`preview.start/visible/stop` 只在原生 helper 的入口实现；`lib` 中没有调用这些命令的插件接线。`cu_session` 的 preview 仍走截图/附件路径。因此“原生卡片可单独运行”尚不能推导出日常插件操作会呈现该卡片。

`--static` 是显式选择的另一条路径；live startCapture 失败被 `try?` 忽略，没有在首帧预算到期时自动转静态帧。目标解析等待 5 秒超时的结果也没有处理，后续存在强制解包 nil 的路径。helper 已有 preview 时再次 start 新 window 只会被忽略。

最小修复：将会话启停、目标切换、宿主可见状态真正接入 preview 控制；共享明确的 generation。为目标解析、首帧、切流定义有界失败分支；从 live 自动降级到带状态标识的静态帧。跨目标淡化可以继续单独标为未完成，不必把它混入本轮最小修复。

验收：通过真实 `cu_session` 而非手写 helper stdin 启动观看；切换 A→B 后显示 B，旧帧不能回写；隐藏暂停，恢复显示当前帧；首帧超时实际触发 fallback。

**R8 · P1：cursor helper EOF 退出后，preview 子进程遗留**

定位：[engine/Sources/main.swift](/Users/johnkwok/Downloads/work/super-computer-use/engine/Sources/main.swift) `2258–2291`；[PreviewCapture.swift](/Users/johnkwok/Downloads/work/super-computer-use/engine/Sources/PreviewCapture.swift) `301–331`。

正常 preview.stop 会结束子进程，但 helper 的 stdin EOF 直接 exit(0)，没有执行相同清理。子 preview 的 readLine 循环遇到 EOF 仅结束 reader，app.run 继续等待其定时器。

原生复现：启动本轮专用 demo、cursor helper，再由 helper 启动 preview；关闭 helper stdin 后，父进程已退出，preview 仍存活。测试使用仓库二进制 `cbc33d77…`，没有用生产窗口制造异常。遗留进程随后已清理。

最小修复：显式 stop、EOF、空闲退出共用有界清理路径；preview 自己遇到 EOF 也应结束捕获与窗口。不能依赖测试末尾全局 pkill 来证明无遗留。

验收：启动后不发送 preview.stop，直接关闭 helper stdin；确认自己创建的所有后代退出、卡片消失。另测 helper 异常退出。测试清理只针对自身 PID。

**R9 · P1：native 阶段事件没有贯通真实工具链，动作动画仍有两套来源**

定位：[lib/index.mjs](/Users/johnkwok/Downloads/work/super-computer-use/lib/index.mjs) `1395` 及各动作 execute；[lib/core.mjs](/Users/johnkwok/Downloads/work/super-computer-use/lib/core.mjs) `1150–1192`、`1229–1254`；[engine/Sources/main.swift](/Users/johnkwok/Downloads/work/super-computer-use/engine/Sources/main.swift) `3603–3623`。

原生命令支持 `--events-v1`，JS 也有流解析器，但普通工具调用没有开启这条路径；服务 `/v1/exec` 不处理 eventsVersion/eventContext，也没有转发阶段事件，而是在 runEngine 完成后返回一个 JSON。token worker 路径同样只返回最终结果。

复现 `nonclick_actions_have_no_unified_events`：分别执行真实工具定义 cu_type/cu_key/cu_scroll，统一事件日志条数为 0。已有演示 56 条全部来自适配器点击，不是 native stream。适配器手动发视觉命令、native 事件另有 `_applyActionEvent`，尚未成为计划中的单一事实来源。

最小修复：先贯通一条 click 的 native→service/worker→manager→renderer 链，再覆盖 type/key/scroll/drag/batch/stop。阶段应在实际动作边界发出，避免最终结果返回后补造时序。兼容旧服务时标明 adapter 来源，不能把它作为 native 链验收证据。

验收：真实工具层录制多种动作，同一 actionId 可追踪到原生阶段与视觉呈现；失败动作没有成功涟漪；迟到、重复及旧会话事件被拒绝。日志必须能区分来源。

**R10 · P2：token click 丢失 button/count 的公开语义**

定位：[lib/index.mjs](/Users/johnkwok/Downloads/work/super-computer-use/lib/index.mjs) `1331`。

复现 `token_click_loses_semantics`：请求 right + count=2，实际仍只有一次 AXPress。这可能把期望的上下文菜单操作变成普通激活。

最小修复：仅对语义等价的单次主键操作使用 AXPress；其他操作要在 retained 对象及目标验证后按其实际几何派发相应鼠标事件，暂不支持时明确拒绝。不能静默忽略参数。

验收：单击、右击、双击分别验证实际界面结果；ref、token 和坐标入口语义一致。

**R11 · P2：宣称“队列≤64”和呈现测量完成，目前没有实现证据**

定位：[engine/Sources/main.swift](/Users/johnkwok/Downloads/work/super-computer-use/engine/Sources/main.swift) `2221–2226`；[VisualFeedback.swift](/Users/johnkwok/Downloads/work/super-computer-use/engine/Sources/VisualFeedback.swift) `214–224`；[lib/core.mjs](/Users/johnkwok/Downloads/work/super-computer-use/lib/core.mjs) `674–680`。

每条 stdin 命令先向主线程投递一个 block，随后才合并 cursor。`visualQueueLimit=64` 只被用于限制 droppedCursorCount 的计数值，不是待处理队列的容量。现有 10→1 离屏测试不能证明 stdin 持续突发时主线程 backlog 有界。

helper stdout 被 ignore；没有计划中的渲染提交 ack。`firstFrameMs` 记录捕获回调时刻，并不是画面真正上屏时刻。当前 firstVisibleMs 记 null 是正确的诚实降级，但 Task 6 不能因此算呈现测量完成。

最小修复：在进入主线程前建立有界 mailbox，cursor/label 合并为最新值，终止事件及时处理；加入可关联 actionId/seq 的渲染提交回执。用屏幕帧或可解释的呈现采样单独测 firstVisible，不能用写管道或收到视频 buffer 代替。

验收：通过实际 stdin 连续突发命令，记录待处理深度、停止响应与旧会话丢弃；分开记录 commandWritten、renderCommitted 和 firstVisible。未测值保留 null。

**交付文档需要一起纠正**

- 验收记录同时存在 103/115/117 测试数、已安装旧构建/新构建、Task 7/8 未实现/部分实现，以及录像未做/已完成等多版本结论。应重写当前状态表，将历史记录移到明确的附录。
- 当前 bench JSON 是旧构建 `09a3ca53…`、每项仅 2 轮，不能作为当前安装构建的稳定 P95。stop 样本的 cleanupState 是 unknown，0 ms 只描述该次受理计时，不能描述输入释放或所有子进程收尾。
- 原生身份 worker 的即时验证目前主要检查 token 存在、epoch、pid、enabled；没有在实际派发路径调用离屏测试中的完整 window/container 契约。不能用纯契约测试推导生产派发已覆盖这些边界。
- 每次 observe 都增加 retained token，旧记录只在 invalidate/begin 时清空。需要明确会话内历史保留上限或淘汰规则；本轮没有测其长期内存增长，不能把短时 overlay RSS 稳定扩展成 AX worker 无泄漏。
- 本轮服务状态确认运行 buildId 为 `d0325ebc…`。仓库二进制为 `cbc33d77…`，安装应用和服务二进制为 `d0325ebc…`。重签名可以改变 hash，但 hash 不同本身不能证明源码等价，应保存 source commit、构建参数、签名身份与产物 hash 的对应记录。

**给下一位开发 AI 的执行顺序**

1. 先修 R1–R4：让快照、token、目标和 worker 响应属于同一条可证明的身份链。将模拟复现改成期望正确行为的回归测试，再用两个专用窗口做原生验收。
2. 修 R5–R6、R8：停止能够取消排队与在途动作；预览不会阻塞输入或留下子进程。保留 cancelled/outcomeUnknown，不自动重放结果不明的动作。
3. 接通 R7、R9，并修 R10–R11：通过真实工具入口演示观看、动作反馈和目标切换。动画由真实动作事件驱动；视觉插值不应延迟实际输入。
4. 用同一 source commit / buildId 重新生成基准、动作日志和 30–60 秒录像。至少包含开始、观察、点击、输入、滚动、切换目标、等待验证、停止；增加排队停止和 helper EOF 两个失败路径。
5. 最后补完整模型 + DSH 固定任务集、多显示器与 30 分钟长跑。缺少环境的项继续列为未测，不能用 demo 或几何单测替代。

不要重写已有效的状态读通路、目标参数整体解析、测试判成功逻辑和已有视觉样式；此次修复重点是打通连接、补齐身份与生命周期边界。

**复跑资料**

- [纯逻辑复现脚本](/Users/johnkwok/Downloads/work/super-computer-use/docs/reviews/third-review-probes.mjs)：真实工具/manager + 模拟引擎，无桌面操作。在 4bfe1ca 的独立导出目录运行；脚本断言缺陷仍存在，修复后应转写为正确行为的测试。
- [原生预览 EOF 复现](/Users/johnkwok/Downloads/work/super-computer-use/docs/reviews/third-review-native-preview-probe.py)：只创建专用 demo 和 helper，并清理自身进程；需要本机辅助功能/录屏权限。
- [状态读取探针](/Users/johnkwok/Downloads/work/super-computer-use/docs/reviews/service-read-probe.mjs)：已安装服务 + 本轮专用 demo，不调用全局 pause。
- [本轮原始证据](/Users/johnkwok/Downloads/work/super-computer-use/docs/reviews/third-review-evidence.json)：模拟、原生、本机服务及已有录像日志统计分别存放，禁止混合解释。
