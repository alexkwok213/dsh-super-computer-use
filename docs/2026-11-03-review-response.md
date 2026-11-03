# 对 2026-11-03 体验评审的落实报告

对象：`docs/2026-11-03-computer-use-experience-review.md`（8 节）。仓库：`~/Downloads/work/super-computer-use`，13 个提交。
全部结论都有测试或实测支撑；未能验证的地方单独列出，不当作已解决。

## 总览

| 节 | 状态 | 关键交付 |
|---|---|---|
| §1 视觉反馈连接 | 完成 | ref/坐标/batch 三种点击反馈一致；失败不出涟漪；文案用控件名 |
| §2 等待与验证 | 完成（与我不同意的一处做法） | 变更驱动观察 + `cu_expect` + 动作带 `expect` |
| §3 预览长等待 | 完成，且找到真根因 | 抓屏 daemon 回落到 screencapture；预览带预算与降级 |
| §4 身份与坐标 | 完成 | `snapshotId`、`cu screens`、多屏光标、截图时间戳与实时几何 |
| §5 整任务耗时 | 完成（worker 迁移按测量否决） | 预算上报、expect 检查点、服务读队列分离、timings |
| §6 信息与负担 | 完成（`lastRoute` 未接） | `vision`/`lastImage`/`registrationErrors`；会话内目标缺省 |
| §7 视觉跟随动作 | 完成 | 时序缩短、presentation 续动画、减少动态效果、状态文案 |
| §8 验收集 | 完成 | `npm run bench` 六任务基线，可复跑 |

测试：`npm test` 73/73 通过（纯逻辑 59 + 桌面集成 14 中的 11 项在 core.test）；每次改 Swift 后重建安装引擎并跑全量。

---

## §1 视觉反馈：从"引擎返回了但没人看"到三路一致

**复现**（用插件真实工具 + 桩执行器）：`cu_click(ref)` → 无事件；`cu_click(x,y)` → cursor/label/click；`cu_batch` → 无；失败的点击 → 仍然闪成功涟漪；引擎返回里其实有落点 `x:340,y:412`。

**根因**：`recordSnapshot()` 只缓存 `ref/role/title/windowId`，把引擎已经给出的 `x/y/w/h/cx/cy` 扔了，`clickVisualPoint()` 必然落空；batch 直接调 `exec()`，根本没接视觉层；涟漪在 `exec()` 之前触发。

**改动**：缓存几何；涟漪改用**引擎刚解析出的 frame**（不是过期快照）；只有引擎确认成功才闪；batch 每步复用同一套反馈；标签 `点击「导入」`（title→role→坐标→ref 兜底，ref 不再当主文案）；失败走胶囊"未执行"并清空标签。

**验收对照**：ref/坐标/batch 三者事件序列一致（`cursor → label → click`）；失败/拒绝/取消不显示成功；`test/visual_feedback.mjs` 7 项覆盖连接本身（不是只测辅助函数）。

## §2 等待与验证：把 Python 侧的语义搬进 JS，而不是下沉引擎

先确认了评审的事实判断：动作后观察确实是一次立即 snapshot；而且比评审说的更糟——`lib/core.mjs` 与 `engine/Sources/main.swift` 两处注释都声称"插件侧 change-driven observe 会重读"，`lib/index.mjs` 里 grep 不到任何 settle/重读逻辑，注释在撒谎。

同时发现评审漏掉的：引擎**已经有**轮询式 `expect` 命令（Claude MCP 在用），DSH 插件没接。

**改动**：观察在树与基线一致时按预算重读（默认 300ms，最多 3 次读），返回 `changed` / `waitedMs` / `reads`；新增 `cu_expect`；`cu_click/type/key/scroll/batch` 支持 `expect`，返回 `verified` + `verification`，条件未达成时 `ok:true` 但给 `warning` + `actionReplaySafe:false`；batch 里的 `expect` 步骤是检查点。

**与评审不同的判断（重要）**：评审建议"把共同等待语义放到引擎"。我没有这样做，理由：引擎是每次调用 fork 一个子进程，把等待循环放进去会让慢调用更久占住串行 HTTP 队列，且调用方无法 abort。Python 侧的做法（适配层 + 预算 + 回退）是对的，所以语义放适配层，引擎只保留 `expect` 这一条显式条件。

