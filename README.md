# DSH Super Computer Use

一个仓库、两层代码，给 DeepSeek Harness 提供完整的 macOS 桌面操控能力。

```
DSH  ──加载──▶  本仓库根目录（Cordis 插件，JS）
                      │  HTTP 127.0.0.1:47777
                      ▼
                 engine/（原生 Swift 引擎）──▶ macOS AX / ScreenCaptureKit / CGEvent
```

## 目录

| 路径 | 作用 |
|---|---|
| `lib/` | Cordis 插件：12 个 `cu_*` 工具、会话管理、附件预览 |
| `locale/` `skill/` | 插件文案与技能说明 |
| `test/` | 插件测试（Node） |
| `engine/Sources/` | 原生引擎源码（Swift） |
| `engine/build.sh` | 编译 `engine/bin/cu` |
| `engine/install-app.sh` | 打包并安装 `Computer Use.app`，注册 launchd 服务 |
| `engine/tests/` | 原生回归测试（光环/抓屏/窗口查询/控制台界面） |
| `docs/` | 设计与验证记录；`docs/legacy/` 为合并前两个仓库的历史文档；`docs/demo/` 为演示素材 |
| `docs/ui/` | 控制台界面的对照参考（`reference/`）与改造后截图（`console-after/`） |

## 安装

### 1. 引擎（必须先装）

```bash
cd engine
./build.sh            # 产出 engine/bin/cu，用稳定签名身份签名
./install-app.sh      # 安装 /Applications/Computer Use.app + launchd 服务
```

首次安装后需在「系统设置 → 隐私与安全性」给 **Computer Use.app** 授予
**辅助功能** 与 **屏幕录制** 权限。

签名身份**不随仓库提交**。想做到「重编译不丢授权」，在本机建一个文件：

```bash
security find-identity -v -p codesigning | awk -F'"' '/Apple Development/{print $2; exit}' \
  > engine/signing-identity
```

`engine/signing-identity` 已在 `.gitignore` 中。没有该文件时会退回 ad-hoc 签名
（能跑，但每次重编译 macOS 都会重新询问权限）。也可用 `CU_SIGN_IDENTITY` 覆盖。

校验：

```bash
~/Library/Application\ Support/cu/bin/cu perms
# {"accessibility":true,"screenRecording":true,"ok":true,...}
```

### 2. 插件

```bash
pnpm add link:/path/to/dsh-super-computer-use
```

或在 DSH profile 的 `package.json` 里添加同一条 `link:` 依赖，然后重启 DSH。
重启后 12 个 `cu_*` 工具出现，技能以 `/computer-use`、`/dsh-super-computer-use`、`/cu` 出现在 `/` 菜单。

## 能力

**插件工具（12）**
`cu_status` `cu_windows` `cu_launch` `cu_snapshot` `cu_click` `cu_type` `cu_key`
`cu_scroll` `cu_screenshot` `cu_session` `cu_find` `cu_batch`

**视觉反馈**
- 边缘呼吸光：只在 agent 真正操作时出现的屏幕四边窄光带（蓝→青→紫，约 72pt），停手约 2 秒后自动淡出
- 渐变光环：跟随目标窗口，独立停止面板
- 毛玻璃 HUD：实时动作文本 + 计时器 + 脉冲状态灯
- 光标层：虚拟箭头滑向目标、动作标签、点击涟漪（不移动真实鼠标）

**菜单栏控制台**（菜单栏 `● CU` → 控制台…）

无边框毛玻璃圆角面板，一页看完：应用图标与标题、权限卡片（状态点 / 一键「去授权」+ 可拖拽的悬浮授权引导）、
本地 agent 连接开关（直接写入 / 移除 MCP 配置并回读状态）、服务状态卡（端口、在线客户端、正在做什么、检测 / 重启）。
底部固定版本、暂停与三个图标入口（连接与使用 / 诊断 / 设置）；「＋ 其他 agent」页给出可直接复制的 MCP 配置，
复制后按钮变「已复制」。视觉与交互参考 Claude CU Bridge，对照见 `docs/ui/reference/claude-cu-ui-notes.md`，
改造后截图在 `docs/ui/console-after/`。

