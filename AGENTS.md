# AGENTS.md — DSH Super Computer Use

本文件是本仓库的常驻工作规范。任何 AI 或开发者修改代码前先读它；规则与代码同等重要。

## 项目边界

- 这是一个 **DSH（DeepSeek Harness）Host 插件 + Web Client + macOS 原生 helper**。
- 桌面 profile 通过软链接加载本仓库，文件同步不等于运行版本同步。
- 不修改 DSH 的 `app.asar`；不新增无认证控制端口；不依赖 Node 私有缓存清理；不启动脱离插件管理的临时常驻服务来“救活”验收。
- GitHub 提交、推送、Release 是每轮收尾的强制组成部分；由 `npm run release` 统一执行，不由 `dev:sync` 隐式执行。

## 每轮开发的强制收尾

> 每轮代码修改（功能、修复、UI、文档）完成后，必须同时完成 **版本升级、测试、DSH 重载、GitHub 提交/推送/Release**。任何一项缺失，本轮不得宣称完成。未经运行版本核验，不得宣称修改已在 DSH 生效。

对应命令：

```bash
npm run release -- patch|minor|major
```

它依次执行：

1. 把 `package.json` 的 `version` 与 `client.js` 的 `CLIENT_VERSION` 同步升到新版本（两者必须一致）。
2. 运行 `npm run dev:sync`：校验软链接、完整隔离测试、必要原生构建、DSH Host/Client 重载、helper 回收、真实运行版本核对。
3. `git add -A` → commit → 推送 `main`。
4. 创建并推送 `vX.Y.Z` tag，触发 `.github/workflows/release.yml`。
5. `gh run watch` 等待构建/测试/打包完成，并核对 GitHub Release 的 tag 与资产。

**只有命令输出 `[release] RELEASE OK <url>` 且退出码为 0，才能说本轮完成并在 GitHub 上发布了新版本。** 若 GitHub Actions 失败，必须修复后重新发版，不能只推 tag 了事。

版本选择：修复用 `patch`，功能/优化用 `minor`，破坏性变更或里程碑用 `major`。禁止无版本变更的“只提交代码”。

不要采用“保存即重载”。这是操控电脑的插件，逐行保存会打断正在执行的操作；统一在测试和必要构建完成后更新。

## 关键实现约束

- **Host 重载**：优先使用当前 DSH 版本实际存在的 `ctx.hmr` 接口。当前桌面版 0.2.2-rc.1 已验证支持同进程重载 linked package；不要依据 GitHub master 文档猜配置。
- **Client 更新**：依赖 DSH 自带的 `dsh-client-hmr`。Client bundle 必须能被同一个页面**重复执行**（外层 IIFE，避免顶层 `const` 重声明）；新 bundle 通过已认证的 `/api/scu/client-hello` 上报实际执行的 `rev`。
- **原生 helper**：`buildId` 是 `bin/cu` 的 SHA-256，必须与运行中 helper 的 `cu_status.buildId` 一致。原生变更时先回收本插件管理的旧 helper，再启动新 helper；不得杀非本插件管理的服务。
- **身份字段**：`plugin.sourceHash` 覆盖 `package.json` + 所有 `lib/*.mjs`；`plugin.client.sourceHash`/`entryRev` 覆盖 Client；`plugin.native.serviceBuildId` 是加载时磁盘身份，`runningServiceBuildId` 是实际运行 helper 的身份。不要用一个字段冒充三部分都已更新。
- **测试隔离**：测试必须使用临时 `CU_STATE_DIR` 和临时端口；不得改写真实 `~/.cu/config.json`、`~/.cu/pause`。失败路径也要清理临时状态、构建临时文件和 CLI 锁。
- **进程卫生**：构建失败时用“新 inode”恢复旧二进制（macOS 的 provenance/代码签名缓存会拒绝原地覆盖的已签名可执行文件）；不要用定时杀进程代替状态检测。
- **不无限等待**：CLI 有总超时；测试单测有 120s 上限；活跃 CU 会话的等待有上限，超时退出 3。

## 常用命令

```bash
npm run release -- patch|minor|major       # 强制收尾：升版本 -> dev:sync -> commit/push -> tag -> Release 核验
npm test                                  # 完整隔离测试
npm run dev:sync                          # 内部步骤：测试 -> 必要构建 -> 重载 -> 真实核验
npm run dev:sync -- --check-only          # 只检查链接、运行版本与计划，不改动
npm run dev:sync -- --wait-idle=30        # 最多等 30s 空闲 CU
npm run dev:sync -- --skip-tests          # 仅限明确不需要测试的排障；不得声称测试通过
npm run build:bin                         # 手动重建 universal helper
```

详细说明见 `docs/dev-sync.md`。
