# Harness 内嵌 Computer Use — 验收报告（2026-11-04）

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
| 预览开关对点击延迟影响 | CLI 点击 6 次中位数，开/关预览 | 359.8 ms vs 353.2 ms = **+1.9%** |
| 30 分钟资源 | 后台采样（60 s 间隔） | **进行中**，报告末尾另附；本轮未在交付时跑满 30 分钟则标“未完成” |

## 9. 多聊天隔离、断线、目标退出、清理（部分）

| 场景 | 结果 |
|---|---|
| 多聊天不串画面 | 通过：新聊天无卡片；注册表隔离 11 项测试 |
| 第二聊天不能停止/抢 owner | 通过（注册表单测 403/409）；未用真实第二 agent 复测 |
| 目标窗口退出 | **未测**（本轮未在流中关闭目标窗口） |
| 断线恢复 | **未测**（宿主重启会终止当前 turn，未做破坏性验证） |
| 权限失败 | **未测**（本机 Accessibility/Screen Recording 均 true） |
| 预览隐藏/卸载清理 | 通过：关闭/停止/插件卸载后 helper 归零；HMR 场景曾有 1 个残留，由 Host guard/手动清理，生产页面刷新走 abort |
| 多显示器/Retina | 未系统覆盖；本机为单显示器 Retina，窗口捕获按 2x 正常 |

## 10. 演示录像

`docs/demo/2026-11-04-harness-integrated-cu-demo.mov`（45.0 s，仅 Harness 窗口，14 MB）：

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