![控制台概览](docs/ui/console-after/console-overview-live.png)

界面本身可以被机器验证，不靠肉眼回归：

```bash
cu menubar --selftest-ui                       # 控制台结构的 JSON 断言
cu menubar --snapshot-console /tmp/c.png --snapshot-page overview   # 任一页渲染成 PNG
cu menubar --snapshot-guide /tmp/guide.png     # 授权引导浮窗
```

**引擎命令**（除插件外也可直接用）

```bash
cu windows | snapshot --pid <pid> [--window <id>] [--max-nodes 1500] [--no-actions]
cu click --ref <ref> --pid <pid> [--background]
cu shot --window <id> --format jpeg --max-dim 1280
cu halo --window <id> --label "..." | cu capsule --label "..." | cu cursor-overlay | cu capture-daemon
cu agents | agents-connect [--id …] | agents-disconnect [--id …]
cu menubar [--open-settings] | --selftest-ui | --snapshot-console <png> | --snapshot-guide <png>
```

## 实测性能（同一台 Mac，中位数）

| 指标 | 优化前 | 优化后 |
|---|---|---|
| 点击 + 观察 + 预览（端到端） | ≈1400 ms | 472 ms |
| 快照 · 全树 498 节点 | 892 ms | 206 ms |
| 窗口截图 · 全屏窗口 | 296 ms | 75 ms |
| 会话启动 | — | 107 ms |

详见 `docs/superpowers/plans/2026-11-02-cu-visual-refresh.md`。

## 设计要点

- **后台优先**：默认通过 AX / `CGEventPostToPid` 操作，不抢焦点、不移动真实鼠标
- **常驻抓屏**：`capture-daemon` 复用 `SCShareableContent` 缓存，按目标尺寸直接出图
- **失败不重放**：动作已派发但观察失败时，保留动作结果并标记 `actionReplaySafe: false`
- **截断可见**：快照超过节点预算时返回 `truncated: true` + `limit`，可用 `maxNodes` 提高
- **用户可中断**：胶囊与光环上的停止键会写入暂停标记，所有变更类动作随即被拦截
- **控制台不粘焦点**：只有你点开控制台时才激活窗口；关掉后立即把焦点还给之前的应用
- **界面可回归**：`--selftest-ui` / `--snapshot-console` / `--snapshot-guide` 让每次改版都有断言与截图证据
- **光效不常驻**：边缘呼吸光只在动作时亮起；overlay 进程 2 小时无活动自动退出，不会遗留常驻光斑
- **授权可自愈**：缺权限时给系统设置深链 + 可拖拽应用卡片的引导浮窗；失效授权只在日志有证据且确实缺权限时才重置

## 常见疑问

**启动台/应用程序里的 “Computer Use” 是什么？可以删吗？**

它就是引擎本体：launchd 后台服务（`local.cu.service`）、菜单栏助手（`local.cu.menubar`）、
**辅助功能/屏幕录制两项权限的宿主**，以及控制台窗口，全都在这个 app 里。DSH 插件只是适配层，
通过 `127.0.0.1:47777` 调用它。删掉 app 的话，`cu_*` 工具、胶囊/光环/光标层和控制台会一起失效。

它故意不占 Dock（`LSUIElement`），但启动台会列出 `/Applications` 下的应用，所以能看到它：

- 从启动台/应用程序打开它 = 打开控制台，同时确保菜单栏的 `● CU` 在跑。
- 菜单栏里的「退出菜单栏」只退出菜单栏助手，后台服务继续工作；重新打开 app 即可恢复。
- 早期版本 `build/` 目录下的复制品被删除后，可能在启动台留下点不开的“幽灵”图标；
  系统注册信息可以用 `lsregister -gc` 清理（或重装一次）。

## 历史

本仓库由两个旧仓库合并而来：

- `computer-use` —— 原生 Swift 引擎（现位于 `engine/`）
- `dsh-computer-use` —— DSH Cordis 插件（现位于仓库根）

两者的 git 历史保留在原仓库中，本仓库以合并后的完整形态作为唯一维护入口。

## License

MIT
