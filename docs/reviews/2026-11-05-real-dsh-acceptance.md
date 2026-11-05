# 2026-11-05 真实 DSH 验收前的修复记录

本文记录录屏复盘之后的第二轮修复：测试隔离、工具错误传播、会话观察隔离、坐标约束，以及真实 DSH 加载验证。

## 结论（截至重启前）

- 录屏中的 DSH 确实运行旧插件：`cu_status` 没有 `plugin` 字段，错误仍提示 `install-app.sh`，宿主 PID 53595 自 09:29:46 起未重启。
- 真实 `~/.cu/config.json` 在 **21:34:11** 被旧测试改写成端口 53484（测试随后退出，端口无人监听），与录屏中“测试留下死端口”的机制一致。本轮测试已不再触碰真实配置。
- 宿主插件是 Host 模块。DSH HMR 对它的变更只记为 `pending`（`host-module` / `module-comparison`）：`plugin_manager` 重新启用同一行会再次 `apply()`，但不会重新 `module evaluated`。进程内无法换掉已加载代码，必须正常退出再启动 DSH。
- 新代码已通过 228 项自动化测试，并在隔离状态目录下用真实 helper 跑通启动、窗口、快照、停止、只读、恢复和回收。

## 根因

1. **测试污染真实配置**
   `test/service_lifecycle_regressions.mjs` 的 “Host abnormal exit simulation” 直接 `spawn(bin, ["service", ...])`，没有传 `CU_STATE_DIR`，`CuSessionManager` 也没有独立 `stateDir`。helper 启动时 `loadServiceConfig()` 会把端口/token 写进真实 `~/.cu/config.json`；helper 随测试退出，配置却留下一个死端口。
   `test/service_daemon.test.mjs` 还会借用用户正在运行的服务；两个测试文件会真的打开系统设置。

2. **`cu_windows` 把失败伪装成空列表**
   `ok: Boolean(winRes.ok)` 丢掉了 `error/message/outcomeUnknown/cancelled`，失败与“确实没有窗口”无法区分。

3. **停止闸门误伤只读操作**
   停止后 `exec` 对 `windows/snapshot` 也返回 `cancelled`；为了看一眼窗口而重新打开输入闸门是不可接受的折中。

4. **快照基线跨聊天共享**
   `snapshots` 只按 `pid:windowId` 缓存，第二个聊天第一次 `cu_snapshot` 会拿到别的聊天的 delta，看不到完整树。

5. **坐标点击缺少目标窗口校验**
   后台坐标点击不经过引擎的点位 preflight；窗口移动/缩放后，旧坐标仍会被派发。

6. **模型操作策略**
   重复无效点击、猜快捷键、用硬编码文案等待、把 `restoredTarget:false` 说成已恢复，属于工具契约与技能指引不足，不是引擎错误。

## 修改

- `lib/core.mjs`
  - `stateDir` 支持 `CU_STATE_DIR`；在 Node 测试上下文中，未隔离的 manager 直接返回 `test_isolation_required`，不再启动 helper 改写真实配置。
  - 快照 delta 基线按 `<chat>\0<pid>:<windowId>` 隔离；新增观察时的窗口 frame 记录（`snapshotGeometry`）。
  - `cachedFingerprint`/`refSnapshotMismatch` 支持按聊天隔离；新增 `CuSessionManager.systemSettingsUrl()`，让权限映射可测试而不启动系统设置。
- `lib/index.mjs`
  - `cu_windows` 保留底层 `error/message/cancelled/outcomeUnknown`；`apps` 失败写 `appsError`；成功空列表仍是 `ok:true,count:0`。
  - `windows/snapshot/find/expect` 使用 `control` 只读通道：停止后仍可看，但不重开输入闸门。
  - `cu_snapshot` 记录目标窗口当前 frame，并带上聊天身份。
  - `cu_click`/`cu_batch` 在派发坐标前校验：`point_outside_target_window`、`window_geometry_changed`，两者都是拒绝而非重试。
  - `cu_session`、`cu_click`、`cu_windows` 的工具描述写明停止结果、错误语义和“派发≠成功”。
- `skill/SKILL.md`
  - 新增坐标来源、无效点击、禁止猜快捷键、等待条件来自观察、只报告已验证结果四节。
- `scripts/test-isolated.mjs`（新）
  - 为整套测试设置临时 `CU_STATE_DIR`，结束后核对真实 `~/.cu/config.json` 与 `pause` 未被修改。
- `test/*`
  - `service_lifecycle_regressions`：异常退出测试使用独立目录、显式 `CU_STATE_DIR`、等待退出后再删目录；删除真实打开系统设置的测试。
  - `service_daemon`：自启测试使用独立目录和自有 helper，并等待回收。
  - `core.test`：live roundtrip 自启私有 helper，不借用用户服务。
  - 新增 `test/isolation_guard.mjs`、`test/session_tool_regressions.mjs`。

## 自动化测试

- 修复后完整套件：**228 passed / 0 failed / 0 skipped**，`scripts/test-isolated.mjs` 报告真实 `~/.cu` 未被修改。
- 新增的 7 项行为测试在旧代码（7277a07）上 **5 失败 / 2 通过**，在新代码上 **7/7 通过**：
  - `cu_windows` 保留 `cancelled`；
  - 停止后 `windows` 仍可读且闸门保持关闭；
  - 新聊天首次快照为 `full`；
  - 越界坐标被拒绝且不派发 click；
  - 窗口移动后坐标被拒绝；
  - 空窗口仍是成功；窗口内坐标仍可派发。

