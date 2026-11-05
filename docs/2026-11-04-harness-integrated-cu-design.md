# DeepSeek Harness 内嵌 Computer Use：本机调查与设计

日期：2026-11-04。状态：**方案，尚未实施；静态接口已核对，桌面宿主接入未实测。**

## 1. 结论

首选在现有 SCU bundle 中增加 Harness Client 模块，使用宿主正式插槽及认证通信。先做可验证的插件接入，再接预览；不要一开始 fork 整个 Harness，也不要直接修改安装包。

目标是接近 Codex 的观看、状态与停止体验，不宣称复制其私有实现或达到相同任务成功率。本轮不增加浏览器扩展、DOM 自动化、任意脚本执行或新的 Agent 框架。

## 2. 本机证据与边界

| 项目 | 实际观察 |
|---|---|
| Harness 安装 | `/Applications/DeepSeek Harness.app`，Electron；`Contents/Resources/app.asar` |
| 包版本 | `@deepseek-ai/dsh-desktop` **0.2.1-rc.5**；nightly；build commit `d4db512a969fccf0c5cc7ec8fe38e9c1d27af916` |
| 安装包摘要 | SHA-256 `8dad52f295bdbe9fa71948fdf38ac2ce3c910213d3b89c37174b2af77db9fb31` |
| 仓库声明 | 随包 `dsh-client-ui-conversation/package.json` 指向 `https://github.com/deepseek-ai/deepseek-harness.git`，源码目录 `packages/client/ui-conversation`，声明 MIT；本次未在线核对或克隆 |
| 源码可用性 | 在本次检查的 Downloads/work 范围未找到完整 Harness checkout；安装包含可读 JS、包文档及插件模板，不等同于完整开发工程 |
| SCU 工作区 | `/Users/johnkwok/Downloads/work/dsh-super-computer-use` |
| 实际插件链接 | `~/.dsh/profiles/desktop/node_modules/dsh-super-computer-use` 指向上述工作区 |
| 最终方案基线 | `main`，`2a0bdb713467e011599e6d56eb8793f6b1ba242e`；调查中发生了外部切分支／合并，执行前重新确认 |

可复核摘录和成员文件哈希见 [本机证据](research/2026-11-04-harness-local-evidence.json)。REA 确认了 ASAR 身份；全量提取返回超过工具传输上限，本方案的接口摘录由直接读取原 ASAR 成员取得。没有启动修改后的 Harness，没有读取用户聊天、密钥或账号配置。

### 已确认的扩展能力

以下路径均相对于 ASAR 内 `dsh/node_modules/@deepseek-ai/`：

- `dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/`：官方随包 UI 插件示例。`package.json` 导出 `./client`，声明 `dsh.client.platform: web`、`immediately: true`、`inject`。
- 模板 `client.js`：`window.__ModuleLoader__.load({ id, factory(require) { ... } })`；从宿主取 React；`ctx.slots.inject` + `ctx.slots.register` 注册 UI。
- `dsh-client-ui-conversation/lib/client.js:20128`：`conversation.composer.dock` 是 **session scope 的 list slot**。
- `dsh-client-ui-layout/lib/client.js:643`：`shell.overlay` 是 **root scope 的 list slot**。它不会自动提供当前聊天身份。
- `dsh-client-connection/lib/index.js:734`：Host `ctx.connection.fetch.register(route)` 可注册精确 Fetch 路由；路径必须在 `/api/` 下，资源随 Context 释放。
- Connection 现有处理链验证 Host/Origin、身份；精确 Fetch route 对非 owner Peer 返回 403。不能另开无认证网页控制入口。
- `dsh-client-connection/README.md`：unary RPC 支持已投影的二进制附件；**二进制参数、事件和流式二进制 RPC 结果不支持**。
- `dsh-api-remotes/README.md`：Remote capability 由编译时导入选择，普通事件断线不重放。不能假设新建服务或 `ctx.emit` 后前端就能访问。

这些是静态能力，不证明外部插件已经在当前 desktop carrier 下成功激活或流式传输。实施计划第一道 gate 专门验证此项。

