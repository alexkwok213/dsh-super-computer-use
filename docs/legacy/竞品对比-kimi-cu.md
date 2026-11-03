# 竞品对比:Kimi CU (kimi-cu 0.6.8) vs 我们的 cu

日期:2026-10-31。方法:`kimi-cu mcp -s user` 以 stdio JSON-RPC 直连实测;`strings` 与
随包 `node-repl`(TypeScript/JS 源码,完整可读)核对实现机制;我们侧全部走
`127.0.0.1:47777/v1/exec` 活服务实测。两边同一台机器、同一目标窗口
(Claude 桌面 app,pid 80985,Stage Manager 下 off-stage)。

## 1. 拓扑对照

| | Kimi CU | 我们 |
|---|---|---|
| 常驻引擎 | launchd `ai.kimi.cu.service`(`kimi-cu service`),TCC 授权在此 | launchd `local.cu.service`(`cu service`),同 |
| Agent 适配层 | `kimi-cu mcp` stdio 子进程 → Mach 管道/UDS 到 service | `server.py` → HTTP(127.0.0.1:47777, token) |
| 代码模式 | `js`/`js_reset` 工具:常驻 Node kernel(自带 node),cell 内直接 `await import("@kimi/cu")` 连 service,变量跨 cell 持久 | 无(只有 `batch`,声明式步骤) |
| 视觉反馈 | **OverlayDaemon 独立进程**:虚拟光标 + halo + 点击 glow 三个 NSPanel(不占用真实鼠标) | 菜单栏指示器,无光标层 |
| 签名/分发 | Developer ID + notarize + hardened runtime;`LSUIElement` | 自签固定 identity(保 TCC)+ 安装脚本 |

结构性结论:**骨架相同**(常驻 service 持权 + 薄适配层 + 无 UI 主形态),差异全在适配层协议和"执行模型"。

## 2. 同口径实测(2026-10-31,单位 ms)

| 操作 | Kimi CU | 我们 | 备注 |
|---|---|---|---|
| 列窗口 | 1.8 | 5.4(windows 进程内) | 持平 |
| 列运行 app | 18 | 0.9(frontmost 进程内) | 我们无单独 list_apps 快路径 |
| AX 快照(冷) | 596(677 节点,truncated) | 195(462 节点) | 我们快 ~3× |
| AX 快照(热) | 270–293 | 131–136 | 我们快 ~2×,且无 truncated |
| 快照+截图 | 503–710(JPEG,窗内) | ≈131+420(PNG 全屏 1728×1117) | 总和我们略优,**但载荷差 40×**(见 §3.2) |
| 纯截图 | 129–182 | 416–449(PNG) | 我们 JPEG/降尺寸路线有明显活干 |
| 报错短路 | 0.3 | — | 双方都便宜 |
| `js` 本地三连调 | 62(cell 内 3 次调用 + 内部计时) | 对应需 3 次 MCP 往返 | code-mode 单程省 2 个回合 |
| MCP 适配层自身 | stdio+UDS,tools/call 错误路径 0.3ms | HTTP+声明头,exec 错误路径 ~0.3–2ms | 持平 |

注:kimi 在本机 code-mode 当前**起不来**——`js` 报
`NATIVE_PIPE_ERROR: runtime socket connect failed`,kernel 能 spawn(~100ms)但
cell→service 的可信管道无人监听(需其主 app/菜单项拉起 supervisor)。

## 3. Kimi 的机制深拆(值得逐条对照)

### 3.1 服务端默认 diff(最大差异)
每次 `get_app_state` 返回 `tree_text` **和** `tree_diff`/`state_diff`
(结构化 hunks `{start, added, removed}` + 文本 unified diff),`state_revision` 递增、
`diff_base_revision` 指明基,`disable_diff` 才可关。diff 在 Swift 引擎内完成,适配层零成本。
我们的 diff 在 `server.py`(Python)做,service 每次把全量节点重新发给适配层——
99.7KB JSON/次。判定语义我们是 `diff_fields` 全字段比较 + `observe_after` 变化驱动,
这点我们已对齐;**位置不对**:应该下沉到引擎。

