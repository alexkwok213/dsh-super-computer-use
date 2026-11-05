# DSH Super Computer Use

DeepSeek Harness 专属 macOS 桌面智能操控插件。

```
DeepSeek Harness 宿主
└─ DSH 插件 (dsh-super-computer-use)
    ├─ 13 个 cu_* 工具、Agent 技能、参数校验与权限引导
    ├─ 聊天内嵌观看卡片、实时画面流（ScreenCaptureKit）、用户安全停止闸门
    └─ 内置受管原生 Helper (bin/cu)
        ├─ 进程生命周期：按需启动、心跳与异常自毁回收（--watch-parent）、退出清理
        ├─ 安全认证：实例级凭据安全传递（CU_AUTH_TOKEN/CU_STATE_DIR），零全局配置依赖，不打印 Token
        └─ 原生操控：macOS Accessibility (AX)、ScreenCaptureKit 抓屏、CGEvent 输入、光环与状态胶囊
```

## 目录

| 路径 | 作用 |
|---|---|
| `bin/` | 预编译 macOS Universal Binary（Apple Silicon + Intel，开箱即用，免 Xcode） |
| `lib/` | Cordis 插件：13 个 `cu_*` 工具、进程自管理、会话管理、附件预览 |
| `client.js` | Harness 内嵌观看 UI：输入框上方卡片、全帧预览、状态、停止、一键系统授权 |
| `locale/` `skill/` | 插件文案与技能说明 |
| `test/` | 插件测试（Node） |
| `scripts/` | 自动化构建通用二进制脚本（`build-universal.sh`） |
| `engine/Sources/` | 原生引擎源码（Swift） |
| `assets/icon.png` | 插件产品图标 |
| `engine/tests/` | 原生回归测试（光环/抓屏/窗口查询/控制台界面） |
| `docs/` | 设计与验证记录；`docs/legacy/` 为合并前两个仓库的历史文档；`docs/demo/` 为演示素材 |
| `docs/ui/` | 控制台界面的对照参考（`reference/`）与改造后截图（`console-after/`） |

## Harness 内嵌观看

插件同时提供 Host 半与 Client 半。Client 在**当前聊天**的输入框上方注册一张卡片；
展开后使用 Harness 的 `shell.overlay` 显示实时窗口画面。画面来自已有的
ScreenCaptureKit 常驻捕获路径，经本机认证的 `/api/scu/preview` 以有界 JPEG 帧流送到
浏览器 canvas；它不是高频截图轮询，也不进入模型上下文。

- `viewerMode: auto`（默认）：当前聊天有客户端连接时用内嵌观看，其他客户端仍走原生预览。
- `viewerMode: native`：强制保留原来的悬浮预览窗口。
- `viewerMode: embedded`：强制内嵌（本机验收用）。
- 停止走同一条 `CuSessionManager` 停止闸门：先关输入闸门，再清理；`cleanupState` 未知时如实显示。
- 一个桌面同时只有一个 owner；另一个聊天只能看到“忙”，不能停或接管。

验收与回滚记录见 `docs/reviews/2026-11-04-harness-integrated-cu-acceptance.md`。


## 开箱即用安装（纯粹 DSH 插件 · 免 Xcode · 免后台常驻）

本插件现已全面重构为**纯粹的 DeepSeek Harness 插件**：
- **自带通用二进制（Zero-Build）**：安装包已预编译内置 macOS Universal Binary（同时支持 Apple Silicon M1/M2/M3/M4 与 Intel 芯片，macOS 14+），**完全不需要安装 Xcode、Command Line Tools，更不需要编译 Swift 源码**。
- **随 DSH 自启停（Daemonless）**：无需注册系统 `launchd` 服务，无需安装独立外部 App，DSH 加载插件时自动拉起引擎，DSH 退出时自动释放。
- **零配置权限引导**：缺权限时，DSH Web 界面卡片上直接显示「打开系统设置授权」按钮，一键直达系统辅助功能与屏幕录制设置。

### 方式 A：从 GitHub Releases 下载（推荐普通用户）