### SCU 可复用与待补

- `lib/core.mjs`：`CuSessionManager`、`publishActionEvent`、原生预览生命周期、停止闸门、快照差量。
- `lib/index.mjs`：工具注册、`execWithNativeEvents`、`session/event` 生命周期、截图附件。
- `lib/action-events.mjs`：统一动作协议、序号与去重。目前 KINDS 不含 `batch`，而调用方发布 `batch`，先做契约回归；不要照旧报告写“事件已全覆盖”。
- `engine/Sources/PreviewCapture.swift`：SCStream 与原生显示层。**已有原生显示不等于已有网页视频出口**。
- `engine/Sources/VisualFeedback.swift`：光标与点击动画。
- 当前 `apply()` 创建一个 manager；新增 UI 必须明确 Host session 与 CU session 的对应关系。
- `autoDockDsh` 当前默认 true；内嵌观看模式应禁用自动缩放／搬动宿主窗口。

## 3. 产品范围与视觉规范

1. 聊天输入区上方出现当前聊天的操作卡片：应用名、状态、等比预览、展开、停止／接管。
2. 默认卡片宽 320 CSS px，最大不超过容器；12 px 圆角；120 ms 首帧淡入、180 ms 展开收起。这些是我们的设计值，不是测出的 Codex 参数。
3. 展开使用 `shell.overlay` 中宿主范围内的观看面板，显式传递 owner session；不抢占已有 rightbar，不操作目标应用的窗口尺寸。
4. 内嵌模式下关闭重复的原生预览卡片和常驻胶囊；桌面目标描边、代理光标可保留。原生状态窗仍作为其他宿主／前端失联时的停止入口。
5. 网页面板采用宿主主题色、半透明底色和 `backdrop-filter`，只模糊 Harness 页面内背景。**透出桌面的真正原生毛玻璃**需要 Electron 窗口透明／vibrancy 或 AppKit 材质，不能仅用 CSS 宣称实现。本轮不改变整个 Harness 主窗透明度。
6. 预览只用于观看，首版禁止点击预览转发坐标。不要引入未经验证的缩放／Retina 坐标操控。
7. 状态区分：连接中、执行中、等待、已执行未验证、已验证、失败、停止中、已停止、清理状态未知。发送停止请求不等于已停止。
8. 显示缺帧／目标消失／最小化等原因；旧帧标记“最近画面”，禁止标成实时。
9. 中文／英文通过插件 locale；跟随深浅色主题、Reduce Motion；按钮支持键盘焦点。

## 4. 架构决策

```text
Harness Client 插件（React slot 卡片 + overlay）
       │ 已认证 Host Fetch 路由（先验证 desktop carrier）
SCU Host bridge（归属、状态快照、停止、画面代理）
       ├── CuSessionManager → 现有输入引擎 / AX / CGEvent
       └── 常驻 SCStream → 帧编码出口 → 有界代理 → 浏览器解码
```

### 控制与状态

新增 Host bridge，不新建一套动作执行器。UI 与工具调用同一个 manager 的停止服务。每个活动操作有三种独立身份：`hostSessionId`、`cuSessionId`、`targetGeneration`；另有 `revision` 表示 UI 状态版本。

首版一台桌面只允许一个活动控制 owner：别的聊天试图开启时返回 `cu_busy`，不得覆盖 manager 的 target。只观看／切换聊天不自动转移控制权。结束后才允许新 owner；SCU 进程外仍使用已有引擎控制租约，不能把 UI owner 当成全机互斥锁。

所有 UI 数据仅包含必要状态、脱敏标签和画面元数据，不把输入正文、完整工具参数、剪贴板写进可回放事件。状态断线后重新获取快照，不能只依赖消息重放。

### 传输（新增设计，不是已有 API）

选择精确 Host Fetch routes，避免首版引入 Typert 代码生成及改全局 Remote allowlist：

