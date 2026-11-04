# 回滚说明：Round 2 稳定性与安装一致性（2026-11-04）

本文件替换旧版 `2026-11-04-harness-integrated-cu-rollback.md` 中已失效的“未提交”描述和危险的
`git checkout -- … && rm -f …` 清单。**旧清单不要执行**：它删除的是已跟踪的插件文件，会让插件
无法加载。

本轮工作全部在本地 `main`，未推送。回滚目标是“恢复一个已验证、可运行的状态”，不是把仓库
清空。所有快照都在仓库 `.rollback/`（已 gitignore，不随仓库发布）。

## 1. 已知快照

| 名称 | 路径 | 内容 | buildId / 哈希 |
|---|---|---|---|
| 本轮更新前 | `.rollback/round2-pre-20261104-2319/` | app（旧 9beef70…）、service/helper（b950e36…）、dev、profile 配置、manifest | service `b950e361…df8d` |
| 本轮已验证 | `.rollback/round2-verified-20261104-2329/` | 同一发布构建的 app、service、preview helper、profile 配置、manifest | service/helper `9815adc1…2c1d73` |

“已验证快照”的三个组件是同一份未签名构建（unsigned payload
`956e511bb418db2bc723dbe1b4d9d263da341771c277fa6e7663f3a2dff513e5`），只是 app 使用
bundle 签名（`local.cu.app`，CDHash `55be9e43…`），service/helper 使用独立的合法
standalone 签名（identifier `cu`，CDHash `b58d9c70…`）。不要用 app 的可执行文件直接覆盖
`cu-preview`：那会得到 bundle 签名，amfid 会以 “signature on the file is invalid” 杀掉它。

旧备份 `.rollback/cu-installed-20261104-215341` 仅作历史保留。

## 2. 回滚二进制（推荐：先停 agent，再恢复文件）

以恢复“本轮更新前”为例；恢复“已验证快照”只需把 `SNAP` 换成
`.rollback/round2-verified-20261104-2329`。

```bash
set -euo pipefail
cd /Users/johnkwok/Downloads/work/super-computer-use
SNAP="$PWD/.rollback/round2-pre-20261104-2319"
test -d "$SNAP/Computer Use.app" || { echo "缺少 app 快照，停止"; exit 1; }
test -x "$SNAP/bin/cu" || { echo "缺少 service 快照，停止"; exit 1; }
test -x "$SNAP/bin/cu-preview" || { echo "缺少 preview 快照，停止"; exit 1; }
SUPPORT="$HOME/Library/Application Support/cu"

# 1) 先停两个 login agent，避免替换正在执行的二进制
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.cu.menubar.plist" 2>/dev/null || true
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.cu.service.plist" 2>/dev/null || true
sleep 1

# 2) 先把旧 app 移到可恢复位置，再恢复；ditto 失败时不要留下半套安装
mv "/Applications/Computer Use.app" "/Applications/Computer Use.app.rollback-$(date +%s)"
ditto "$SNAP/Computer Use.app" "/Applications/Computer Use.app"
cp "$SNAP/bin/cu" "$SUPPORT/bin/cu"
cp "$SNAP/bin/cu-preview" "$SUPPORT/bin/cu-preview"
chmod 755 "$SUPPORT/bin/cu" "$SUPPORT/bin/cu-preview"

# 3) 独立核对签名，失败就停
codesign --verify --strict "/Applications/Computer Use.app"
codesign --verify --strict "$SUPPORT/bin/cu"
codesign --verify --strict "$SUPPORT/bin/cu-preview"

# 4) 重新注册并启动
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.cu.service.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.cu.menubar.plist"
```

旧快照恢复后是**当时的真实状态**：app 本体是旧构建（9beef70…），service/helper 是 b950e36…。
这是可运行的 native 模式，但不是同一发布构建；如果要长期停留，优先恢复“已验证快照”。

验证：

