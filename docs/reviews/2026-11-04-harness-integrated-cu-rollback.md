# 回滚说明：Harness 内嵌 Computer Use（2026-11-04）

执行前确认路径；所有备份都在仓库 `.rollback/`，没有删除用户会话或凭证。

## 已保存的回滚信息

| 内容 | 路径 |
|---|---|
| 基线（HEAD/status/系统） | `.rollback/baseline-20261104-212921.txt` |
| 原始插件 package.json | `.rollback/plugin-package.json.bak` |
| 原始 profile package.json | `.rollback/profile-package.json.bak` |
| 原始 profile cordis.patch.yml | `.rollback/profile-cordis.patch.yml.bak` |
| 替换前的已安装引擎 | `.rollback/cu-installed-20261104-215341` |
| 当前已安装引擎（新） | `~/Library/Application Support/cu/bin/cu`（sha `b950e36…`） |
| 预览 helper | `~/Library/Application Support/cu/bin/cu-preview` |

## A. 只回滚配置（保留新代码）

```bash
python3 - <<'PY'
p = '/Users/johnkwok/.dsh/profiles/desktop/cordis.patch.yml'
s = open(p).read()
a = s.find('# BEGIN super-computer-use embedded viewer')
b = s.find('# END super-computer-use embedded viewer')
if a != -1 and b != -1:
    s = s[:a] + s[b:].split('\n', 1)[1]
open(p, 'w').write(s)
PY
```

触发重载：在 Harness 里开关一次该插件，或在 profile patch 末尾加一个空行让 HMR 重组。

## B. 回滚引擎（恢复旧服务二进制）

```bash
cp "/Users/johnkwok/Downloads/work/super-computer-use/.rollback/cu-installed-20261104-215341" \
   "$HOME/Library/Application Support/cu/bin/cu"
rm -f "$HOME/Library/Application Support/cu/bin/cu-preview"
launchctl kickstart -k "gui/$(id -u)/local.cu.service"
```

注意：本轮已用新构建替换过服务二进制；旧构建没有 `preview-stream`。回滚后内嵌预览会返回 `engine_missing`/`503`，卡片仍显示状态但无视频，属预期。

## C. 完全移除插件 UI 与工具

1. 在 Harness → 插件 → `dsh-super-computer-use` 关闭该 bundle（或从 profile `dsh.profile.bundles` 移除）。
2. 如需恢复 profile 原始文件：

```bash
cp .rollback/profile-cordis.patch.yml.bak ~/.dsh/profiles/desktop/cordis.patch.yml
cp .rollback/profile-package.json.bak ~/.dsh/profiles/desktop/package.json
```

3. 重新打开 Harness（页面会重新加载插件图）。

## D. 代码

本轮改动未提交、未推送。需要丢弃时：

```bash
cd /Users/johnkwok/Downloads/work/super-computer-use
git checkout -- lib/index.mjs lib/core.mjs lib/action-events.mjs package.json \
  engine/Sources/main.swift engine/install-service.sh
rm -f client.js lib/cu-ui-session.mjs lib/harness-ui-bridge.mjs lib/preview-stream.mjs \
  engine/Sources/PreviewFrameOutput.swift \
  test/harness_ui_manifest.mjs test/cu_ui_session.mjs test/harness_ui_bridge.mjs test/preview_stream_transport.mjs
```

不要删除 `docs/2026-11-04-harness-integrated-cu-design.md`、`docs/research/`、`docs/superpowers/plans/`（本轮开始前已存在、未跟踪）。

## 已验证的回滚前置条件

- 会话保存在 `~/.dsh` 下，上述步骤不删除会话文件。
- 停止/卸载后 `pgrep -f 'cu-preview preview-stream'` 为 0（本轮实测）。
- 旧引擎备份是可执行的同一 macOS 架构二进制（1519680 B）。
