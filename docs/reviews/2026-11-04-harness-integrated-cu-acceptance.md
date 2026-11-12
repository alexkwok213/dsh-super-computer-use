# Harness 内嵌 Computer Use — 验收报告（2026-11-04）

> **历史报告（基线 `52b244f`）**：以下结果保留为当时的真实观测，不追改。Round-2 修复后的
> 安装一致性、停止、背压和 idle 策略变化见 §14 与
> [Round 2 安装与回滚报告](harness-round2-installation.md)。

本报告只记录本轮在**真实安装的 DeepSeek Harness** 上实际观测到的结果。模拟测试、旧报告和独立 demo 不计入通过项。未测的项目明确写“未测”。

## 1. 结论

在真实 Harness 0.2.1-rc.5 桌面宿主中，SCU 插件的 Client 半已经加载并注册到会话级 slot；聊天内卡片、实时 ScreenCaptureKit 预览、状态同步、目标切换和停止闸门均已跑通。**没有达到“Codex 同等效果”**：本轮预览只读、约 8–10 fps、无点击穿传、无断线重放，长稳测试仍在进行（见 §8）。

## 2. 环境与版本

| 项目 | 值 | 来源 |
|---|---|---|
| Harness | 0.2.1-rc.5，build `d4db512a969fccf0c5cc7ec8fe38e9c1d27af916` | Info.plist / `cu_status` |
| 插件仓库基线 | `main` `5a29363`，工作区有本轮改动（未提交） | `git rev-parse` |
| 插件包版本 | `dsh-super-computer-use@0.2.0` | `package.json` |
| 开发引擎 | `engine/bin/cu`，sha256 `b950e361802f9d7b93f12b82bc610c868bedf256b6328e3cd3d2ed16bc4fdf8d` | `shasum` |
| 已安装服务引擎 | `~/Library/Application Support/cu/bin/cu`，同一 sha256 | `shasum` |
| 预览 helper | `~/Library/Application Support/cu/bin/cu-preview`，同一 sha256 | `shasum` |
| 服务 buildId | `b950e361...bf52`（`/v1/status`） | `cu_status` |
| Client bundle rev | `b977800735e0`（最后一次安装后图） | `~/.cu/plugin-boot.log` |
| `/Applications/Computer Use.app` 内旧引擎 | **仍是旧二进制（1519680 B），未替换** | `ls -la` |

服务引擎与开发构建一致；`/Applications` 内 app bundle 的引擎副本未更新（避免破坏其签名），这是已知不一致，见 §9。

## 3. Task 1 gate：外部 Client 插件接入（通过）

- Client 模块在真实桌面页激活：`Slots.listSubTree` 的 `conversation.input.dock` 出现 occupant `super-computer-use`（order 30, active true），`shell.overlay` 出现 `super-computer-use`（order 40）。
- 会话身份来自 slot props `sessionId`，不是 DOM 文本推断；卡片只显示当前聊天的 owner 状态。
- 认证 Carrier 是桌面自定义源 `dsh-app://app`；相对 `/api/scu/*` fetch 走同一宿主 cookie/peer，无新增端口。
- 流式探测（真实页面）：首块 **43 / 58 / 97 / 137 / 138 / 142 ms**（多次会话），每次 **2 chunks**，读取后主动 abort 均生效；无认证的 curl 对 GUI 返回 401。
- 探测路由在交付配置中已关闭（`uiProbe: false`），代码与回归测试保留。

Gate 结论：**PASS**，不需要 Task 1B 的宿主源码适配。

## 4. 多聊天归属与停止（通过/部分）

- 单元测试 `test/cu_ui_session.mjs`（11 项全过）覆盖：第二个聊天 `cu_busy`、外部聊天 stop 返回 403、stale session/revision 409、停止幂等、停止后新 owner 可接管、agent 消失不转移控制、迟到结果不能覆盖停止状态。
- 真实 UI：新建“新会话”后，新聊天不显示 CU 卡片；返回原聊天后原会话状态仍在。原聊天 turn/end 之外的其他聊天 turn/end 不再停止 owner 的会话（本轮修复并重载验证）。
- 未做：在两个聊天里同时真实调用 `cu_*` 工具（需要两个并发 agent），目前以注册表测试 + 新聊天 UI 证据代替。

## 5. 状态、停止与清理（通过）

真实 `cu_session stop`（UI 卡片的同一条 `registry.control` 路径）：

```
ui stop gate closed in 0ms (stop)
ui stop cleanup cleanup_unknown in 1ms cleanup=unknown
```