**代价**：树没变时最坏多付"预算 + 一次读树"（500 节点实测 ~340–500ms）；树变了就是原来的单次读。这是为"不误判没变化"付的，且可配置。

## §3 预览：根因不是超时参数，是抓屏链路整条失效

**实测（修前）**：daemon 抓屏每次 **8116ms 且 `ok:false`**；引擎兜底 4376ms。所以评审看到的 8–9 秒空档是"daemon 耗尽 8 秒等待后什么都没拿到，再走一遍 CLI"。

**根因**：daemon 只有一条 async SCK 路径（8s 等待、无 timeout 的 `sem.wait()`、无兜底）；CLI 有三级兜底所以慢但能出图。

**改动**：daemon 在 SCK 不应答时回落到 `screencapture` 并**记住这个 stall**（`~/.cu/sck-stall.json`，24 小时、按 OS 构建号失效），冷启不再重付；SCK 等待 8s→1.5s，启动时 content fetch 从无上限改为 2s；超时请求会重启 daemon，迟到回复不会再被当成下一单的答案；预览带预算（动作后 600ms、会话 2500ms）并降级为 `preview_budget_exceeded`；会话启动时后台预热 daemon（同一次调用里要预览则跳过，避免排队）；预览返回 `via/captureMs/saveMs/capturedAt/displayId`。

**实测（修后）**：daemon 抓屏 8116ms/失败 → **111–118ms 暖、346ms 冷**；引擎兜底 4376 → 414ms；`cu_session start` 带预览 2653ms（降级无图）→ **564–733ms（有图）**；预览 P95 1997 → 398ms。

## §4 身份与坐标：能证明就证明，证明不了就要求重读

- 每次观察带 `snapshotId`（含 `takenAt`）；`cu_click`/`cu_type` 与 batch 步骤可带 `snapshotId`，与缓存代数不符时返回 `stale_snapshot` + `currentSnapshotId`，**不派发任何动作**。这是 opt-in：不传就沿用引擎原有的 path+role+title 校验。
- 新命令 `cu screens`：真实显示器 frame（全局左上原点）/usable/scale/name，分屏改用"目标窗口所在屏"，支持负原点；会话结果报 `layout.source/screen/usable`，没有显示器信息时回退并**如实标注回退**。
- 光标 overlay 从"只在 `NSScreen.screens.first`"改为覆盖所有屏的并集，坐标按 overlay 原点与主屏顶边换算。
- 截图：origin/size 改用**实时窗口 bounds**（缓存 `SCShareableContent` 的 frame 会因移动/缩放过期），并返回 `capturedAt` + `displayId`。实测：窗口移动后 daemon 在 125ms 内报出新位置 `250,150 640×480`。

**残留**：同 path、同 role、同 title 的控件，只有调用方传 `snapshotId` 时才能区分；引擎的 `stale_ref`/`ref_outside_window` 是默认防线。

## §5 耗时：把不可见的成本变成可见数字

- 单步 batch 超预算不再静默成功：`budgetExceeded` / `budgetMs`（复现：20ms 预算、83ms 执行、旧代码返回 `ok:true` 无任何标记）。
- `timings` 拆分：`actionMs / verifyMs / observeMs / previewMs / totalMs`；batch 另拆 `steps / settleMs / overheadMs`——那 60ms 盲等现在是可讨论的数字，不再是隐形税。`settleMs` 也开放为参数。
- `{action:"expect"}` 成为 batch 检查点（条件不成立即停）。
- 服务端把 GET（status/tools/agents）放到并发读队列，写操作仍串行：3 秒动作期间 status **~3s → 8ms**。
- **否决了"高频动作迁常驻 worker"**：实测一次子进程跳 50–60ms（裸 spawn 52ms；`windows` CLI 111ms vs 进程内 50ms），约占本地动作 10–30%，评审自己也说先量化；隔离价值暂时更高。量化数据已写进提交说明。

## §6 让模型知道自己的能力

`cu_status` 新增 `vision {supported, reason}`（"读不到能力"与"不支持图像"分开报，不把 unknown 当 yes）、`lastImage {delivered, reason, bytes, via}`、`registrationErrors`；图发不出去时预览返回 `imageDelivered:false` + 原因，不再只给一个看起来像证据的路径；会话内 `pid/windowId` 可省略（显式传仍优先）。

**未接**：`lastRoute`（当前走 AX/OCR/视觉哪条路）字段已预留但没写入点。

