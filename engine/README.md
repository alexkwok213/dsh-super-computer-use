# cu-standalone — 独立版 Computer Use（macOS）

多人及多个 AI 协作前，请先查看 [协作记录](协作记录.md)，其中记录近期实测、已知问题与待验证事项。想快速了解「为什么这样设计、踩过哪些坑」，看 [经验沉淀](经验沉淀.md)。2026-10-29 那次「前台被占用 + 客户端接入验证」的完整排障过程与测量数字，见 [对话档案](对话档案-2026-10-29.md)。提交与推送 GitHub 的完整流程（哪些本地改动不能提交、提交前净化、推送命令、远端校验）见 [GITHUB同步](GITHUB同步.md)。

一个不依赖任何其它应用的"电脑操作"小引擎：能截图看窗口、能读界面上的按钮文字、能点击/拖拽/打字/按键/滚动，还能在正在操作的那个窗口上画一圈高亮并显示应用名（Claude 里那个"小指示"的同类）。外壳是一个标准 **MCP stdio server**，任何支持 MCP 的 AI 应用（含各种 harness）挂上配置即可用。

全部代码是我们自己的，只用苹果公开接口：Accessibility（读界面）、CoreGraphics 事件（模拟鼠标键盘）、ScreenCaptureKit（截图）。MIT。

## 一、构建

要求：macOS 14+、Xcode 命令行工具（`xcode-select --install`）。

```sh
cd cu-standalone
./build.sh          # 编译 bin/cu，并用 Apple Development 证书签名（没有证书时退回 ad-hoc）
./bin/cu perms      # 看两个权限是否已开
```

`perms` 会打印当前的辅助功能/屏幕录制授权状态。两项都是 `true` 才能完整工作。

一键安装与自检：`./install.sh`——编译、签名、跑一次 `selfcheck`（权限/暂停/系统遮挡/允许清单/窗口统计），并检查 WorkBuddy 的 MCP 配置是否已指向本目录。

`cu selfcheck` 随时可单独跑，输出里 `nextSteps` 会直接告诉你还缺什么。

## 二、授权（只需一次）

系统设置 → 隐私与安全性：
- **辅助功能**：给"运行它的程序"（终端、或宿主 App）打勾。缺它 → 读不了界面、点不准。
- **屏幕录制**：同上。缺它 → 截图全黑或直接失败。

> 授权是按"宿主进程"记的：从终端跑就授权终端；被某个 App 拉起就授权那个 App。

## 三、命令行直接试

```sh
./bin/cu apps                                      # 运行中的应用（含 bundle id）
./bin/cu launch --app com.apple.TextEdit           # 按 bundle id/名称/路径启动或聚焦
./bin/cu windows                                   # 列窗口（含当前前台是谁）
./bin/cu frontmost                                 # 当前前台应用
./bin/cu activate --window <id>                    # 把某个窗口的应用调到前台
./bin/cu snapshot --pid <pid>                      # 控件树：k0.3.2 …（服务端做差分）
./bin/cu click --pid <pid> --ref k0.3.2            # 有 AXPress 就按，否则点中心（e12 也兼容）
./bin/cu setvalue --pid <pid> --ref k0.3.2 --text "…"  # 直接给输入框赋值并读回
./bin/cu selecttext --pid <pid> --ref k0.5.1 --text "关键词"  # 选中输入框里的文字
./bin/cu action --pid <pid> --ref k0.3.2 --name AXShowMenu
./bin/cu paste --pid <pid> --text "多行文本…" --background   # 后台：走 AX 插入，不碰剪贴板；不带 --background 才用剪贴板
./bin/cu clicktext --window <id> --text "开始素材"   # 一次调用：找文字→按控件动作（后台），找不到再交给 OCR
./bin/cu findtext --window <id> --text "关键词"      # 只查文字和坐标，不点
./bin/cu readtext --window <id> --limit 200         # 整窗文字（来自控件树，约 0.25 秒）
./bin/cu movewindow --window <id> --x 460 --y 315 [--w 900 --h 600]   # 后台移动/缩放窗口
./bin/cu clients                                    # 谁连着 CU、最近做了什么
./bin/cu shot --window <id> --out /tmp/a.png       # 截窗口；返回 origin/size/scale
./bin/cu shot --screen --out /tmp/full.png         # 截整屏
./bin/cu ax --pid <pid> --find "搜索"              # 找控件（自动丢掉 0 尺寸的菜单项）
./bin/cu click --x 500 --y 300 --window <id>       # 先调前台、确认成功再点
./bin/cu type --text "你好"                        # 打字（中文可用）
./bin/cu key --name return --mods cmd              # 按键
./bin/cu scroll --dy -600                          # 滚动
./bin/cu halo --window <id> --seconds 8 --label "Safari — 正在滚动"
                                                   # 高亮+应用名，会跟着窗口移动
./bin/cu capsule --label "Safari — 自动操作中"      # 右上角浮动脉胶囊（默认指示器）
```

所有输出都是一行 JSON。坐标一律是"屏幕逻辑点、左上角原点"。

**后台执行（默认）**：`click`/`type`/`key`/`scroll` 默认在**后台**执行——不激活、不抢前台，用控件动作和按进程定向的事件直接发给目标应用，你可以继续用别的窗口。实测：微信保持前台的情况下，后台向 TextEdit 点击+输入 5 轮，全部落字且前台始终是微信。需要老的前台行为时加 `foreground: true`（CLI 为 `--foreground`）。`paste_text` 走系统剪贴板，必须前台。