1. 在 GitHub Releases 页面下载最新的 `dsh-super-computer-use-standalone.zip` 或 `dsh-super-computer-use.tgz`。
2. 打开 DeepSeek Harness：
   - 进入「设置 → 插件」页面，点击「从本地目录 / 压缩包安装」，选择下载的文件即可；
   - 或者在当前 profile 目录下运行：
     ```bash
     dsh plugin add dsh-super-computer-use.tgz
     ```
3. 首次使用在系统弹出的权限提示或 Web UI 卡片按钮中，为 **DeepSeek Harness** 勾选「辅助功能」与「屏幕录制」权限，即可开箱即用！

### 方式 B：通过 Git Clone 安装

```bash
git clone https://github.com/alexkwok213/dsh-super-computer-use.git
# 在 DSH 中链接本地插件即可
```

### 开发者说明（源码二次开发）

修改 Host JS、Client 或 Swift 后，统一运行：

```bash
npm run dev:sync
```

它会依次确认软链接仍指向本仓库、运行隔离测试、只在原生源码变化时重建 universal helper、通过运行中 DSH 的官方 HMR 接口重载 Host/Client、回收并重启 helper，最后在真实运行版本上核对三部分身份。成功时必须看到 `OK` 且退出码为 0；退出码 3 表示被活跃 CU 会话、页面未连接、HMR 不可用或重启需求阻塞，不能算成功。只改 JS/Client 不会重复编译 Swift。

```bash
npm run dev:sync -- --check-only      # 只检查链接、运行版本与更新计划
npm run dev:sync -- --wait-idle=30    # 活跃 CU 会话时最多等待 30 秒
```

完整说明、退出码与限制见 [`docs/dev-sync.md`](docs/dev-sync.md)。发版时仍按独立流程推送 tag（例如 `git tag v0.3.0 && git push origin v0.3.0`），GitHub Actions 会自动编译并打包 Release；`dev:sync` 不提交、不推送、不发布。

## 能力

**插件工具（13）**
`cu_status` `cu_windows` `cu_launch` `cu_snapshot` `cu_expect` `cu_click` `cu_type`
`cu_key` `cu_scroll` `cu_screenshot` `cu_session` `cu_find` `cu_batch`

**视觉反馈**
- 边缘呼吸光：只在 agent 真正操作时出现的屏幕四边窄光带（蓝→青→紫，约 72pt），停手约 2 秒后自动淡出
- 渐变光环：跟随目标窗口，独立停止面板
- 毛玻璃 HUD：实时动作文本 + 计时器 + 脉冲状态灯
- 光标层：虚拟箭头滑向目标、动作标签、点击涟漪（不移动真实鼠标）
- DSH 内嵌观看卡片：会话期间输入框上方实时显示工作状态、目标应用名称、停止按钮与实时画面流

**引擎命令**（供插件底层调用，也可本地 CLI 直接调试）

```bash
cu windows                                        # 列出屏幕窗口（含 bounds 与层级）
cu snapshot --pid <pid> [--window <id>] [--all]   # 提取无障碍树节点与数字引用（e1, e2...）
cu click --ref e12 --pid <pid> [--button left]    # 后台无焦点点击目标控件
cu type --text "你好"                             # 后台 Unicode / 中文直接输入
cu key --name return [--mods cmd]                 # 快捷键发送
cu shot --window <id> --format jpeg --max-dim 1280# 高效截图
cu halo --window <id> --label "..."               # 渲染目标高亮边框光环
cu capsule --label "..."                          # 顶部置顶非激活胶囊指示
cu preview-stream --window <id>                   # ScreenCaptureKit 低延迟内嵌画面流
cu service [--port 47777]                         # 本地 HTTP 引擎后端
```

## 实测性能

`npm run bench` 是一套固定任务集的基准（demo 窗口，无需第三方 app），数字直接取自工具返回的
`timings`，可重复跑、可比较模型和引擎版本。2026-11-03 的基线（每项 12 次）：