### 3.2 截图管线:JPEG + 双上限 + 窗口有界小图
`image/jpeg`;长边≤2048、短边≤1536,原生像素不放大;`rect` 窗内子区域按
**原生分辨率**裁剪(读小字用),返回自带 origin/size 元数据,坐标自动映射回真实屏幕;
`additional_window_ids` 一次最多带 3 张同 app 瞬态窗(对话框/弹层)的 bounded 截图,
每张带 `window_id/z_index/origin`。我们:`shot` 输出 PNG 全屏 815KB(base64 1.09M 字符),
一次 420–450ms。这一条是 token 成本和延迟的双重红利。

### 3.3 观察分页与硬预算
`mode=ax` + `limit`(默认 120 行)/`offset`:同一棵**已保存的历史树**翻页,
`snapshot_id` 续页,页不重采样、不换 index;60s 过期。捕获硬预算:4000 节点、
深度 64、5s、属性文本 2MiB——超限 `truncated` 并给出原因(如 `[closed_menu]`)。
我们无分页(整树直出),预算只有 settle 时间。大 app(剪映主窗 500+ 节点)时
这是控制模型上下文抖动的现成答案。

### 3.4 诚实的验证语义(写进工具文案的纪律)
`click.verify_after` 显式选择加入 AX 后置校验:效果不可观察时返回
`ok:true, verified:false, effect:"unverifiable", verification_required`,文案明说
"**delivered click 永不自动重放**"。strings 里成套:`AXPress delivered once`、
`reply was inconclusive; action may have occurred; no mouse retry; re-observe`。
与我们的铁律一致("tool ok ≠ 操作完成;不确定不重放"),但他们把这条**编码进了每个
工具返回**,模型不用自己记。

### 3.5 输入路由的"语义优先"阶梯
- 命中按钮/菜单:`IndexedButtonAXPress`、`PreferMenuItemAXPressBeforeMouse`、
  `KIMI_CU_ELECTRON_AXPRESS_FIRST`、`AXPressForTypeTextFocus`(Electron/Chromium
  系先试 AXPress,鼠标序列是后备)。
- **cmd 快捷键走菜单**:`cmd+w` 等匹配 app 菜单项时直接 AXPress 菜单项——
  "后台按键永远到不了 macOS 菜单键层",所以他们不伪装按键而是执行菜单命令。
  这是我们剪映链路上迟早会撞的坑(Cmd+C/Cmd+V/Cmd+S 在 postToPid 下不生效)。
- 标题栏拖窗:`drag` 起点在原生窗标题栏时,合成事件无法触发 WindowServer 移动会话,
  改用**校验过的 AXPosition 写入**移窗。
- `press_key` 支持空白分隔批量("cmd+a backspace" 一次调用按序敲)。
- 我们:click 已有 AXPress 决策 + 零尺寸过滤;菜单键、AXPosition 移窗、批量按键没有。

### 3.6 时序参数是给剪辑软件调的
`drag.hold_ms`(按下后先悬停再动——**时间轴上区分"挪片段"和"框选"**)、
`step_ms`、`steps`;`drag_paths` 一次调用画多笔(每笔一次 down/up),中间航点驻留≥35ms
对抗事件合并,`abort_if_cursor_in_window` 安全阀。文案直接点名 timeline editors。
这套就是为剪映类任务设计的,我们剪映验收会立刻用到,而我们 `drag` 只有基础形态。

### 3.7 富文本粘贴与剪贴板归还
`paste.format=text/md/html`,临时剪贴板、用完恢复(`settleClipboard`)。
我们有 paste_text 但无 md/html 通道,也不恢复原剪贴板。

### 3.8 code-mode(js cell)
持久 kernel:top-level 绑定跨 cell 保留;cell 内 `await kimiCU.get_app_state(...)`
直连 service(不过 MCP);官方推荐写法就是"**一个 cell 里做完动作+下一次观察**"
(`nodeRepl.write({action, state})`),并明说"服务端已经 settle 过观察,别加固定
sleep"。工具描述本身就是给模型的纪律文案(不许猜目标、不许重放不确定动作)。
我们的 `batch` 是等价思路的声明式版本,少了解释器和条件逻辑,但也**没有** cell
持久状态;这条是"路由 B/独立 app"里最值得做大的方向。

### 3.9 Overlay 视觉层
不占真实鼠标(`moves_real_pointer:false`)的前提下,用独立 daemon 画虚拟光标、
halo、click glow(GLOW_PT 常量、时间戳驱动动画)。用户全程看得见"它在点什么"。
这是接管焦虑的最有效解法,比我们菜单栏闪烁指示强一个量级。