- 停止前先关闭输入闸门并取消 in-flight；`stopVisualSession` 再关闭闸门、递增 sessionGeneration。
- 子进程：停止后 `pgrep -f cu-preview preview-stream` = **0**，无残留预览 helper。
- `cleanupState` 如实为 `unknown`，UI 显示“Stopped · cleanup unknown / 已停止 · 清理状态未知”，没有伪称 complete。
- 停止与执行竞态：新增回归测试“late in-flight result cannot overwrite a UI stop”，通过。

## 6. 实时预览与目标切换（通过）

- 帧协议：`uint32BE metaLen | uint32BE jpegLen | JSON meta | JPEG`；接收端限制 meta ≤16 KiB、JPEG ≤2 MiB；Host 端每个 owner 只保留一个 helper，慢读者丢帧。
- 真实帧率样本（`~/.cu/plugin-boot.log`）：
  - 330 帧 / 37.1 s ≈ **8.9 fps**
  - 262 帧 / 31.0 s ≈ **8.5 fps**
  - 191 帧 / 22.8 s ≈ **8.4 fps**
  - 首帧 360–476 ms（多窗口，目标被 Harness 遮挡时仍出帧；Notes 窗口在本机 SCK 下 0 帧，已记录为环境限制）
- 目标切换：旧 helper `exit code 0`，新目标新 generation 单独启动；UI 从“TextEdit”切到第二个窗口后画面与标题同步，旧画面不残留（修复了 stream teardown 的 token 竞态）。
- 预览全程不进入模型上下文；模型截图仍走原有 `cu_screenshot`/附件链路，两条链路独立。

## 7. 视觉与交互（通过，主观项）

- 卡片位于输入框上方（`conversation.input.dock`），宽 `min(320px,100%)`，12 px 圆角，半透明 `color-mix` + `backdrop-filter: blur(18px)`，使用宿主 `--dsw-alias-*` 令牌；深/浅色跟随。
- 展开为 `shell.overlay` 全帧面板，显式传 owner session；Escape 关闭、Close 按钮、focus 归还；`prefers-reduced-motion` 关闭动画。
- 诊断行显示 Carrier、流式探测、target generation、frames/dropped/decode ms；不显示用户输入正文。
- 已知：按钮的 `AXPress` 与真实鼠标事件在本机曾出现不一致（已同时支持 pointerdown/click，并对展开做 250 ms 去抖）；不同宿主版本的 AX 行为未测。

## 8. 性能测量（部分）

| 指标 | 方法 | 结果 |
|---|---|---|
| 首帧 | Host `preview first frame` 日志 | 360–476 ms |
| 交付帧率 | 子进程退出帧数 / 存活时间 | 8.4–8.9 fps（目标 10） |
| 解码 | 客户端 diagnostics | 0.9–133 ms（窗口大小/内容相关） |
| 停止闸门 | `registry.control` 计时 | 0 ms |
| 停止清理 | 同上 | 1 ms |
| 预览开关对点击延迟影响 | CLI 点击 6 次中位数，开/关预览 | 359.8 ms vs 353.2 ms = **+1.9%**（含 CLI 进程启动，属保守上限） |
| 长稳资源 | 后台采样（60 s 间隔，单 helper） | **22.0 分钟**：host RSS 937.7→856.4 MB（无增长），helper 49.9→50.0 MB，CPU 中位 0.8%/1.0%，单 helper 全程；**30 分钟未跑满** |

## 8.1 长稳采样（实际 22.0 分钟，未满 30）

采样文件：`docs/reviews/evidence/soak-20261104.csv`（23 个样本，60 s 间隔，1322 s）。字段：host RSS/CPU（DSH host 进程 84711）、helper RSS/CPU、helper 数、插件日志字节数。

| 指标 | 首 | 末 | 最小 | 最大 | 中位 |
|---|---|---|---|---|---|
| Host RSS | 937.7 MB | 856.4 MB | 848.9 MB | 937.7 MB | — |
| Helper RSS | 49.9 MB | 50.0 MB | 49.8 MB | 50.2 MB | — |
| Host CPU | — | — | — | 2.7% | 0.8% |
| Helper CPU | — | — | — | 1.7% | 1.0% |
| Helper 数 | 1 | 1 | 1 | 1 | 1 |

- 22 分钟内 Host RSS 下降 81 MB（GC/缓存回落），没有持续增长；helper RSS 基本恒定。
- 期间发生一次 helper 换代：旧 helper 3053 帧 / 353 s（≈8.65 fps）后退出，3 ms 内重开，首帧 410 ms；换代空窗约 0.4 s。
- 22 分钟结束是主动停止，**不足计划中的 30 分钟**；按“未测满”处理，不把 22 分钟当 30 分钟结论。