```bash
# buildId 应等于所恢复 service 的 sha256
python3 - <<'PY'
import json,urllib.request,os
c=json.load(open(os.path.expanduser('~/.cu/config.json')))
r=urllib.request.Request(f"http://127.0.0.1:{c['port']}/v1/status",
                         headers={'Authorization':'Bearer '+c['token']})
d=json.load(urllib.request.urlopen(r,timeout=5))
print({k:d.get(k) for k in ('ok','buildId','accessibility','screenRecording','pid')})
PY
pgrep -fl "cu-preview preview-stream" || echo "no preview helper"
```

如果 `accessibility`/`screenRecording` 为 `false`，到“系统设置 → 隐私与安全性”手动授权
`/Applications/Computer Use.app`；**不要**用 `tccutil reset` 代替授权，也不要在未确认时重置
其他 App 的 TCC。

## 3. 只回滚配置（保留新代码）

profile 中只有这一块属于内嵌观看器；只删除该块，不覆盖整个文件，保留之后其他人的修改：

```bash
python3 - <<'PY'
from pathlib import Path
p = Path.home() / ".dsh/profiles/desktop/cordis.patch.yml"
s = p.read_text()
begin = "# BEGIN super-computer-use embedded viewer"
end = "# END super-computer-use embedded viewer"
a, b = s.find(begin), s.find(end)
if a == -1 or b == -1:
    print("标记不存在：配置已是回滚后状态")
else:
    s = s[:a] + s[b + len(end):]
    s = s.lstrip("\n")
    p.write_text(s)
    print("已只移除 embedded viewer 块")
PY
```

之后在 Harness 里开关一次插件或重启桌面 App 使配置重载。不要用 `.rollback/profile-cordis.patch.yml.bak`
直接覆盖：该备份早于本轮之后的配置修改，会连带撤掉别人的改动。

若要完全移除插件 UI：在 profile `package.json` 的 `dsh.profile.bundles` 中只删除
`"dsh-super-computer-use"`（以及可选的 `dependencies` 链接），重启 Harness；会话文件在
`~/.dsh` 下，不受影响。

## 4. 回滚代码

本轮从 `52b244f` 开始。仓库未推送，推荐用可审阅的 revert，而不是 `git reset --hard`：

```bash
cd /Users/johnkwok/Downloads/work/super-computer-use
git log --oneline 52b244f..HEAD          # 先确认范围
git revert --no-commit 52b244f..HEAD     # 逐提交反向应用，保留历史
git status && git diff --cached --stat   # 审阅
git commit -m "revert: round-2 hardening"
```

若只想撤某一项，按该提交单独 revert，例如安装脚本修复：
`git revert --no-commit <该提交>`。不要执行旧文档的 `git checkout -- …` 后 `rm` 已跟踪文件。

## 5. 回滚演练（本轮实际执行范围，2026-11-04 23:26）

在隔离目录 `/tmp/scu-rollback-rehearsal` 恢复“更新前”快照，未改动当前安装：

- app bundle、`bin/cu`、`bin/cu-preview` 三者 `codesign --verify --strict` 均通过。
- native 模式：用快照 app 启动自有 demo 窗口，快照 `cu` 执行
  `windows → snapshot → click --ref k0.1`，按钮标题从 `Demo Button 0` 变为 `Demo Button 1`。
- 预览入口：快照 `bin/cu-preview preview-stream` 在 demo 窗口收到首帧
  （22877 B，frameId `1`，`--seconds 2` 自然退出 0）。
- 工具加载：从快照 app 内嵌插件 `lib/index.mjs` 调用 `registerCuTools`，注册 13 个
  `cu_*` 工具，无缺项。
- 无残留 helper：演练结束 `pgrep -f "cu-preview preview-stream"` 为空。

未演练：真实 launchctl 卸载/重装当前安装（避免中断正在使用的 Harness 会话）、
权限被撤销后的恢复（本机权限仍为 true，不擅自重置 TCC）。

## 6. 已知限制

- 恢复旧快照会回到“app 旧、service 新”的历史状态；它可运行，但不是统一发布构建。
- 回滚只恢复二进制与配置，不删除 `~/.dsh` 会话、`~/.cu` 日志或用户凭证。
- 本文件中的路径含用户名；换机器时自行替换。