### 3.10 能力广告与兼容性工程
- `initialize.capabilities.experimental["kimi-cu-runtime"]`:一次性广告
  input_mode/structured_content/state_diff/rich_paste/foreground 策略等 10 个标志,
  客户端按标志路由。
- 参数别名表(window_id/windowId/id、index/element_index、camelCase/snake_case 全兼容),
  注释里记着 2026-09-19 的 agent 事故报告驱动的修正——防御性 API 文案。
- 目标定位统一规则:`window 对象 | app | pid | window_id` 四选一,`screenshot_id`/
  `snapshot_id` 绑观察代次,过期即拒(`stale ids are rejected`)。

## 4. 我们已经更强/持平的地方

1. **AX 遍历绝对速度**(热 131ms vs 270–293ms,冷 195 vs 596),且不 truncated;
   kimi 预算砍出来的是小页,不是全树。
2. **OCR 面**:`ocr`/`ocr_find`/`click_text`/`read_text`——kimi 完全没有 OCR 工具
   (纯靠 AX+像素)。这是我们的独门优势。
3. **变化驱动 observe + observationMs/observationChanged 度量**已落地(kimi 只说
   "service settles",无遥测字段)。
4. **import_media/ImportRunner 业务级批处理**、expect/assert、guards、zoom_window、
   bring_on_stage(Stage Manager 一等公民;kimi 只报 `offscreen_fraction` 然后照打)。
5. 37 个细粒度工具 vs 他们 19 个——粗粒度靠参数组合是他们有意为之,但我们在
   业务链(导入/验收)上的工具更贴合。
6. 声明式调用方归因(round 2)让每次调用比"kimi 每次 tools/call 走 stdio+UDS"更便宜
   的可观测路径(HTTP 直连探针)。

## 5. 借鉴清单(按投入产出排序)

**P0(剪映验收前后就该做)**
1. **diff 下沉进引擎**:snapshot 响应带 `revision` + 增量(hunks + 文本 unified diff),
   `server.py` 只做展示拼接;顺带把 observe 的"无变化"变成模型可见的 1 行 diff。
2. **截图 JPEG 化 + 双上限 2048/1536 + `rect` 原生分辨率裁剪**;`shot` 返回
   origin/size/screenshot_id 元数据,坐标换算收进工具层。
3. **press_key 菜单命令路由**:cmd 组合先查目标 app 菜单(我们已有 `menu` 工具!
   复用其搜索路径),命中即 AXPress 菜单项,查不到再退回合成按键。
4. **drag 参数补齐**:hold_ms(剪映片段移动 vs 框选)、step_ms;之后做 `drag_paths`。

**P1**
5. **AX 快照分页**:limit/offset + snapshot_id 续页 + 60s 过期 + 捕获预算
   (节点数/深度/时间/文本量)显式 truncated 原因。
6. **Overlay 虚拟光标 daemon**(独立进程 + 三层 NSPanel:cursor/halo/glow),
   与 take-over 焦虑和"看得见"体验直接挂钩——属"独立 app"叙事。
7. **paste 富文本通道 + 剪贴板恢复**;`settleClipboard` 语义。

**P2**
8. **initialize 能力广告块**(experimental capability flags),新客户端按标志路由。
9. **code-mode 评估**:常驻 JS/DSL kernel 让"动作+观察+条件"一回合完成。kimi 本机
   实测这条坏了(NATIVE_PIPE_ERROR),方向对但落地成本高——先强化 `batch`
   (支持条件/循环?)更划算。
10. **标题栏移动改校验过的 AXPosition 写入**(补进 `move_window`)。

## 6. 事实与未验证

- 表内数字为本机单轮采样(2–3 次),同一窗口,未做统计;截图像素对比未复核
  视觉质量(kimi JPEG 有压缩损失,`screenshot_detail:"high"` 仍同上限)。
- kimi code-mode 的失败可能是本机缺其主 app 的 supervisor,不代表其设计不可用。
- 我们 `shot` 全屏 PNG vs 其"窗内 bounded"不完全同题:他们按窗裁,我们按屏抓;
  公平对比需要我们实测 `--window` 路径(off-stage 窗被正确拒绝)。
- 未逆向其 overlay 的层级/穿透细节(是否 click-through、全屏遮罩还是跟随面板)。