## 9. 多聊天隔离、断线、目标退出、清理（部分）

| 场景 | 结果 |
|---|---|
| 多聊天不串画面 | 通过：新聊天无卡片；注册表隔离 11 项测试 |
| 第二聊天不能停止/抢 owner | 通过（注册表单测 403/409）；未用真实第二 agent 复测 |
| 目标窗口退出 | **未测**（本轮未在流中关闭目标窗口） |
| 断线恢复 | **未测**（宿主重启会终止当前 turn，未做破坏性验证） |
| 权限失败 | **未测**（本机 Accessibility/Screen Recording 均 true） |
| 预览隐藏/卸载清理 | 通过：关闭/停止/插件卸载后 helper 归零；HMR 场景曾有 1 个残留，由 Host guard/手动清理，生产页面刷新走 abort |
| 观看期间空闲自动停止 | 已修复：每次 owner 轮询 re-arm idle timer，观看时不因 60 s 无工具调用而中断；关闭观看后按 idle 回收 |
| 中文/英文本地化 | 已修复并实测：`zh-CN`/`zh-Hans` 统一走中文；卡片显示“已完成，未验证 / 停止” |
| 多显示器/Retina | 未系统覆盖；本机为单显示器 Retina，窗口捕获按 2x 正常 |

## 10. 演示录像

当时的演示录像 `docs/demo/2026-11-04-harness-integrated-cu-demo.mov`（45.0 s，仅 Harness 窗口，14 MB）已在旧版控制台素材清理中移除；以下为当年记录的画面要点，供追溯：

- 0–10 s：TextEdit 实时预览，画面内可见已输入文本 `— typed by Harness CU from the recorded demo` / `— live demo`，Carrier `dsh-app://app`，Probe 142 ms / 2 chunks，8 fps，Frames 54。
- 10–26 s：切换到第二个 TextEdit 窗口，面板标题/画面/Generation 更新。
- 26 s 后：`Stopped · cleanup unknown`，停止后无预览 helper。
- 录像前的点击/输入/验证由同一轮的 `cu_batch`（click→type→key，1282 ms）和 `cu_expect`（48 ms，ok）完成；录像从预览已建立后开始，因此输入动作本身不在画面内，但结果与状态同步可见。

## 11. 改动清单

新增：
- `client.js`：Client 半（卡片、overlay、轮询、JPEG 解码、停止）。
- `lib/cu-ui-session.mjs`：owner 注册表 / 状态机 / 停止闸门封装。
- `lib/harness-ui-bridge.mjs`：认证 Fetch 路由（state/control/probe/preview）。
- `lib/preview-stream.mjs`：受控 helper 子进程、帧协议、背压、按 owner 去重、generation guard。
- `engine/Sources/PreviewFrameOutput.swift`：SCStream → 有界 JPEG 帧。
- `test/harness_ui_manifest.mjs`、`test/cu_ui_session.mjs`、`test/harness_ui_bridge.mjs`、`test/preview_stream_transport.mjs`。

修改：
- `lib/index.mjs`：注册表/bridge 装配、工具 owner 包装、embedded 判定、`cu_session stop` 走注册表、turn/end 仅停 owner。
- `lib/core.mjs`：`resolvePreviewBinary()`、`capsule` 开关。
- `lib/action-events.mjs`：KINDS 增加 `batch`。
- `engine/Sources/main.swift`：`preview-stream` 命令。
- `engine/install-service.sh`：安装 `cu-preview` 副本。
- `package.json`：`./client` 导出、`files`、`dsh.client`。

## 12. 回滚

完整步骤见 [回滚说明](2026-11-04-harness-integrated-cu-rollback.md)。最少步骤：

1. 删除 profile patch 中 `BEGIN super-computer-use embedded viewer` 到 `END` 的块。
2. 用 `.rollback/profile-package.json.bak`、`.rollback/profile-cordis.patch.yml.bak` 覆盖 profile（如果还做过其他手工改动）。
3. 用 `.rollback/cu-installed-20261104-215341` 覆盖 `~/Library/Application Support/cu/bin/cu`，删除 `cu-preview`，`launchctl kickstart -k gui/$(id -u)/local.cu.service`。
4. 若要完全移除 UI：禁用/移除 `dsh-super-computer-use` bundle；未删除任何会话。

## 13. 已知限制与后续