| 任务 | 成功率 | P50 | P95 |
|---|---|---|---|
| AX 快照 | 12/12 | 97 ms | 183 ms |
| ref 点击 + 观察 | 12/12 | 287 ms | 335 ms |
| 输入 + 显式后置条件 | 12/12 | 487 ms | 573 ms |
| 批处理 click→wait→key | 12/12 | 524 ms | 690 ms |
| 窗口截图（冷 daemon） | 12/12 | 346 ms | 398 ms |
| 结束会话 | 12/12 | 0 ms | 1 ms |

首个视觉反馈为 0 ms：光标提示在调用引擎之前就已发给 overlay。
完整的「优化前 → 优化后」与复跑方法见 `docs/bench/README.md`，机器可读结果在
`docs/bench/baseline.json`。

## 设计要点

- **后台优先**：默认通过 AX / `CGEventPostToPid` 操作，不抢焦点、不移动真实鼠标
- **常驻抓屏**：`capture-daemon` 复用 `SCShareableContent` 缓存，按目标尺寸直接出图
- **失败不重放**：动作已派发但观察失败时，保留动作结果并标记 `actionReplaySafe: false`
- **截断可见**：快照超过节点预算时返回 `truncated: true` + `limit`，可用 `maxNodes` 提高
- **观察有节律**：动作后的观察在树没变化时按预算重读（默认 300 ms），并报告 `changed` / `waitedMs` / `reads`；"树动了" 只是重新观察的信号，不等于业务成功
- **后置条件优先**：动作可带 `expect`（或单独调 `cu_expect`），由引擎轮询到条件成立；`cu_batch` 里的 `expect` 步骤就是检查点
- **目标有身份**：每次观察带 `snapshotId`，ref 点击可带上它，快照过期时返回 `stale_snapshot` 而不是命中同名控件
- **坐标有出处**：`cu screens` 给真实显示器可用区域，截图带 `capturedAt` / `displayId`，窗口移动后按实时 bounds 计算 origin
- **用户可中断**：胶囊与光环上的停止键会写入暂停标记，所有变更类动作随即被拦截
- **会话侧栏布局**：进入操作会话时 DSH 窗口缩到右侧三分之一、目标窗口占左侧，结束时自动还原；首次点击也会缩窗但不动目标窗口（避免点击坐标失效）
- **录屏有提醒**：会话期间 DSH 内嵌卡片显示实时录制与操作状态，同时 macOS 升起系统屏幕录制安全指示；结束时自动释放
- **无感生命周期**：原生 Helper 仅在执行期间运行，DSH 退出或插件停用时秒级回收，不留孤儿进程
- **完整回归测试**：内置 239 项自动化回归测试，覆盖生命周期、认证隔离、权限指引和无障碍操控
- **光效不常驻**：边缘呼吸光只在动作时亮起；overlay 进程 2 小时无活动自动退出，不会遗留常驻光斑
- **授权可自愈**：缺权限时给系统设置深链 + 可拖拽应用卡片的引导浮窗；失效授权只在日志有证据且确实缺权限时才重置

## 常见疑问

**源码已更新，但 DSH 仍表现得像旧版本？**

先运行 `npm run dev:sync`，不要靠反复重启或从 GitHub 重装。当前桌面版 DSH 0.2.2-rc.1 已实测支持同一 Host 进程内的 Host 插件重载（官方 `ctx.hmr.runExclusive` + `reconcileProfile`），Client 由 `dsh-client-hmr` 换包，原生 helper 由插件回收重启。`dev:sync` 只有在真实运行版本核对通过时才返回 0。

用 `cu_status.plugin` 区分三部分：

- `plugin.entryPath` 应指向本仓库的 `lib/index.mjs`；`hostPid`/`loadedAt` 是加载这份插件的宿主进程与时间。
- `plugin.sourceHash` 覆盖 `package.json` + 所有 `lib/*.mjs`，不再只覆盖两个文件；它只证明 Host 部分。
- `plugin.client.sourceHash`/`entryRev` 证明 Client bundle；浏览器实际上报的 `rev` 记录在 `plugin.client` 的运行时报告与 `~/.cu/dev-sync/<repo-key>/client.json`。
- `plugin.native.serviceBuildId` 是本次 generation 加载时 `bin/cu` 的 SHA-256；`plugin.native.runningServiceBuildId`/`runningPid` 是实际运行 helper 的身份。原生变更后两者必须一致，且旧 helper 已退出。
- 没有 `plugin` 字段，说明运行的仍是未包含本次诊断的版本。顶层 `version` 属于原生引擎，不能用来判断 JS 插件是否已更新。

