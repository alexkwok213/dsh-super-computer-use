# GitHub 同步与推送流程

本文件是给下一个 AI / 下一个人的自包含操作说明：怎么把本目录的改动同步到 GitHub，以及哪些内容永远不能进入提交。目标是本地与远端随时一致。设计原因看 [经验沉淀.md](经验沉淀.md)，现场事实看 [协作记录.md](协作记录.md)。

## 一、固定事实

- 工作分支：`cu-execution-prototypes`。所有推送都推这个分支；`main` 是初始快照，不是工作分支，不要往上推。
- remote：`origin` = `https://github.com/alexkwok213/computer-use.git`，私有仓库。
- 认证：`gh` 已登录（凭据在系统 keyring）。不要在任何文件或配置里保存 token。
- 提交署名：每条提交信息结尾加一行 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。
- 当前提交号不写死在本文件里，用 `git log -1 --oneline` 现场读。
- 仓库没有 pre-commit 钩子，没有任何东西会替你挡住误提交——下面的检查必须手动执行。

## 二、四个「本机专用」文件

这四个文件**是已跟踪的**，GitHub 上的版本是通用版；本地工作区有本机专用改动。规则是：**只把通用版留在提交里，永远不暂存这四处的本地改动**（不是删除，也不是 untrack）。

| 文件 | 提交里的版本（通用） | 本机工作区的版本（不提交） |
| --- | --- | --- |
| `build.sh` | `IDENTITY="${CU_SIGN_IDENTITY:-}"`，并保留 `-n "$IDENTITY"` 的空值保护 | 默认 `IDENTITY` 硬编码为本机 Apple 开发者签名身份，空值保护被去掉 |
| `install-app.sh` | 同上 | 同上 |
| `examples/mcp-config.json` | 路径写作 `/YOUR_HOME/...` 占位 | 真实的本机主目录路径 |
| `协作记录.md` | 素材路径写作 `<用户的素材目录>/...` | 真实素材路径 |

另有未跟踪文件**不得提交**：`剪映-素材库-16段.png`（仅本地截图）。`对话档案-*.md` 已被 `.gitignore` 忽略。

## 三、为什么不能用 `git add -A` / `git add .` / `git commit -a`

这几个命令会把上面四处本机改动和未跟踪截图一起暂存，等于把本机签名身份、用户名和真实目录结构推送出去。`.gitignore` 对**已跟踪**文件无效：往 `.gitignore` 里加这四个文件名并不能保护它们，只会造成「已经忽略了」的错觉——不要这么做。

## 四、每次同步的标准流程

以下命令都在仓库根目录执行。

1. 确认分支与改动范围：

```sh
git branch --show-current   # 必须是 cu-execution-prototypes
git status --short          # 确认改动符合预期
```

2. 净化 `协作记录.md`，再按名暂存：

```sh
python3 - <<'PY'
import pathlib, re
p = pathlib.Path("协作记录.md")
home = str(pathlib.Path.home())
p.write_text(re.sub(re.escape(home) + r"(?=/|\b)", "<用户的素材目录>", p.read_text()))
PY
git add 协作记录.md
python3 - <<'PY'
import pathlib
p = pathlib.Path("协作记录.md")
p.write_text(p.read_text().replace("<用户的素材目录>", str(pathlib.Path.home())))
PY
```

两个片段的分工：第一个把本机主目录前缀换成占位符，`git add` 之后第二个再把占位符换回真实路径。结果是工作区保持本机可用，暂存区里只有净化版。若不用 `协作记录.md`，可跳过本步。

3. 其余要提交的文件逐个按名暂存（示例）：

```sh
git add README.md mcp/server.py tests/import_flow_units.py
```

4. 提交前检查（必须全过）：

```sh
git diff --cached --name-only
git diff --cached -- . ':(exclude)GITHUB同步.md' | grep -nE '/Users/|/home/|Apple Development:'
```

第一条输出的每个文件都要确认确实想提交；第二条必须没有任何输出。本文件自身含有检查用的模式串，所以检查时排除在外——它首次提交时已人工通读。

5. 提交。说明写清改了什么、验证了什么，结尾加署名行：

```sh
git commit -m "说明本次改动

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

6. 推送。必须带这组内联覆盖：本机默认凭据助手对这个 remote 不可用（会提示缺用户名或卡住）：

```sh
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin cu-execution-prototypes
```

7. 校验远端与本地一致：

```sh
git rev-parse HEAD
gh api repos/alexkwok213/computer-use/git/ref/heads/cu-execution-prototypes --jq .object.sha
git status --short   # 四个本机文件应仍显示为未暂存的修改
```

两个 SHA 相同才算推送完成。

## 五、出错时

- **push 被拒（non-fast-forward）**：说明远端领先。先 `git fetch origin`，用 `git log --oneline HEAD..origin/cu-execution-prototypes` 看差异，确认后用正常的 `git merge` 或 `git rebase` 处理再推。**不要强推**（`--force`、`--force-with-lease` 都不要用）。
- **认证失败**：跑 `gh auth status` 看登录状态；需要登录时由用户本人执行 `gh auth login`（HTTPS + 浏览器）。不要把 token 写进任何文件。
- **不确定某个文件该不该提交**：先不提交，到 [协作记录.md](协作记录.md) 查它的角色，或直接问用户。

## 六、交给下一个 AI 的现场

- 先读 [协作记录.md](协作记录.md) 最新一节（现场事实与未验证事项），再看 [经验沉淀.md](经验沉淀.md)（为什么这样设计、踩过哪些坑）。
- 当前全局约束（截至本文件写就时）：源素材只读，不移动、重命名、覆盖，不剪辑、不导出；本机操作走 `cu` 的 MCP 并保持后台，不抢占用户的鼠标与键盘；剪映 16 段导入任务停在「素材已就绪」，剪辑方案未定。
- 改完代码的部署顺序：`./build.sh` → `./install-app.sh`（后者会重启服务与菜单栏进程，别人正在用 CU 时先确认）→ 再按本文件推送。