1. **不是 Codex 同等实现**。Codex 的预览是其私有链路；本方案复用 SCK + 自建认证帧代理，实测 8–10 fps，未做自适应码率/硬件解码调优。
2. **预览只读**。没有点击穿透、缩放映射或浏览器扩展，符合本轮范围。
3. **首次安装需要重启桌面 App**：`dsh.client` 的包元数据在启动时缓存。本轮为了不打断会话，使用了 `uiRefreshClient` 一次性迁移（清空 per-specifier manifest 缓存并增量 reconcile）；交付配置已置回 `false`。正常安装路径仍是“安装后重启一次”。
4. **`cu-preview` 副本**：同一路径下已有 launchd 服务在跑时，第二个进程用同一路径做 SCK 窗口捕获会被 macOS 拒绝；安装器因此保留一个字节相同的 `cu-preview` 专门给预览 helper。它是产品安装的一部分，不是调试脚本。
5. **`/Applications/Computer Use.app` 内引擎仍是旧构建**：只更新了服务/预览使用的 `~/Library/Application Support/cu/bin/cu`，避免重签 app bundle。要完全一致需重跑 `install-app.sh` 并重新授权。
6. **断线恢复**：没有实现事件重放；页面重新连接后靠下一次 250 ms 轮询拿全量快照，断线期间的状态变化不补发。
7. **目标退出/最小化/无权限**：UI 有 `no_target`/`window_not_capturable`/`stale` 分支，但本轮没有在流中真实关闭目标窗口验证。
8. **多显示器与 Retina**：只在本机单显示器 Retina 上验证；坐标/letterbox 规则来自既有 `PreviewController` 单测，未新增多屏实测。

## 14. Round-2 更正（2026-11-04 晚，基线 `52b244f` 之后）

本节只列被后续修复取代的历史描述；上面的原始结果保留不改。详细证据见
[Round 2 安装与回滚报告](harness-round2-installation.md)与
[Round 2 复核](2026-11-04-harness-design-review-round2.md)。

| 历史描述 | 现状 |
|---|---|
| §2 / §13.5：`/Applications` 内 app 仍是旧引擎，只更新了 service | 已消除。2026-11-04 23:24 重装后 app/service/preview 来自同一未签名构建；app 旧 `9beef70…`、service `b950e36…` 的错位不再存在。运行 buildId `9815adc1…2c1d73`。 |
| §6：慢读者“丢帧” | 改为**一帧 pending latest**：慢读者恢复时拿到最新帧，内存仍只保留一帧；旧实现保留队列头、丢新帧的描述不再成立。 |
| §9：观看期间的 owner 轮询 re-arm idle timer | 已移除。观看不是输入活动，不能让只有观看的会话无限占 owner；idle 由 manager 自己的计时器决定，UI 跟随 manager 的结束通知。 |
| §4：stale revision 返回 409 | STOP/TAKEOVER 不再受普通 revision 约束，只要求 hostSessionId + 当前 cuSessionId；旧 revision 的停止仍会关闸。 |
| §7/§13.8：点击与 AXPress 双触发靠 250 ms 去抖 | 本轮未完成视觉收敛；该问题归 Task 7，不在本报告声称已修复。 |
| §8：“+1.9% 是保守上限” | 仍只是 6 次 CLI median，不是 P95；正式 P95 在 Round-2 验收（Task 6）重测。 |
| §8.1：22 分钟 | 仍是“未满 30 分钟”的部分证据，不延长成 30 分钟结论。 |

### 已验证的安装事实（补充）

- 更新前：app `9beef70a…bf52`、service/helper `b950e361…df8d`、dev `fb7ea83a…0988`；
  `/v1/status` buildId `b950e361…`。
- 更新后：app `3fa4c1e1…b9e771`（bundle 签名 `local.cu.app`，CDHash `55be9e43…`）、
  service/helper `9815adc1…2c1d73`（identifier `cu`，CDHash `b58d9c70…`）；
  `/v1/status` buildId `9815adc1…`；Accessibility/Screen Recording 均为 true。
- 修复的真实缺陷：`cu-preview` 作为 app 可执行文件的字节副本时带 bundle 签名，离开 bundle
  后被 amfid 以 invalid signature 杀掉（exit −9）。安装器改为复制 standalone 签名的
  `engine/bin/cu`，并在安装时分别 `codesign --verify --strict`。
- 回滚快照：`.rollback/round2-pre-20261104-2319/`（更新前）与
  `.rollback/round2-verified-20261104-2329/`（已验证统一构建）。
