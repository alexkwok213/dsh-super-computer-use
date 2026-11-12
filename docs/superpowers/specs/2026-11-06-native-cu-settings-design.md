# Computer Use 原生入口与系统设置页 — 设计

日期：2026-11-06。状态：**已批准实施（用户「按你判断的做」）**。范围：M0 首版；M1 明确留待后续。

> **后续变更（2026-11-09）**：用户确认「电脑控制」选项已能在「设置」里看到，插件栏不必再展示该一级入口。M0 的 `sidebar.panellist` + `main` 两个插槽注册及对应组件（SidebarIcon / NativePanel）已移除，`settings.section` 保留为唯一入口；`/api/scu/settings` 路由与工具闸门不变。以下正文记录 M0 首版当时的设计决策，仅作历史参考。
>
> **后续变更（2026-11-12）· M1 复核结论**：已实测本机 profile 同时启用 `@deepseek-ai/dsh-cua-bundle`（v0.2.2-rc.2），`cua.getCapabilities` 返回 22 个方法且系统权限已就绪，即 M1 中「核实官方 bundle 是否安装/占用唯一 `computerUse` 名额」的前提已经成立。**结论仍是不注册 provider、不接 `ctx.cuaAccess`**：该 Remote 是 provider-owned，依赖它会把本仓库的发版节奏绑死在 DSH 版本上，且与自有的 `cu_status` 权限位冲突。改为只借鉴官方的界面与交互模式，见下节。

## 0. 后续变更（2026-11-12）· 界面落地 P0 + P1

对照官方 `@deepseek-ai/dsh-cua` 的 `PermissionPanel` / `controller` / `mount` 与宿主插槽契约，本轮完成：

- **P0 详情页载体**：`locale/*.json` 增加 `meta.detail`，新增 `docs/DETAIL.md` / `DETAIL.zh.md` 与 `docs/preview.svg` / `preview.zh.svg`，`icon.svg` 替换 `assets/icon.png` 作为包图标；`package.json` 的 `files` 精确列出这些文件（`docs/` 目录 351MB，不能整目录打包）；README 中过时的「17 个工具」统一修正为 20 个。
- **P1 宿主设计系统**：`client.js` 的 `scu-native-*` 样式改用 `--dsw-alias-*` tokens（l3 边框、radius、32px 区块间距、min-height 80px 行、168px 等宽按钮、骨架占位）。
- **P1 入口**：注册 `plugins.bundle.config`（key = 包名）把设置放到插件详情页，与官方「给 Computer Use 授权」同一位置；`plugins.bundle.activation` 提供启用后引导；`settings.section.icon` 补导航图标。已核实宿主 `config-ledger.ts` 按所有注册 key 生成 bundles 集合，第三方 bundle 可用。
- **P1 状态与交互**：骨架占位、查询失败保留上次观测并标为未确认 + 分区重试、焦点与 `connection/reset` 刷新、全局 Toast、已完成态保存按钮、8 语言字典（en/zh 完整，ja/es/fr/de/ru/pt 覆盖设置区文案并从英文补全键集）。
- **未做**：`README.zh.md` 与 `README.i18n.yaml`（现有 `README.md` 本身即中文；i18n.yaml 是官方 monorepo `verify-translation-pairing` 的 CI 配对记录，本仓库无该脚本，写假哈希反而误导）；按应用授权闭环、责任应用图标、签名公证 `.app` helper 仍属 P2。

## 1. 意图与为什么

用户看到 Claude Desktop 的 Settings → System → Computer use 一组开关，以及本机 `dsh-github-flow` 的「GitHub 全景驾驶舱」一级入口，希望 Computer Use 也「像系统自带」：开关、权限状态、允许/拒绝应用收在一处，并且有一个不依赖聊天窗口的常驻入口。

调查结论（2026-11-06，live Inspect + app.asar 静态核对）：