**截图默认会缩放**：长边 1600 像素。返回里的 `scale` 已经按缩放后的图算好，`全局点 = origin + 像素/scale` 这条公式不用改。需要原始分辨率时传 `maxDimension: 0`。

**只想看局部就用 `region`**：`screenshot` 多了 `region: {x, y, width, height}`（全局逻辑点），在已经拍到的像素上裁，不再多发一次截图。实测同一个窗口：整窗 214 KB → 局部 47 KB（22%），而每像素清晰度不变——"放大看按钮"应该传 region，而不是截大图再缩放。`format: "jpeg"` + `quality`（默认 0.82）走 JPEG 编码，照片型界面实测体积是 PNG 的 1/3 左右；`screencapture` 直接写 JPEG，省掉一次 PNG 编码 + 解码。返回里的 `origin/size/scale` 会跟着裁剪后的图重算，坐标公式不变。

**截图坐标怎么换算**：`shot` 返回 `origin`（截图区域左上角的全局坐标）、`size`（逻辑尺寸）、`scale`（像素/点，Retina 是 2）。看图里某点的像素坐标 `(px, py)`，全局点 = `origin + (px, py) / scale`。

**第一次点击为什么会被吞**：macOS 会把"非前台应用的第一下点击"交给窗口边框，而不是下面的按钮。所以 `click --window <id>` 现在会先把该应用调到前台，**确认它真的在前台**才点；如果没抢到前台会直接报 `not_frontmost` 而不是盲点（`--force` 可以强行点）。

## 四、接进 MCP 客户端

把 [`examples/mcp-config.json`](examples/mcp-config.json) 里的内容合并到你的 MCP 客户端配置里（servers 列表），路径按实际目录改，然后重启客户端。它提供 37 个工具：

| 工具 | 作用 |
| --- | --- |
| `list_apps` | 正在运行的应用（pid、名称、bundle id、是否前台） |
| `launch_app` | 按名称 / bundle id / .app 路径启动或聚焦应用，返回 pid |
| `snapshot` | 支持 `windowId` 只读某个窗口（同应用多窗口同名时用它消除歧义）；首次返回完整控件树（`k0.3.2` 路径编号，附带角色/标题/位置/AX 动作），顶部先列出所有输入框；之后**只回变化**（+新增 -删除 ~变化），没变就一句「no change」，编号继续有效；`full: true` 强制全量。对 Chrome/Electron 会自动打开它们的辅助功能树（`AXManualAccessibility`），否则这些应用的树是空的 |
| `list_windows` | 列出屏幕上的窗口（应用名、标题、id、pid、位置尺寸、是否前台），支持按应用名过滤。CGWindowList 看不到的 sheet/进度弹窗（例如剪映的「导入素材」）会以 `axOnly: true`、`windowId: 0` 附上，范围是前台应用（或 `pid` 指定应用），只能用应用级 AX 查询访问 |
| `screenshot` | 截窗口或整屏，返回 PNG/JPEG + `origin/size/scale`；默认把长边缩到 1600 像素（实测体积从 4.2 MB 降到 1.1 MB，坐标公式不变），`maxDimension: 0` 取原始分辨率。`region: {x,y,width,height}` 只截局部（同窗口实测 22% 体积，细节不变），`format: "jpeg"` + `quality` 走 JPEG（约 PNG 的 1/3） |
| `activate_window` | 把某个窗口的应用调到前台，并告诉你是否成功 |
| `menu` | 列出应用的菜单树；或按 `菜单/条目` 路径点菜单项（标题像“关闭/删除/退出”的默认拒绝，需 `confirm: true`） |
| `ax_find` | 按文字找控件——与 `snapshot` 用同一棵深树（含 Chromium/Electron 的 20 层以上网页内容与 description 标签），结果直接带 k-ref 和 actions；0 尺寸的菜单项默认丢弃，`all: true` 保留 |
| `click` | 默认后台：`ref` 有 `AXPress` 就直接按，否则按进程发送鼠标事件；不抢前台。给 `foreground: true` 才调前台并做焦点/幻影光标那套 |
| `click_text` | 一次调用完成“按文字点控件”：先在该窗口的辅助功能树里找（控件优先于静态文字），有 `AXPress` 直接按，否则按元素坐标发后台点击；树里找不到才截屏 OCR。**实测 0.37–0.40 秒**，OCR 兜底约 1.2 秒 |
| `ocr_find` | 找文字并返回全局坐标：辅助功能树优先（约 0.2 秒），没有才走 OCR（约 0.7–0.9 秒）；返回 `matches` 和可见文本 `lines` |
| `read_text` | 整窗文字清单：先读控件树（约 0.25 秒），文字太少才截屏 OCR（约 0.7 秒）；适合一次性读取界面内容 |
| `set_value` | 直接给输入框赋值（不经过焦点和键盘），并读回确认 |
| `select_text` | 在输入框里选中指定文字（可用前后缀消歧），或把光标放到它前/后 |
| `perform_action` | 调用控件暴露的 AX 动作（如 `AXShowMenu`、`AXIncrement`），只能用快照里列出的 |
| `expect` | 断言应用真的变成了某个状态（`enabled`/`value`/`contains`，按 ref 或按文字定位，轮询到 `timeoutMs`）——做完一步用它确认，不要只信 ok |
| `paste_text` | 带 `pid` 时默认后台：依次尝试 AX 选区插入 → AX 值写入 → **应用自己的右键菜单“粘贴”**（Electron/React 输入框前两条都拒绝时仍可用），每一步都读回确认；`foreground: true` 才用剪贴板粘贴（支持 text/html，结束还原剪贴板） |
| `type_text` | 默认后台按进程输入；带 `pid` 时读回校验，没落字自动改用 AX 赋值。`foreground: true` 走剪贴板粘贴那条更稳的路径 |
| `press_key` | 默认按进程发送按键（不抢前台），支持 cmd/shift/opt/ctrl 组合 |
| `scroll` | 滚轮；带 `pid` 时默认按进程发送 |
| `drag` | 拖拽（选文字、拖控件）。带 `windowId`/`pid` 时默认后台按进程发事件；**移动窗口请用 `move_window`**——AppKit 只对活动窗口启动标题栏拖动，后台拖拽不会真的移动窗口 |
| `start_session` | 开始一次会话：清掉暂停标记、在目标窗口画常驻高亮（应用名 + 停止键）、可选遮挡层 |
| `stop_session` | 结束会话，移除高亮/遮挡 |
| `resume` | 清除用户按“停止”留下的暂停 |
| `cover_window` | 只画遮挡层（挡住用户对那个窗口的点击），不开始完整会话 |
| `bring_on_stage` | Stage Manager 下把窗口带到当前舞台（必要时点它的缩略图），回报是否已可见 |
| `bring_to_current_space` | 激活应用 + `AXRaise`，把窗口带到当前桌面 |
| `highlight_window` | 画一条高亮（轻量版，不建会话） |
| `cursor_position` | 当前鼠标位置 |
| `release_mouse` | 松开按住的鼠标键（拖拽被打断时兜底） |
| `zoom_window` | 按窗口的缩放/全屏按钮（AX 动作，后台） |
| `move_window` | 通过 AX 设置窗口位置/尺寸，**完全后台**：不激活、不动鼠标、焦点不变（实测 +60/+40 精确生效，前台仍是原应用） |
| `guards` | 报告安全层看到的状态：是否开着安全输入、用户多久没动键鼠、是否被暂停 |
| `selfcheck` | 一次给出权限、暂停、系统遮挡、允许清单、窗口统计和下一步建议 |
| `batch` | 一次调用里按顺序跑多个工具，默认遇错即停（省往返） |
| `import_media` | 一次调用把文件逐个导入打开面板的应用（默认剪映素材库）：Cmd+I → Cmd+Shift+G → 清空输入 → 写完整路径 → 点字段回车 → 等「导入」可用 → 点击 → 等素材库出现该条目。每一步读回校验；素材库里已有的文件跳过；首个失败即停并收起面板；`dryRun: true` 只选到「导入」可用就收起面板、不导入。目录一律拒绝（在打开面板里双击文件夹会递归导入整个目录）。目标应用会被激活，原生打开面板需要键盘焦点 |

