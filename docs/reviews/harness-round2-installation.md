# Round 2 安装一致性与回滚报告（2026-11-04）

本轮目标：让 app、后台 service、预览 helper 来自同一发布构建，独立验证签名与权限，并把回滚
改成可执行、可审阅、不会误删已跟踪文件的步骤。本报告记录真实本机操作；未做或未测的项目明确
写出。

## 1. 结论

- 更新前的版本错位已消除：`/Applications/Computer Use.app`、`~/Library/Application Support/cu/bin/cu`
  与 `cu-preview` 现在是同一份未签名构建（unsigned payload `956e511b…f513e5`）。
- 更新前 app 是旧构建 `9beef70a…bf52`，service/helper 是 `b950e361…df8d`；运行时 `/v1/status`
  也报告 `b950e36…`，确认错位属实。
- 安装过程发现并修复了一个真实缺陷：`cu-preview` 曾是 app bundle 主体的字节复制，带着
  bundle 签名离开 bundle 后被 amfid 判为 “signature on the file is invalid” 并 SIGKILL
  （exit −9，无 stderr）。安装器改为复制 standalone 签名的 `engine/bin/cu`，并在安装时对
  service/helper 分别做 `codesign --verify --strict`。
- 权限未丢失：更新后 `/v1/status` 仍为 `accessibility=true`、`screenRecording=true`；没有
  执行任何 TCC reset。
- 回滚演练在隔离目录完成：native 点击、预览首帧、13 个工具加载均通过，无残留 helper。

## 2. 环境与版本

| 项目 | 更新前 | 更新后 |
|---|---|---|
| 代码 commit | `bff48b3` + 本轮安装脚改动（工作区） | 同一提交（安装脚本修复随后提交） |
| 插件版本 | `0.2.0` | `0.2.0` |
| app 可执行 sha256 | `9beef70a…bf52` | `3fa4c1e1…b9e771` |
| app 未签名 payload | 未记录 | `956e511b…f513e5` |
| service sha256 / buildId | `b950e361…df8d` | `9815adc1…2c1d73` |
| preview helper sha256 | `b950e361…df8d` | `9815adc1…2c1d73` |
| dev `engine/bin/cu` 未签名 payload | — | `956e511b…f513e5`（与 app/service 相同） |
| 运行 buildId（`/v1/status`） | `b950e361…df8d` | `9815adc1…2c1d73` |
| 权限 | Accessibility / Screen Recording = true | 仍为 true |

签名：

| 组件 | identifier | CDHash | 签名主体 |
|---|---|---|---|
| app | `local.cu.app` | `55be9e43…` | Apple Development … (8UL3844UU8) |
| service | `cu` | `b58d9c70…` | 同一签名主体 |
| preview helper | `cu` | `b58d9c70…` | 同一签名主体 |

app 与 service 的**代码**相同（`codesign --remove-signature` 后逐字节相同），差异仅来自
app bundle 签名会重新签主可执行文件。service/helper 是独立合法签名的副本。

## 3. 更新路径

使用仓库既有安装器，没有手改 app.asar，也没有新增端口或服务：

```bash
bash engine/install-app.sh
```

安装器实际做了：

1. `engine/build.sh` 重新构建并用稳定身份签名 `engine/bin/cu`。
2. 重新生成 `Computer Use.app`（bundle id 仍为 `local.cu.app`），安装到 `/Applications`。
3. **修复后**：把 standalone 签名的 `engine/bin/cu` 复制到
   `~/Library/Application Support/cu/bin/cu`，再让 `install-service.sh` 复制为 `cu-preview`；
   两处都执行 `codesign --verify --strict`。
4. 通过 launchd 重启 `local.cu.service` 与 `local.cu.menubar`。

`~/.dsh/profiles/desktop/package.json` 与 `cordis.patch.yml` 在更新前后 sha256 完全一致
（`11be015a…77cb` / `c910b67e…1a70`），本轮安装没有改写用户配置。

## 4. 入口验证

| 入口 | 实际证据 | 结果 |
|---|---|---|
| 菜单栏应用 | launchd `local.cu.menubar` running，pid 10203，程序路径 `/Applications/Computer Use.app/Contents/MacOS/Computer Use app --quiet` | 通过（进程级） |
| 真实工具入口 | 本会话 `cu_status` 返回 `ok:true`、`buildId=9815adc1…`、`registrationErrors=[]`、权限 true | 通过 |
| 预览 helper | 安装后的 `cu-preview preview-stream` 在自有 demo 窗口收到首帧 20841 B，`--seconds 2` 自然退出 0 | 通过 |
| app 内嵌插件 | `Resources/dsh-plugin/package.json` 版本 `0.2.0` | 通过 |

未验证：用鼠标真实点开菜单栏 `● CU` 菜单（只核对了 launchd/进程，未做会抢焦点的 UI 操作）；
真实 Harness 卡片里的预览入口留到 Task 6 的端到端验收。

## 5. 发现并修复的安装缺陷

**现象**：安装后直接运行 `~/Library/Application Support/cu/bin/cu-preview preview-stream`，
进程在输出任何 stderr 前被 SIGKILL（exit −9）。系统日志：

```
amfid: .../cu-preview not valid: ... Code=-420 "The signature on the file is invalid"
```

**原因**：旧 `install-app.sh` 用 `ln`/`cp` 从 **app bundle 的可执行文件** 生成 service 副本。
给 bundle 签名时，主可执行文件被重签为 bundle 风格；同一份字节放到 bundle 外，独立校验失败。

**修复**：`install-app.sh` 改为复制 standalone 签名的 `bin/cu`；失败时用同一稳定身份显式
`codesign --identifier local.cu.engine`。`install-service.sh` 在复制 helper 时同时检查
`codesign --verify --strict`，并在 service/helper 任一签名无效时直接报错退出，而不是装出
一个会被系统杀掉的 helper。

修复后同一条命令收到 20841 B 首帧并正常退出 0。

## 6. 回滚演练

完整步骤见[回滚说明](2026-11-04-harness-integrated-cu-rollback.md)。实际演练范围：

- 隔离目录 `/tmp/scu-rollback-rehearsal` 恢复更新前快照；未改动当前安装。
- app bundle、`bin/cu`、`bin/cu-preview` 三者 `codesign --verify --strict` 通过。
- native：快照 app 启动自有 demo，快照 `cu` 执行 `windows → snapshot → click --ref k0.1`，
  按钮标题 `Demo Button 0` → `Demo Button 1`。
- 预览：快照 `bin/cu-preview preview-stream` 收到首帧 22877 B，退出 0。
- 工具：快照 app 内嵌插件 `registerCuTools` 注册 13 个工具，无缺项。
- 清理：演练后无残留 `cu-preview preview-stream`。

未演练：对当前 `/Applications` 真正执行卸载/重装（会中断正在使用的会话与菜单栏）；
撤销 TCC 权限后的恢复（本机权限仍为 true，按计划不擅自重置）。

## 7. 与旧报告的关系

`2026-11-04-harness-integrated-cu-acceptance.md` 保留为历史验收（基线 `52b244f`），其中
“app 内引擎仍是旧构建”“慢读者丢帧”“观看轮询 re-arm idle”等描述已被本轮的安装、背压和
idle 策略取代。历史结果不删除，差异见该文档 §14 的 Round-2 更正。