- Harness 本体已内置 `ctx.computerUse`（唯一 provider 名额）、`ctx.cuaAccess`（`systemStatus` / `requestPermission` / `openSettings` / `applications` 的 allowed·blocked 模型）、`ctx.settings` / `ctx.remote.settings`、以及 Client 插槽 `settings.section` / `settings.general.item` / `sidebar.panellist` / `main`。
- `dsh-github-flow` 靠 `sidebar.panellist`（list，root，`replaceRisk: none`，传 `{size, active}`）+ `main`（keyed，root，按 sidebar entry id 选中央面板）做出一级入口；外壳由宿主绘制，插件只交图标与内容。它**没有**注册 `settings.section`，右上角「设置」是插件自绘弹窗。
- 本插件现状：`Config` 11 项仅存在于插件配置；`client.js` 只注册 `conversation.input.dock` 卡片与 `shell.overlay`；配置/状态在 `~/.cu/`，不是 profile patch；未占用任何一级入口或系统设置页。
- [AGENTS.md](../AGENTS.md) 硬约束：不改 `app.asar`、不新增无认证控制端口、不启动脱离插件管理的常驻服务；每轮改动必须 `npm run release` 全套。

## 2. 目标 / 非目标 / 反目标

**目标（M0）**

1. 左侧栏新增「电脑控制」一级入口，点开是中央面板：当前状态、目标、权限、停止/接管。
2. 宿主设置里新增「电脑控制」分区，含真实生效的偏好：总开关、控制模式、拒绝的应用；以及辅助功能/屏幕录制状态与「打开系统设置」。
3. 偏好改动**不触发插件重载**，不打断正在进行的桌面操作（`.volatile()` + `loader/volatile-update`）。
4. 所有新 HTTP 端点复用现有 `ctx.connection.fetch.register` 已认证链路，不新开端口、不造 token。

**非目标（M0 不做）**

- 不注册 `ctx.computerUse` provider（唯一名额留给后续；与官方 `@deepseek-ai/dsh-cua-bundle` 可能冲突）。
- 不接 `ctx.cuaAccess` Remote（该服务是 provider-owned，本机未实测有实质 provider；调用失败会让设置页变空壳）。权限状态继续用自有 `cu_status` / `openSystemSettings`。
- 不复制 `dsh-github-flow` 的「一键自动升级」：它拉起 `dsh plugin` 子进程改 profile，会绕开本仓库强制的 `npm run release`（三处版本同步 → 隔离测试 → HMR 重载 → helper 回收 / buildId 核验 → GitHub Release）。
- 不做菜单栏图标、系统级防睡眠、主 App 持有 TCC 权限：这三项属于 Electron 主进程 / 需改宿主重签名，被 AGENTS.md 禁止。

**反目标（技术上能跑但算失败）**

- 设置页里出现不接线的假开关。
- 为省事改用 `webServer.register` 直挂 `/api/*`（无 owner Peer 校验）。
- 逐行保存即重载，打断正在执行的 CU 动作。
- 复制一张 Claude 截图当 UI，却把状态存在 `~/.cu/` 并声称「已绑进系统」。

## 3. 架构决策

```text
Client（既有 client.js，同页面可重复执行的 IIFE）
  ├── sidebar.panellist { id:"computer-use", order, label }  → 纯图标（宿主画行/选中态）
  ├── main { key:"computer-use" }                            → ControlPanel（root scope）
  └── settings.section { id:"computer-use", order, label }  → SettingsSection（props { close }）
        │ 所有请求走已认证 /api/scu/*，credentials: same-origin
Host（既有插件）
  ├── Config 增加 4 个 .volatile() 字段
  ├── loader/volatile-update → 刷新运行期 settings 对象，不 reload 插件
  ├── /api/scu/settings POST（挂在 connection.fetch，与 state/control 同一链路）
  │     body { action:"get" }        → 偏好 + 权限状态 + 活动/存储占用（只读）
  │     body { action:"set", patch } → ctx.settings.update("super-computer-use", patch) 写 profile patch
  └── cu_* 工具闸门：enabled=false 拒绝一切非只读工具；
        deniedApps 命中目标应用时拒绝 cu_session start；
        controlMode="full" 决定 hideOtherApps 缺省值
```

**为什么两级 UI 都要**：一级面板解决「一眼看到 AI 在动哪台机器、能马上停」；设置页解决「开关与授权」。`dsh-github-flow` 只做了前者，`dsh-settings` 的 README 明确「no shipped client does so yet」（Config 自动生成表单尚未实现），所以设置页必须自己写 Client 组件，不能指望 schema 自动变成 UI。

