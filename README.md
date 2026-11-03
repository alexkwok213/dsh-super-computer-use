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
| `engine/tests/` | 原生回归测试（光环/抓屏/窗口查询） |
| `docs/` | 设计与验证记录 |

## 安装

### 1. 引擎（必须先装）

```bash
cd engine
./build.sh            # 产出 engine/bin/cu，用稳定签名身份签名
./install-app.sh      # 安装 /Applications/Computer Use.app + launchd 服务
```

首次安装后需在「系统设置 → 隐私与安全性」给 **Computer Use.app** 授予
**辅助功能** 与 **屏幕录制** 权限。签名身份固定，重编译不会丢授权。

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
- 全屏柔光：蓝→青→紫径向边缘辉光，中心透明
- 渐变光环：跟随目标窗口，独立停止面板
- 毛玻璃 HUD：实时动作文本 + 计时器 + 脉冲状态灯
- 光标层：虚拟箭头滑向目标、动作标签、点击涟漪（不移动真实鼠标）

**引擎命令**（除插件外也可直接用）

```bash
cu windows | snapshot --pid <pid> [--window <id>] [--max-nodes 1500] [--no-actions]
cu click --ref <ref> --pid <pid> [--background]
cu shot --window <id> --format jpeg --max-dim 1280
cu halo --window <id> --label "..." | cu capsule --label "..." | cu cursor-overlay | cu capture-daemon
```

## 实测性能（同一台 Mac，中位数）

| 指标 | 优化前 | 优化后 |
|---|---|---|
| 点击 + 观察 + 预览（端到端） | ≈1400 ms | 472 ms |
| 快照 · 全树 498 节点 | 892 ms | 206 ms |
| 窗口截图 · 全屏窗口 | 296 ms | 75 ms |
| 会话启动 | — | 107 ms |

详见 `docs/2026-11-02-cu-visual-refresh.md`。

## 设计要点

- **后台优先**：默认通过 AX / `CGEventPostToPid` 操作，不抢焦点、不移动真实鼠标
- **常驻抓屏**：`capture-daemon` 复用 `SCShareableContent` 缓存，按目标尺寸直接出图
- **失败不重放**：动作已派发但观察失败时，保留动作结果并标记 `actionReplaySafe: false`
- **截断可见**：快照超过节点预算时返回 `truncated: true` + `limit`，可用 `maxNodes` 提高
- **用户可中断**：胶囊与光环上的停止键会写入暂停标记，所有变更类动作随即被拦截

## 历史

本仓库由两个旧仓库合并而来：

- `computer-use` —— 原生 Swift 引擎（现位于 `engine/`）
- `dsh-computer-use` —— DSH Cordis 插件（现位于仓库根）

两者的 git 历史保留在原仓库中，本仓库以合并后的完整形态作为唯一维护入口。

## License

MIT