- `POST /api/scu/state`：`{hostSessionId}` → 状态快照；观看时每 250 ms 一次、无重叠请求；非活动聊天停止轮询。
- `POST /api/scu/control`：`{hostSessionId,cuSessionId,expectedRevision,command:'stop'|'takeover'}`；冲突返回 409；停止幂等。`takeover` 首版等价停止自动输入，成功后提示用户自行操作，不再自动激活目标窗口。
- `GET /api/scu/preview?hostSessionId=...&cuSessionId=...`：已认证二进制流。身份标识不是授权凭证；禁用缓存，检查当前 owner，禁止传入任意 pid/window/path。

第一阶段先证明 **桌面版**相对 Fetch、持续 Response body 和 abort 都经过宿主认证及 carrier 工作；若失败，保留 native fallback，进入计划中的最小宿主适配分支，不改为裸连 47777、不伪造 token、不禁用 CSP。

### 画面链路

沿用常驻 SCStream，新增 stdout 帧出口（stderr 只用于诊断），由 Host 启动受控子进程。无需再开网络监听端口。首版使用限帧 JPEG 二进制流：10 fps 目标，最长边 960 px；状态与动画不受视频帧率限制。它是实施目标，不能在测试前声称达到。

帧格式固定为 `uint32BE metadataLength + uint32BE jpegLength + UTF-8 JSON metadata + JPEG`。metadata 包含 `{version:1,frameId,cuSessionId,targetGeneration,geometryVersion,capturedAtNs,pixelWidth,pixelHeight,contentRect}`。metadata ≤16 KiB、JPEG ≤2 MiB；接收方在分配前检查。子进程启动参数由 Host 当前 owner 生成，不接受浏览器提供命令。

Native、Host、Client 各最多保留一个待呈现新帧，慢端丢旧帧；禁止无界队列或连续 base64。Client 用 `createImageBitmap` 解码并绘制 canvas，释放 bitmap；迟到解码按 generation 丢弃。第一帧 1500 ms 内无有效画面则明确降级；大于 2 秒无新帧显示 stale。跨进程时钟不直接相减，端到端延迟用可关联探针／录屏测量。

隐藏／切走聊天时取消观看流并停止无订阅的预览采集；不停止仍被授权的执行任务。宿主断开导致控制上下文消失时停止输入并清理 owner。目标切换丢弃旧 generation，直到新首帧有效才展示新画面。

## 5. 必须通过的完成条件

- 真实 Harness 中插件客户端可见，且当前聊天身份来自宿主 slot/会话 API，不靠扫描 DOM。
- 开始、切目标、点击、输入、等待、停止、重连完整链路；第二聊天不能夺取 owner 或停止第一聊天。
- “停止”立即关闭输入闸门，后续排队动作不执行；本地目标：闸门关闭 P95 ≤200 ms，UI 反馈 ≤300 ms；清理未知如实显示。
- 观看时 10 fps 目标在 30 秒样本中统计实际 delivered FPS；另测工具动作延迟相对关闭预览的基线，P95 回退不超过 20%，否则降低采集／编码成本再验。
- 30 分钟真实会话测试，无持续资源增长、无残留子进程／流订阅；报告起止 RSS、CPU 采样、进程数，不填推测数字。
- 深浅色、窄窗、Retina、多显示器、最小化、目标退出、无权限、宿主重启都覆盖；未测项写未测。
- 不把观看视频作为模型输入，不影响现有按需模型截图；两条链路独立预算。
- 交付版本、引擎 buildId、已安装服务版本分别核对。测试目录构建成功不等于日常应用已升级。

## 6. 不确定项和升级边界

未实测：slot 的运行时 props、桌面 Fetch streaming、外部 Client loader 激活、视频实际 CPU/FPS、宿主版本升级兼容性。Gate 失败时输出具体错误和复现，不继续搭建依赖该能力的 UI。

只有 gate 证明现有插件接口不能承载要求时，才获取声明的 upstream 仓库，对齐已安装 commit，阅读 LICENSE/AGENTS/构建说明；缺失 commit 时明确版本差异。仅改承载缺口的 transport 或新增 slot，使用开发应用／隔离 profile 验证。不能对 `/Applications/.../app.asar` 热补丁作为交付，也不能依赖安装目录 node_modules 永久改动。