如果 `dev:sync` 退出 3，按提示处理：完成/停止活跃 CU 会话，保持 DSH 页面打开后重跑，或如实报告需要重启；不要通过 shell 临时启动常驻引擎来替代插件启动验收。完整限制见 [`docs/dev-sync.md`](docs/dev-sync.md)。

**测试会不会改到我的真实 `~/.cu`？**

不会。`npm test` 通过 `scripts/test-isolated.mjs` 为所有测试进程设置临时 `CU_STATE_DIR`，并在结束后核对真实 `~/.cu/config.json` 与 `pause` 未被修改。在 Node 测试上下文里，没有显式状态目录的 `CuSessionManager` 会直接返回 `test_isolation_required`，而不是启动 helper 去改写真实配置。

**重启后 `cu_*` 工具全没了？**

先看 plugin 链接指向哪里：

```bash
readlink ~/.dsh/profiles/<profile>/node_modules/dsh-super-computer-use
```

DSH 从 profile 的 `package.json` 解析 `dsh-super-computer-use`（`link:<仓库路径>`），重启时按这个路径加载。
如果它指向一个空目录（例如另一个同名工作区），插件整包解析失败，13 个工具和技能会一起消失，日志里不会留明显错误。
把链接改回真实仓库后重装再重启：

```bash
cd ~/.dsh/profiles/<profile>
pnpm add link:/path/to/super-computer-use    # 或手改 package.json 里的 link: 再 pnpm install
```

验证：`readlink` 指向仓库，且 `node -e 'import("dsh-super-computer-use")'`（在 profile 目录下）能打印出 `apply`。
重启后 `cu_status` 应返回 `vision` 与 `lastImage` 字段——没有这两个字段说明跑的还是旧版插件。

**重启后工具还是没起来？先看 `~/.cu/plugin-boot.log`**

宿主在注册每个工具时校验 `parameters` 的 schema DSL，不合法就**抛错**。而注册发生在插件的 `apply()` 里，
所以一个参数写错会让整个插件的 13 个工具一起消失，界面上没有任何错误提示。日志里会留下：

```
module evaluated (pid 12345)
apply() entered
tool cu_click rejected: parameters.expect.additionalProperties must be explicitly true or false
```

DSL 里最容易踩的三条：`type: "object"` 必须显式写 `additionalProperties: true|false`；
每个参数的 `required` 只能写 `true`（不能写 `false` 或数组）；对象的嵌套属性同样要满足这两条。
`npm test` 里的 `test/tool_schema.mjs` 会把全部 13 个工具按同一套规则验一遍，改 schema 后先跑它。


**本插件与旧版独立 Computer Use.app 的区别？**

本插件为 **DeepSeek Harness 专属插件**，现已彻底收敛为单插件交付模式：
- **无需独立 App / 菜单栏**：不再需要安装或运行 `Computer Use.app`，没有外部常驻菜单栏图标。
- **无需系统 launchd 服务**：不再注册 `local.cu.service` 系统守护进程，原生 helper 随 DSH 插件生命周期按需由 Node 托管启动。
- **无需配置全局环境**：不再依赖 `~/.cu/config.json` 或 `~/Library/Application Support/cu/`，认证信息与状态在实例级安全隔离传递。
- **异常退出自毁保活**：Helper 原生支持父进程管道感知（`--watch-parent`），DSH 退出、禁用插件或异常崩溃时，helper 会自动秒级回收，绝不残留孤儿僵尸进程。
- **权限归属明确**：屏幕录制与辅助功能由当前执行组件管理，缺权限时插件直接提示并可一键打开系统隐私设置面板。

## License

MIT