## 真实 helper 验收（隔离状态目录，不是 DSH 加载证据）

| 项目 | 结果 |
| --- | --- |
| 插件自启 helper | `pid 33159`，端口 47777，临时 `config.json` |
| `cu_status.plugin` | `entryPath` 指向仓库，`sourceHash` 与当前文件一致，`hostPid` 为进程自身 |
| `cu_windows` | `ok:true`，12 个窗口 |
| 首次 `cu_snapshot` | `mode:full`，185 节点 |
| 同一聊天第二次 | `mode:delta` |
| 另一聊天首次 | `mode:full`（185 节点） |
| `cu_session start/stop(pause)` | 停止后 `inputGateClosed:true`，`restoredTarget:false`、`restoredDsh:false`、`cleanupState:"unknown"`（原样报告） |
| 停止后输入 | `PAUSED_BY_USER` |
| 停止后 `cu_windows` | `ok:true`，12 个窗口，闸门仍关闭 |
| 显式 `resume` | `ok:true`，闸门打开，随后按键成功 |
| dispose | helper pid 33159 退出 |

## 配置与进程影响

- 真实 `~/.cu/config.json`：本轮测试前后未被修改；21:34:11 的 53484 是修复前的旧测试写入，未擅自恢复旧 token 或覆盖用户配置。
- 清理了 4 个 shell 临时服务进程（57645、52436、49158 及其 bash 父进程），端口已确认关闭；未批量杀死 `cu` 进程，未动用户其他应用。
- 未提交、未推送、未发布。

## 真实 DSH 加载

DSH 需要正常退出再启动才能加载新的 Host 模块。第一次重启后（21:58:43）宿主 PID 34573 加载了 `90689e72…`，`cu_status.plugin` 的 `entryPath/loadedAt/hostPid/sourceHash` 与磁盘一致，插件自行在 53484 拉起 helper（pid 34595），证明“真实 DSH 加载”链路可用。

真实 DSH 随即暴露一个测试未覆盖的缺陷：`cu_windows` 虽然走了只读 `control` 通道，但工具包装层在 `pauseLatched` 时对所有非 `cu_status` 工具提前抛 `PAUSED_BY_USER`。本地验收没有 registry，所以没发现。已修复为：`cu_status/cu_windows/cu_snapshot` 不 claim 桌面、不被暂停闸门拒绝，其余工具仍拒绝；新增带 registry 的回归测试（228 项仍全绿）。

因此需要第二次重启加载该修复（最终 `sourceHash` 以 `9c889017…` 为准），再做停止后只读、输入拒绝、恢复、失败传播与 helper 回收的真实 DSH 验收。

### 第二次重启后的真实 DSH 验收（已完成）

宿主进程 **35422**（2026-11-05 22:01:41 启动）在 22:01:42 加载本仓库 `lib/index.mjs`；`cu_status.plugin`：

```json
{"entryPath":"/Users/johnkwok/Downloads/work/dsh-super-computer-use/lib/index.mjs",
 "hostPid":35422,"loadedAt":"2026-11-05T14:01:42.441Z",
 "sourceHash":"9c889017f53d3e7a45a69797df04dea0193f19bda4c59d9f2280b308dc28bfbf"}
```

`~/.cu/plugin-boot.log` 同一时间有对应的 `module evaluated` 与 `apply() done`。插件自行启动 helper **35577**（ppid = 35422，端口 53484 与 config 一致），没有 shell 常驻服务。

| 验收项 | 真实 DSH 结果 |
| --- | --- |
| 状态 / 窗口 | `cu_status ok:true`，10 个窗口，Accessibility 与 Screen Recording 均 true |
| 快照基线 | 本宿主首次 `mode:full`（51 节点），第二次 `mode:delta`（unchanged 51） |
| 会话开始 | `cu_session start`（Notes）`ok:true, session:"started"` |
| 用户停止 | `stop pause:true` → `inputGateClosed:true`、`restoredTarget:false`、`restoredDsh:false`、`cleanupState:"unknown"`（原样） |
| 停止后输入 | `cu_key` 被拒：`PAUSED_BY_USER` |
| 停止后只读 | `cu_windows` `ok:true`（1 个 Notes 窗口）；`cu_snapshot` `ok:true`（delta），闸门未重开 |
| 显式恢复 | `cu_session resume ok:true`；随后 `cu_key escape` `ok:true` 且有 observation delta |
| 失败传播 | `cu_click (10,10)` → `ok:false, point_outside_target_window`，未派发；`cu_launch` 不存在 app → 顶层 `ok:false, app_not_found` |
| helper 回收 | 停用 `include:super-computer-use` 后 helper 35443 退出、端口 53484 关闭；重新启用后 `cu_status` 让插件自行拉起 helper 35577 |

未在真实 DSH 重演的部分：恢复过程中再次停止的竞态（由单元测试覆盖）、真实窗口移动/缩放后的 `window_geometry_changed`（由单元测试与隔离 helper 验收覆盖，未移动用户窗口）、跨聊天首次快照（由单元测试与隔离 helper 覆盖）。