**推荐工作流**（从 Qoder 的 computer-use 设计里借鉴）

1. `list_apps` 或 `list_windows` 找到目标，拿到 pid；
2. `snapshot` 拿控件树 —— 有 `k0.3.2 AXButton "开始创作" [AXPress]` 这种就直接 `click(ref: "k0.3.2")`；
3. 每一步动作后**重新 `snapshot`**：默认只回变化（省 token），没变的编号继续有效；只有 `full: true` 才会重新编号；
4. 界面是自绘的（剪映、游戏、部分 Electron 应用）时，辅助功能树很稀，退回 `screenshot` + 坐标点击；
5. 密码框（`AXSecureTextField`）一律拒绝操作，这是硬保护，不提供绕过开关。

## 五、安全层（对齐 Claude 的“点之前先判断”）

每次点击/打字/按键/粘贴/滚动前都会过同一套检查，拒绝时返回和 Claude 同一套原因词：

| 原因 | 什么时候出现 |
| --- | --- |
| `secure_input_active` | 系统开着“安全键盘输入”——一律不动作。判定读系统会话状态；触发它的公开 API 已被 Apple 移除，未现场触发（密码框那一层已实测拒绝） |
| `not_frontmost` | 目标应用没抢到前台；宁可拒绝也不盲点 |
| `another_window_on_top` | 点击位置上盖着别的应用的窗口 |
| `point_outside_any_window` | 坐标那里没有任何窗口 |
| `sheet_or_modal_on_target_window` | 目标上开着模态框/Sheet，先关掉（`ignore-sheet` 可跳过）。实测：自建窗口弹 Sheet 后被正确拦截 |
| `app_hidden` / `app_gone` | 应用被隐藏或已退出 |
| `occluder_fills_screen` | 有系统层覆盖整屏（Mission Control 等），此时不动作 |
| `off_stage_window` | 目标是 Stage Manager 舞台外的缩略图，先用 `bring_on_stage` 把它带到舞台上；或对 `type_text`/`press_key`/`paste_text` 传 `tryOffstage: true` 尝试投递（只有应用状态真的变化才算成功） |
| `control_disabled` | 控件处于禁用态——它的 `AXPress` 是空操作，宁可拒绝也不报假成功（`force: true` 可跳过）。实测：聊天应用的灰色“发送”按钮 |
| `ref_outside_window` | 控件坐标落在该应用任何窗口之外（树是旧的，常见于台前调度切换后），重新快照再点 |
| `user_recently_active` | 你在它上一次动作之后动过键鼠/点在它上（`retryAfterMs: 400`）。这是 Claude 同款的“用户介入就暂停”，重试即可；批量场景可设 `CU_NO_USER_PAUSE=1` |
| `paused_by_user` | 用户在高亮条/遮挡层上按了停止；`resume` 之前一律不动作 |
| `window_off_space` | 应用没有窗口在当前桌面（在别的 Space） |
| `focused_window_mismatch` | 等待点击的那几十毫秒里焦点被抢走了 |
| `destructive_menu_item` | 菜单项标题像“关闭/删除/退出/清空/卸载”，需要显式 `confirm` |
| `app_not_allowed` | 设了允许清单且目标不在清单里 |

