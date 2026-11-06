# 发布流程（强制）

本仓库每一个代码修改轮次都必须以一次可验证的 GitHub 发布收尾。规则写在 `AGENTS.md`，入口只有一个命令：

```bash
npm run release -- patch|minor|major
```

## 一条命令做什么

`scripts/release.mjs` 依次执行：

1. 校验当前分支是 `main`，且存在 `origin`。
2. 同步升级两个版本字段：
   - `package.json` → `version`
   - `client.js` → `CLIENT_VERSION`
3. 运行 `npm run dev:sync`：
   - 完整隔离测试（临时 `CU_STATE_DIR`）
   - 必要时构建 universal helper
   - 通过运行中 DSH 的官方 HMR 接口重载 Host/Client
   - 回收旧 helper、启动新 helper
   - 在真实 DSH 上核对 Host `sourceHash`、Client `entryRev`、native `buildId`
4. `git add -A` 后提交全部改动。
5. 推送 `main`，创建并推送 annotated tag `vX.Y.Z`。
6. 等待 `.github/workflows/release.yml` 完成（构建、测试、打包），并核对 GitHub Release。

只有输出以下内容并以 0 退出，才算本轮完成：

```
[release] RELEASE OK https://github.com/alexkwok213/dsh-super-computer-use/releases/tag/vX.Y.Z
```

## 版本选择

| 改动类型 | 参数 | 示例 |
|---|---|---|
| Bug 修复、文案、小调整 | `patch` | `0.4.0 → 0.4.1` |
| 新功能、优化、行为变更 | `minor` | `0.4.0 → 0.5.0` |
| 破坏性变更、里程碑 | `major` | `0.4.0 → 1.0.0` |

不允许“只提交代码、不升版本”。GitHub Actions 会校验 tag 与 `package.json` 版本一致，不一致直接失败。

## 其他参数

```bash
npm run release -- --version 0.4.0     # 显式指定版本
npm run release -- minor --dry-run     # 只打印版本变化，不写文件/不发布
npm run release -- minor --no-watch    # 已推送但不在本地等待 Actions（仅排障）
npm run release -- minor --message "feat: ..."  # 自定义提交信息
```

## 注意

- **不要手工移动 tag**：发布后如需修复，升 `patch` 重新发布，不复用旧 tag。
- 大体积本地录屏（`docs/demo/two-apps-background.mov`、`docs/demo/zcode-claude-cu-demo.mov`）已加入 `.gitignore`，不进入版本库。
- `dev:sync` 仍是可单独运行的内部步骤，用于排障；它不是一轮工作的完成标志。
- 发布依赖 `gh` 登录与 `workflow` 权限；缺权限时脚本会失败并如实报告。