## §7 视觉跟随真实动作

光标 280→140ms、涟漪 500→240ms、标签淡入 180→120ms；快速 batch 下从 **presentation layer** 续动画（原来每步跳回上一条 path）；支持 macOS 减少动态效果与 `CU_REDUCE_MOTION`（按系统通知实时重读）；标签夹在屏内不盖控件；胶囊新增 `等待「…」/已确认「…」/未确认「…」/已被用户暂停`；全屏边缘光改为可关（`rim:false`），默认只保留目标窗口高亮 + 光标 + 胶囊。视觉事件仍然在动作之外，不阻塞返回。

## §8 验收集

`npm run bench`（`bench/run.mjs`）：六个本地任务，数字取自工具自己的 `timings`，可复跑、可比较模型与引擎版本。基线（每项 12 次，`docs/bench/baseline.json`）：

| 任务 | 成功率 | P50 | P95 |
|---|---|---|---|
| AX 快照 | 12/12 | 97ms | 183ms |
| ref 点击 + 观察 | 12/12 | 287ms | 335ms |
| 输入 + 显式后置条件 | 12/12 | 487ms | 573ms |
| 批处理 click→wait→key | 12/12 | 524ms | 690ms |
| 窗口截图（冷 daemon） | 12/12 | 346ms | 398ms |
| 结束会话 | 12/12 | 0ms | 1ms |

对评审 §8 目标值的对照：首个状态反馈 0ms（光标提示先于引擎调用，P95 = 0）；本地动作+观察 287/335（目标 300/700，达标）；预览降级 600ms 预算内（目标"约 500ms"，略宽，标为差异）；停止 0/1ms（目标 100ms 内）；"动作完成必须有观察证据"由 `verified` + `observation.changed` + `warning` 表达。

**差异**：只跑了 12 次（评审建议 ≥20）、单一宿主单一模型；跨模型对比尚未做。真实 app（Finder 对话框、Electron 搜索、剪映导入）仍靠人工记录，未进基准。

---

## 评审意见我没有照做的地方

1. **§2 等待语义下沉引擎** → 保留在适配层。理由见 §2。
2. **§5 迁常驻 worker** → 量化后不做（50–60ms/跳）。
3. **§2 AXObserver 唤醒** → 未做，只有有上限的轮询。理由：300ms 预算内收益不明显，先不引入系统通知的生命周期管理。
4. **§3 "观看操作"独立低帧率预览窗** → 未做（需要新 UI）；用户观看刷新率与模型图像频率本来就是分开的。
5. **§4 语义重定位限定已知容器** → 未做；改为"调用方带 snapshotId 才校验"，默认防线仍是引擎的 role/title + 越界检查。

## 过程中暴露的两个真问题（已修，值得记录）

1. **profile 链接指向空目录**：`node_modules/dsh-super-computer-use` 指向一个空工作区（12:03 就存在，属于潜伏配置错误，第一次重启才暴露）。表现：插件整包不加载、13 个工具全消失、无任何错误提示。修复：链接指回仓库 + `pnpm install`；README 增加 `readlink` 排查法。
2. **参数 schema 违反宿主 DSL**：我给 `expect` 写成裸 `{type:"object"}`，宿主在注册时要求对象参数显式声明 `additionalProperties`，抛错发生在 `apply()` 里 → **一个参数错误导致 13 个工具全部注册失败**。修复：补 `properties` + `additionalProperties:false`；注册改为逐工具 try/catch（一个坏定义只损失自己）；`~/.cu/plugin-boot.log` 记录模块加载/apply/被拒工具；`test/tool_schema.mjs` 按宿主那套规则校验全部 13 个定义，这类错误以后在 `npm test` 阶段就挂。

## 现在的状态

- 代码：13 个提交，工作区干净，`npm test` 73/73。
- 引擎：已重建并安装到 `/Applications/Computer Use.app`，`buildId 51986b73…`。
- 插件：已在运行的 DSH 中加载（`~/.cu/plugin-boot.log` 有 `apply() done: tools registered`，技能 `super-computer-use` 可见）。
- 真机验证（demo 窗口，未碰用户前台 app）：会话启动带图 912ms 抓帧、ref 点击 + `expect` 890ms 且 `verified:true`、复用旧 `snapshotId` 被 `stale_snapshot` 拒绝、batch 检查点命中并捕获到新弹出的 `AXSheet`。