**会话与“停止”**：第一次对某个应用动手时，会自动挂出指示器，不用手工 `start_session`；不想要就设环境变量 `CU_AUTO_HALO=0`。默认是**右上角的浮动脉胶囊**（300×44，"应用名 — 自动操作中"+ 停止键），和 Claude 里那个小指示一样：不盖住被操作的应用、不跟窗口跑、4 秒才刷一次状态，停下来的代价几乎为零。想要老的"整窗高亮框"就设 `CU_CAPSULE=0`（或配置里 `"capsule": false`），它会把高亮条贴在目标窗口上并跟着窗口移动。两种指示器上的停止键，点下去等于 Claude 的"停止操作"——引擎写一个 60 秒的暂停标记，期间所有动作都返回 `paused_by_user`，直到 `resume`。遮挡层（`cover`）则是把目标窗口盖住、顺便挡住你的误点。**这三种指示器都不会成为前台应用**：AppKit 启动一个不带窗口的进程时会顺手把它激活，引擎在药丸/高亮框/遮挡层各自启动后把焦点交还给原来的前台应用（`tests/focus_probe.command` 里能看到修复前后的差别），菜单栏 App 也在被误激活时主动交还。

**一点如实说明**：Claude 会在你刚动过键鼠时“暂停一下”。这版把“用户多久没动键鼠”放在 `guards` 里报告，但没有据此拦截——因为引擎自己合成的点击也会被系统记成“最近有输入”，拦截会把自己卡死。这是公开 API 的能力边界，不是漏做。

**允许清单（相当于 Claude 的“逐应用授权”）**：`~/.cu/allowed-apps.json`。空/不存在 = 全部允许；`cu allow --app com.apple.Notes` 添加，`--remove` 移除，`cu allowed` 查看。清单非空时，不在名单里的应用一律拒绝。

## 六、和 Claude / open-computer-use 的差别（实话）

- **元素引用**：这版借鉴了 Qoder computer-use 的做法——`snapshot` 给每个控件编号，点控件优先用控件自己的 `AXPress`，不用猜坐标；编号只对最近一次快照有效，旧编号会明确报 `stale_ref`。
- **指示层**：窗口高亮 + 应用名 + 停止按钮，跟随窗口移动；open-computer-use 只有假光标、没有名字也没有停止按钮。
- **点前检查**：已对齐主要项——安全输入、前台确认、坐标被遮挡、模态框/Sheet、隐藏/退出、破坏性菜单项、逐应用允许清单，拒绝原因用 Claude 同款词。仍未做：Chromium 专用输入通道、窗口内容遮盖（`showCoverForWindow`）。
- **动作层**：批量（`batch`）、菜单遍历（`menu`）、幻影光标、缩放/松开鼠标都已具备；仍缺：窗口遮盖（`showCoverForWindow`）、把窗口搬到当前 Space、Chromium 专用输入通道。

## 六、目录

```text
cu-standalone/
  Sources/main.swift   引擎：截图 / 辅助功能 / 输入 / 高亮，单文件
  bin/cu               编译产物（./build.sh 生成）
  mcp/server.py        MCP stdio 外壳（纯标准库，无依赖）
  mcp/tools.json       导出给服务 /v1/tools 的工具表（由 sync_tools.py 生成）
  mcp/sync_tools.py    改完 server.py 的 TOOLS 后跑一次，别手改 tools.json
  tests/               回归脚本：server_units / guards 是纯逻辑，不碰桌面；
                       smoke_new / stability / background / window_ops 要一个真实窗口
  examples/mcp-config.json
  build.sh
```

工具表有两份（Python 的 `TOOLS` 和服务读的 `tools.json`），曾经因为默认值漂移过（截图长边 1280 vs 1600）。现在以 `server.py` 为准：`python3 mcp/sync_tools.py` 会把 `TOOLS` 写进 `tools.json`，内容没变就什么都不做；`install-app.sh` 会把它复制到 `Application Support/cu/`。

## 八、与 Claude 的工具逐项对照

Claude 的 Computer Use 在客户端里暴露的工具名是 `app_*` 一套；下表左边是它，右边是我们这边的等价物，最后一列是实测证据。