**为什么用 `.volatile()`**：AGENTS.md 规定「逐行保存会打断正在执行的操作」。volatile 字段由 Loader 提交进运行中的 fiber，不触发插件 reload；插件监听 `loader/volatile-update` 把新值推给工具闸门与 manager。`dsh-github-flow` 的 `main.js` 已验证这条路径。注意：非 volatile 字段改动仍会整体重载，所以只有「运行中可安全热改」的偏好才标 volatile。

**为什么不用 `cuaAccess` / `computerUse.register`**：权限与应用决策是 provider-owned，本机 profile 的 bundles 里没有 `@deepseek-ai/dsh-cua-bundle`；没有实测 provider 就把设置页接上去，等于用空数据显示「Granted」。M0 用自有 `cu_status` 的真实权限位（有就是有，没有就显示未授权 + 打开系统设置）。M1 在确认 provider 契约与唯一名额后再切。

## 4. 数据与契约

新增 Config 字段（全部 `.volatile()`）：

| 字段 | 类型 | 缺省 | 生效点 |
|---|---|---|---|
| `enabled` | boolean | `true` | `registerCuTools` 包装层：非 `READ_ONLY_TOOLS` 抛 `COMPUTER_USE_DISABLED` |
| `controlMode` | string | `"background"` | `cu_session start` 未显式传 `hideOtherApps` 时，`full` → true，`background` → false |
| `deniedApps` | string[] | `[]` | `cu_session start` 的 `appName` 命中（大小写不敏感）时拒绝，错误码 `APP_DENIED` |
| `unhideOnFinish` | boolean | `true` | 传给 manager，控制 stop 时是否恢复本次调整过的窗口布局；无法证明恢复时如实报 `restoredTarget:false` |

`/api/scu/settings`

- 单个 `POST` 路由，body ≤4 KiB：`{action:"get"}` 或 `{action:"set", patch:{...}}`。没拆成 GET/POST 两条是因为 `connection.fetch.register` 的精确路由以 path 为键，同 path 注册两次会抛 duplicate route；一个 path 两种 action 与现有 `state`/`control` 的契约一致。
- `set` 只接受白名单键；未知键 400；持久化失败返回 502 并带原因，**运行期设置不改动**（不出现"UI 显示已保存、实际没写进去"）。
- 认证：与 `/api/scu/state` 相同，由 `connection.fetch` 的 peer 校验负责；body 不是凭证。
- 已核对 `@deepseek-ai/dsh-settings` 源码：`update(ns, patch)` 的 `ns` 是 **profile entry id**（`entry.options.id`），本插件为 `super-computer-use`；且只有 `.volatile()` 字段会进入可写表单，四个新字段均符合。

Client 插槽注册参数（live Slots 树核对）：

- `sidebar.panellist`：`{ name, id:"computer-use", order: 25, label }`，组件接 `{ size, active }`
- `main`：`{ name, key:"computer-use" }`，组件无需 props（用自有 store）
- `settings.section`：`{ name, id:"computer-use", order: 35, label: () => t(...) }`，组件接 `{ close }`

## 5. 验收

1. `npm test` 全绿；新增隔离测试覆盖：Config schema（含 volatile 读取）、闸门拒绝/放行、deniedApps、settings 路由白名单与 body 上限、Client 注册的 slot id/key 与 IIFE 可重复执行。
2. `npm run dev:sync` 后，真实运行的 Harness 里左侧栏出现「电脑控制」，设置里出现同名分区；`plugin.sourceHash` / `plugin.client.sourceHash` / `entryRev` 三者分别核对，不能用一个字段冒充。
3. 开关关掉后调用非只读 `cu_*` 被拒；重新打开立即恢复（证明是热更新、不是重载）。
4. 权限显示与 `cu_status` 一致；「打开系统设置」走已有 `openSystemSettings`，不新开进程链。
5. `npm run release -- minor` 输出 `[release] RELEASE OK <url>` 且退出码 0。

## 6. M1（后续，需重新评估）

- 核实 `@deepseek-ai/dsh-cua-bundle` 是否安装/是否占用唯一 `computerUse` 名额，再决定注册 provider 还是接它的契约。
- 确认 `ctx.cuaAccess` 有实质 provider 后，把 `allowedApps` / `blockedApps` / `requestPermission` / `openSettings` 换成宿主原生决策。
- 菜单栏状态、系统级防睡眠、主 App 持有 TCC：需上游 PR / fork，本仓库内不做。
