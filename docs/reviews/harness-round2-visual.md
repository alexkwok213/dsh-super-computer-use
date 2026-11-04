# Round 2 视觉与布局收敛（2026-11-04）

本文件只记录 Task 7 的实际结果。未验证的主题/动效不写成通过。

源码版本：`a9977e9`（三级布局/诊断）＋ `73f4538`（评审修复：双 canvas、背景关闭、
overlay mount）。真实视觉截图未能生成：00:45 本机进入锁屏（`IOConsoleLocked=true`），
无法在不输入用户密码的前提下继续操作 GUI。下面区分"代码/组件测试完成"与"真实视觉未测"。

## 1. 改动

- **默认 40 px 状态条**：会话活跃时只显示应用名、状态、`观看` 和 `停止`。不渲染 canvas，
  不出现"等待用户点击的空黑框"，空闲时不占位。
- **320 px 观看卡片**：只有用户点击 `观看` 才挂载 canvas 并打开预览；卡片内可 `收起预览`
  回到状态条。收起只关闭采集/显示，不停止执行。
- **大面板**：仍是用户点击展开按钮才打开的 `shell.overlay`；没有自动打开。Escape 关闭、
  点击背景关闭、关闭后焦点归还；新增 Tab / Shift+Tab 焦点约束（role=dialog, aria-modal）。
  卡片与 overlay 各自持有 canvas，收起大面板不会冻结仍在观看的卡片。
- **诊断折叠**：Carrier/Probe/内部时序不再常驻；大面板底部改为默认关闭的 `详情`
  （`<details>`），只保留目标代次、帧数/dropped/decode。Client 不再发送 `/api/scu/probe`，
  插件 `uiProbe` 默认改为 `false`。
- **一次触发**：Stop/展开/关闭都只保留 `onClick`，删除 `onPointerDown + onClick` 的双触发；
  不再靠 250 ms 时间去抖掩盖语义重复。
- 保持 8–10 fps 起点（helper 仍为 `--fps 10`），未提高帧率参数。

## 2. 自动化验证

```bash
node --test test/harness_client_lifecycle.mjs test/harness_ui_manifest.mjs
```

结果：19/19（其中客户端生命周期 13/13，manifest 6/6）。新增断言：

- 默认卡片是 strip，含 `Watch`，不含 `No preview`/`Hide preview`；`preview.running=false`。
- 点击 `Watch` 后 `watching=true`、卡片出现 `Hide preview`、预览流真正打开。
- 挂载过程不发送 `/api/scu/probe`。
- `scu-stop` 与展开按钮只有 `onClick`，没有 `onPointerDown`。
- 大面板诊断 `details.scu-diag` 默认没有 `open`。
- 卡片与 overlay 两个 canvas 同时挂载时都收到帧；detach overlay 后卡片继续绘制。

## 3. 真实 UI 截图

**未生成。** 00:45 系统锁屏；此前已完成的真实 UI 证据是旧 client（round-2 stop/demo），
不是本节的 strip/watch/overlay。锁屏解除后应补：状态条、观看卡片、大面板、窄窗四张窗口级
`cu shot`。不拿组件 render 或旧截图冒充。

## 4. 主题 / 窄窗 / Reduce Motion

- 窄窗：未测（锁屏）。
- 深色/浅色：使用宿主 `--dsw-alias-*` 令牌；未切换系统主题实测，标未测。
- Reduce Motion：CSS 已有 `@media (prefers-reduced-motion: reduce)` 关闭卡片/面板/点动画；
  未在真实系统开启 Reduce Motion 实测，标未测。

## 5. 焦点与窗口

- 代码上观看/展开只动采集/显示，停止才走 stop；展开不自动打开。
- 真实焦点/目标窗口不动的实测受锁屏阻塞，未完成。

## 6. 未完成 / 已知

- Client 实际 draw FPS 仍无渲染器调试通道（见 Round-2 验收 §9）。
- 视觉截图、窄窗、主题、Reduce Motion、焦点实测均因锁屏未执行。
- Minor 未修：FINAL 状态仍渲染 Watch 按钮（点击 no-op）；`degradeNoFirstFrame` 未 releaseLock；
  Swift 首帧 watchdog 在 startCapture 返回后才建立。