| Claude | 本插件 | 验证 |
| --- | --- | --- |
| `app_list_windows` | `list_windows` | 一次列出 18 个窗口（含标题/坐标/前台标记） |
| `app_screenshot` | `screenshot` | 抓 Qoder 窗口 3020×1600 PNG，返回 origin/size/scale |
| `app_ax_find` | `snapshot` / `ax_find` | Qoder 203 节点、Chrome 729 节点；输入框置顶摘要 |
| `app_click` | `click` | 连跑 20 轮点击零失败；优先 `AXPress`，否则点中心 |
| `double_click` | `double_click` | `click` 的 `count=2` 别名 |
| `app_type` | `type_text` | Unicode 优先，没落字自动改走剪贴板粘贴并复检（TextEdit 实测触发） |
| `app_key` | `press_key` | 稳定性测试每 4 轮用 `cmd+a` 全选 |
| `app_scroll` | `scroll` | 已实现（受目标窗口内容长度影响，肉眼无变化不代表失败） |
| `app_drag` | `drag` / `move_window` | `drag` 保留给控件/选字；窗口移动用 `move_window` 走 AX 位置属性：实测 +60/+40 精确移动，前台和光标都不变。pid 事件的标题栏拖拽在 AppKit 上不生效，已实测确认 |
| `app_menu` | `menu` | 列出 Qoder 6 个菜单；点条目优先按菜单项实际坐标点击（Chromium 对 AXPress 不响应），拿不到坐标才退回 `AXPress`；破坏性标题默认拒绝 |
| `app_zoom` | `zoom_window` | 后台按缩放按钮（改为递归找 `AXZoomButton`）；实测 520×452 → 1728×994，再按一次还原 |
| `app_focus` | `activate_window` | 失败时回退 LaunchServices `open -b`，实测把 TextEdit 拉到前台 |
| `app_release` | `release_mouse` | 在当前位置松开左键 |
| `cursor_position` | `cursor_position` | 返回全局点坐标 |
| `app_bring_to_current_space` | `bring_to_current_space` | 激活 + `AXRaise` + 回报是否在屏 |
| `app_batch` / `computer_batch` | `batch` | 三步串跑通过，遇错即停 |

行为层面对照：会话指示条（自动出现、跟随窗口、× 停止）、停止即暂停（`paused_by_user`）、遮挡层、逐应用允许清单、安全输入拒绝、前台二次校验、模态框检查、跨桌面检查、破坏性菜单项确认、Chromium/Electron 树打开、差量快照、稳定等待、幻影光标——均已实现并在上文给出实测或机制说明。

**Stage Manager**：`list_windows` 会给舞台外的窗口标 `offStage: true`；对这些窗口的点击会被拒绝（`off_stage_window`），不会误点缩略图；`bring_on_stage` 可以按需切舞台。`click` 支持 `dryRun`，只跑检查不落地。

**仍未对齐的**：Claude 的 `keyWindowSpoof`/合成器唤醒这类 Chromium 私有通道（实测通用路径已够用，未复现需要它的场景）；空闲暂停只报告不拦截（公开 API 无法区分合成事件）。


### 这轮测试暴露的四个缺陷（都已修）

| 症状 | 根因 | 修法 |
| --- | --- | --- |
| Electron 应用只返回 3 个红绿灯按钮 | `SNAP_DEPTH = 10` 太浅，网页内容在 10 层以上匿名 `AXGroup` 里 | 提到 24，`SNAP_VERSION` 升 2 |
| `cu launch` 起 Electron 应用后进程消失 | 本 shell/服务带 `ELECTRON_RUN_AS_NODE=1`，被继承 | `launch` 复制环境并剔掉该变量 |
| 菜单显示「客户端：无」，其实刚连过 | 会话一退出记录就删，只列活着的 | 记录保留并标 `alive=false`，控制台加「状态」列显示 在线/已退出，6 小时后才清 |
| 「谁动了我的前台」答不出来 | 命令行直连不经过服务，`service.log` 里没有 | 新增 `~/.cu/actions.log`：每个动作和每次 `activate` 都记一行（含当时前台是谁） |

还有一个安装缺陷：`install-service.sh` 原来用 `cp` 直接覆盖 `$SUPPORT/bin/cu`。**覆盖正在运行的二进制会让它的签名映射失效，之后每次 exec 都被内核 SIGKILL（rc 137），LaunchAgent 也拉不起来**——这轮测试末尾服务就是这么挂掉的。现在改成写到 `.new` 再 `mv -f` 原子替换，旧 inode 对还在跑的进程保持有效。

### 实测：CU ↔ WorkBuddy 双向打通（2026-10-29）

用 CU 反向操控 WorkBuddy（Electron，v5.9.3），全程后台、不动鼠标：

| 步骤 | 命令 | 实测 |
| --- | --- | --- |
| 拉起应用 | `cu launch --app WorkBuddy` | pid 94085（**修了一个坑**：本 shell/服务带 `ELECTRON_RUN_AS_NODE`，Electron 应用会秒退，`launch` 现在把它剔掉再启动） |
| 读界面 | `cu snapshot --pid … --window …` | **`SNAP_DEPTH` 从 10 提到 24**：Chromium/Electron 的网页内容挂在 10 层匿名 `AXGroup` 之下，旧值只能看到 3 个红绿灯按钮；改完 497 个节点，「新建任务」「发送」「语音输入」和输入框全出来了（`SNAP_VERSION` 同步升到 2） |
| 新建对话 | `cu clicktext --text 新建任务` | 205ms，`AXPress-background`，前台不变 |
| 输入 | `cu type --pid … --background` | 0.29s 落字，读回确认 |
| 发送 | `cu key --name return --background` | WorkBuddy 回复「收到这条消息了。」（17s，GLM-5.3-Flash） |
| 读回复 | `cu snapshot` / `cu readtext` | 逐字渲染的 `AXStaticText` 拼回整句 |

WorkBuddy 反过来调用 CU：它的任务会话**只注入市场连接器**，自定义 MCP（我们的 `computer-use`，面板显示 35/35 已启用）不会进任务工具表，且 MCP 工具在会话启动时一次性注入、运行中不能热加载——这是 WorkBuddy 5.9.3 的行为，不是 CU 的缺陷——**整应用重启后再新建会话仍然一样**（实测：它回「本环境仍没有名为 computer-use 的 MCP 连接器」，然后自己改用 `127.0.0.1:47777` 又拿到 `count：13`）。可走的路是它的终端工具直连本机服务：

```sh
TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/.cu/config.json'))['token'])")
curl -s -X POST http://127.0.0.1:47777/v1/call -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' -d '{"tool":"list_windows","arguments":{}}'
```

WorkBuddy 自己执行后回答「count 的数字是：13」。**HTTP 调用方现在也会登记进客户端表**：服务用 `lsof` 拿到连接进程，再沿父进程链找到宿主应用，写入 `~/.cu/clients/http-<pid>.json`，`via` 标为 `http`。控制台「连接」页实测出现 `WorkBuddy · http · list_windows · 1 次 · 111ms`。

## 十、作为本机服务运行（推荐）

每次 AI 应用直连 MCP 时，权限要记在**那个 AI 应用**头上；换一个应用就得重授一次，参数也散落在各处。服务化把这件事反过来：**一个常驻服务持有权限，所有 AI 都来连它**。

```sh
./install-app.sh          # 编译引擎并装进 /Applications/Computer Use.app（引擎就是主程序）
```

装完之后，在「系统设置 → 隐私与安全性」里给 **Computer Use.app** 打勾（一次即可）。

需要两项：**辅助功能**、**屏幕录制**。`curl http://127.0.0.1:47777/v1/status` 的 `nextSteps` 会一直提示到两项都齐；齐了以后服务常驻、开机自启。

**接口**（只监听 127.0.0.1，令牌在 `~/.cu/config.json`）：

| 方法与路径 | 作用 |
| --- | --- |
| `GET /v1/status` | 权限、暂停、前台应用、窗口数、缺什么（无需令牌） |
| `GET /v1/tools` | 服务层的 JSON Schema（MCP 侧 37 个，与本表一致） |
| `POST /v1/call` | `{"tool":"click","arguments":{…}}`，需 `Authorization: Bearer <token>` |
| `POST /v1/exec` | `{"argv":["windows"]}`，给 MCP 代理用的底层通道 |
| `POST /v1/pause` / `POST /v1/resume` | 立即停手 / 恢复 |

**MCP 客户端不用改配置**：代理会先探测服务，服务拿到**辅助功能**后就把动作转过去；否则照旧直接执行，不会把现有用法弄坏。

两项权限是分开生效的：只有辅助功能时，控件读写/点击/输入可用，但窗口标题为空、截图失败——这是 macOS 的限制。**授予屏幕录制后要重启一次服务**（菜单栏“重启服务”或 `launchctl kickstart -k gui/$(id -u)/local.cu.service`），权限才生效，圆点变绿。

**重新编译后要重新授权一次**：TCC 按代码身份记录授权，`./install-app.sh` 换掉二进制之后，系统会把新程序当成"另一个应用"。现象是 `cu perms` 报 `accessibility:false / screenRecording:false`、窗口标题全是空串、截图 `capture_failed`。到 系统设置 → 隐私与安全性 里把 `Computer Use.app`（辅助功能、屏幕录制）**先减号删掉再加回来**，然后重启服务；之后每次编译都要重复这一次。服务本身没授权时，MCP 代理会退回本地 `bin/cu`（子进程继承宿主应用的授权），所以表现可能是"能用但少东西"。

**文字优先，不走 OCR**：`click_text`/`ocr_find` 先在目标窗口的辅助功能树里找文字（约 0.2 秒，坐标精确、无需截图），找不到才截屏 OCR。**Stage Manager 下的后台边界**：别的应用不在当前舞台时，它的窗口不参与合成，按进程发送的鼠标/键盘事件大多会丢失。所以坐标点击、输入、粘贴、滚动默认明确返回 `off_stage_window`，而不是假装成功；但控件自己的 `AXPress` 不依赖合成，`click`/`click_text` 命中带 `AXPress` 的控件时，离台窗口也能后台执行。`type_text`/`press_key`/`paste_text` 可传 `tryOffstage: true`：照常投递，然后**读应用自己的状态回来验证**，没变化照样报 `off_stage_window`——成功与否以应用可见的变化为准。`paste_text` 还有一条对 Electron 有效的路：应用自己的右键菜单“粘贴”（AXShowMenu + 菜单项 AXPress），全程后台、不碰你的剪贴板。需要整窗操作时先显式 `bring_on_stage`——那一步会切舞台，属于前台动作，调用方要知道。

**OCR 常驻预热**：Vision 首次调用可能耗时约 30 秒（系统按需装载），服务启动时会在后台做一次预热（日志 `ocr warm-up done`），之后每次整窗识别约 0.55–0.65 秒。`read_text` 和 OCR 兜底走这条热路径。

**截图：三层回退，最后交给菜单栏 App 代拍**。ScreenCaptureKit 的异步回调在 launchd 代理里永远不会回来，`/usr/sbin/screencapture` 也保留自己的 TCC 身份——所以 `shot`（以及 `ocr` 的取图）按顺序尝试：本进程 SCK → 本进程 `screencapture` CLI → **菜单栏 App 代拍**（DistributedNotification 请求/回复，App 用自己那份屏幕录制授权，PNG 落临时文件，往返约 0.2–1 秒）。也就是说只要菜单栏 App 在跑且有授权，**调用方不需要自己有屏幕录制权限**也能让 CU 截图/OCR。诊断可用 `shot --via-app` 强制走代拍。

**菜单栏应用**：`./install-app.sh` 会生成 `Computer Use.app` 装到 `/Applications`（无 Dock 图标，双击后出现在菜单栏），并把登录代理指向这个 App。状态栏显示 `● CU`，颜色就是状态——绿=一切正常，橙=服务在跑但权限没齐，黄=被你暂停，红=服务没运行。点开可以：状态栏显示 `● CU`，颜色就是状态——绿=一切正常，橙=服务在跑但权限没齐，黄=被你暂停，红=服务没运行。点开可以：

- 查看**各 AI 代理的接入状态**（● 已连接 / ◐ 已接线·在线 / ○ 未链接）与**已连接的客户端**（哪个 AI 应用在驱动、多久之前、最后一次调用的是什么）；
- **控制台…**（五个页签）：
  - **代理**：仿 magpie 的接入列表——每个已知 AI 代理（Qoder、WorkBuddy、Claude Code、Claude Desktop）一行，显示状态、最近工具、距今、调用次数和备注；带「一键连接未接入的 Agent」「刷新」按钮；
  - **连接**：每个 MCP 会话一行——客户端应用、走的通道（service=常驻服务 / local=直连）、最近动作、距今、调用次数与最近用时；
  - **使用**：按工具汇总的调用次数、平均用时、累计用时，用来看哪一步慢；
  - **设置**：端口、截图长边、介入暂停、自动高亮、逐应用允许清单；
  - **诊断**：服务 pid/端口、三项权限、前台应用、正在做什么、客户端列表、配置与日志路径、最近 18 行服务日志，可一键复制或打开日志；
- **设置…** 直接跳到控制台的设置页签；
- 暂停 / 继续操作（等于按了指示条上的 ×）；
- 设置…（端口、截图长边上限、用户介入暂停、自动高亮、逐应用允许清单，保存后自动重启服务）；
- 打开系统设置（辅助功能 / 屏幕录制）、**弹出授权窗口**（缺哪项就拉起 macOS 自己的授权对话框，和 Claude 的行为一致；App 启动时发现缺权限也会自动弹一次）、在访达中显示服务程序；
- 重启服务、退出菜单栏。

**App 的主程序就是引擎本体**：早先 LaunchServices 一直拒绝自编译 Mach-O（`-10825`），只能用脚本启动器绕。后来实测定位到真正原因——swiftc 默认 deployment target 是 macOS 28，比这台机器（27）还新，系统因此拒绝把它当应用启动；直接敲路径执行不走这道检查，所以一直没暴露。`build.sh` 现在显式 `-target arm64-apple-macos14.0`，并用真实 Apple Development 证书签名，引擎直接当主程序。App 有图标，登录由 `local.cu.menubar` 代理负责。

**双击报 "not open anymore" 的根因**：任何在 .app 包内运行的进程都会被 LaunchServices 注册成"这个 App"。常驻服务的进程跑的是包内二进制，就冒领了 `local.cu.app` 的身份——双击时系统试图激活它（而它没有界面、忽略事件），于是 -600 → "应用程序不再打开"。修法：`install-app.sh` 把引擎**硬链接**到 `~/Library/Application Support/cu/bin/cu`（同一个 inode，不算副本），launchd 服务跑的是包外那条路径，包内二进制只留给真正的 UI 实例。

**单实例 = 接管而不是报错**：重复双击时新实例发 `local.cu.handover` 分布式通知，旧菜单栏实例收到后干净退出（launchd 的 KeepAlive 对干净退出不重启），新实例顶上并弹出控制台；对已运行的 App 再 `open` 也只是把控制台调到前台。另外 LaunchServices 启动 .app 时不带参数，所以引擎把空参数默认成 `app` 命令。

**主动接入 AI 代理（仿 magpie）**：`cu agents` 列出已知代理及状态——`● 已连接`（服务端有它的活客户端记录）、`◐ 已接线`（配置里已写入 cu 的 MCP 连接器）、`◐ 在线·未接入`（进程在跑但没接线）、`○ 未链接`。`cu agents-connect`（控制台"代理"页签上是「一键连接未接入的 Agent」按钮）把 `{"command": "/usr/bin/python3", "args": ["~/Library/Application Support/cu/mcp/server.py"], "env": {"CU_BIN": "<App 内引擎>"}}` 幂等写进各代理的配置（`~/.claude.json`、Claude Desktop 的 `claude_desktop_config.json`、`~/.workbuddy/mcp.json`；写前留 `.bak-cu` 备份；Claude Code 的服务器名用 `cu`——`computer-use` 是它的保留名，写进去也不会加载；Qoder 走 App 自己的连接器管理，不直接改文件）。服务端也有 `GET /v1/agents` 和 `POST /v1/agents/connect`。代理脚本固定装在 `~/Library/Application Support/cu/mcp/server.py`，重装/升级 App 不会让它失效；接入的代理重启后生效。

**配置** `~/.cu/config.json`：

```json
{"port": 47777, "token": "…", "screenshotMaxDimension": 1600,
 "pauseOnUserActivity": true, "autoHalo": true}
```

**卸载**：`launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/local.cu.service.plist` 和 `local.cu.menubar.plist`，再删两个 plist 与 `/Applications/Computer Use.app`。

## 九、验证状态（只写跑过的）

| 项目 | 结果 |
| --- | --- |
| 后台点击/输入（前台保持别人的窗口） | 5/5 落字，前台从未被抢（tests/background.py） |
| 前台点击/输入稳定性 | 10/10，0 失败，点击 0.38s、输入 0.33s（tests/stability.py） |
| Chromium 地址栏（前台） | 10/10，输入值精确回读；靠 `AXManualAccessibility` 打开树 |
| 安全层拒绝路径 | 10/10（tests/guards.py，全程 dry-run）；另有密码框 `secure_field` 与模态框 `sheet_or_modal_on_target_window` 的实弹测试（tests/demo_controls.py） |
| 差量快照 | 完整 203 节点 → 二次读取 108 字符 |
| 控件级工具（自建测试窗口） | `set_value` 回读 "hello world"；`select_text` 选中 5 字符 @6；按钮点击计数 1；双击计数 2；`scroll` 按进程送达；密码框被拒 `secure_field` |
| 模态框拒绝 | 在测试窗口弹出 Sheet 后，再点按钮被拒：`sheet_or_modal_on_target_window`；关闭 Sheet 后可继续 |
| 会话指示/暂停/遮挡/允许清单 | 均已实测，拒绝词见第五节 |
| 窗口拖动 | 已验证（tests/window_ops.py，在引擎自开的测试窗口上）：拖动 (60,40) 实际位移 (57,38) |
| 缩放 / 全屏切换 | 已验证：进入全屏 1728×1084，再切回 460×332 |
| Chromium 地址栏 | 普通桌面 10/10；台前调度下（窗口仍在缩略图）5/5 —— 关键是用 `snapshot(windowId)` 只读目标窗口，地址栏走它自己的 `AXPress`，不依赖坐标。没有作用域、坐标又是旧的时候会拒绝（`ref_outside_window` / `point_outside_any_window`） |
| `ax_find` 深树搜索 | 已验证（tests/deepfind.py、tests/verify_unlock.py）：引擎自开的 16 层视图链末端按钮在 depth 17 命中并带 `AXPress`；WorkBuddy 22 层的「发送」按 description 也能搜到（旧实现两处都搜不到） |
| 截图代拍 | 已验证：本进程无屏幕录制时转给菜单栏 App 代拍，全屏 1728×1117 / 104KB、窗口截图 136–187KB 均成功；`shot --via-app` 可强制走这条路 |
| 截图 region / JPEG | 已验证（tests/smoke_new.py，走服务和 MCP 两条路）：同窗口整窗 214–233 KB / 495–835 ms → `region` 47 KB（22%）、`origin/size` 跟着重算；`format: "jpeg"` 72–74 KB（约 1/3）。`screencapture` 直接写 JPEG，不再 PNG 编一遍再解一遍 |
| ref 走索引路径 | 已验证（tests/smoke_new.py）：6/6 命中 `resolved: "path"`，中位 380–401 ms，同期整树快照 412–629 ms；旧实现每次都要整树重走（315 ms vs 339 ms 且常报 `stale_ref`） |
| 窗口列表缓存 | 已验证：同一秒内两次 `list_windows` 339 ms → 0 ms |
| 浮动脉胶囊 | 已验证：默认挂出 300×44 药丸（应用名 + 停止键），不遮挡被操作窗口；`CU_CAPSULE=0` 退回整窗高亮 |
| 指示器/安装不抢前台 | 已验证（tests/focus_probe.command，每 0.4 秒采样系统前台）：装脚本启动菜单栏改走 `launchctl kickstart`（不再 `open`，`open` 会给已运行的应用发 reopen、把控制台拉到前台）；药丸/高亮框/遮挡层启动时若被 AppKit 激活，会把焦点交还原来的应用（实测修复前药丸会把前台占住整个生命期，修复后前台始终是原应用）。截图（CLI 与服务两条路）、`windows`、`snapshot`、后台点击全程前台不变 |
| `expect` 断言 | 已验证：正例 222ms 命中；反例如实返回 `expect_failed / enabled is false`，不会把没发生的事报成成功 |
| Electron 聊天端到端（WorkBuddy） | 已跑通：真实粘贴写入 → 回车提交 → 新任务「CU 后台链路测试」→ 回复「收到，链路正常」（9s）。**边界如实说明**：灰掉的「发送」按钮即使真的输入了文字也仍是 `enabled:false`（应用的 aria 噪音），提交必须用回车；而离台窗口收不到键盘事件，所以纯后台提交做不到，需要一次 `bring_on_stage`（属前台动作，要调用方同意）。窗口回到离台后，消息正文会从 AX 树里被 Chromium 剪掉，读长回复要它在台上或改用截图 |
