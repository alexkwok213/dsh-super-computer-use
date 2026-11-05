# AGENTS.md — DSH Super Computer Use

本文件是本仓库的常驻工作规范。任何 AI 或开发者修改代码前先读它；规则与代码同等重要。

## 项目边界

- 这是一个 **DSH（DeepSeek Harness）Host 插件 + Web Client + macOS 原生 helper**。
- 桌面 profile 通过软链接加载本仓库，文件同步不等于运行版本同步。
- 不修改 DSH 的 `app.asar`；不新增无认证控制端口；不依赖 Node 私有缓存清理；不启动脱离插件管理的临时常驻服务来“救活”验收。
- GitHub 提交、推送、Release 是独立操作，**不绑定到 `dev:sync`，也不由本命令自动执行**。

## 每轮开发的强制收尾

> 每轮代码修改完成后，必须运行项目开发更新命令，完成测试、必要构建、DSH 重载和真实运行版本核验。未经运行版本核验，不得宣称修改已在 DSH 生效。若有活跃任务、权限限制或宿主能力限制，明确报告阻碍，不强制重启、不临时启动常驻服务绕过。

对应命令：

```bash
npm run dev:sync
```

它默认依次执行：

1. 校验 `~/.dsh/profiles/desktop/node_modules/dsh-super-computer-use` 仍指向当前仓库。
2. 运行完整测试套件（隔离 `CU_STATE_DIR`，串行执行，单测试 120s 上限，失败后重试一次）。
3. 仅当 `engine/Sources/*.swift` 或 `scripts/build-universal.sh` 变化，或 `bin/` 与构建记录不一致时构建 universal helper。
4. 通过运行中插件官方暴露的 `ctx.hmr.runExclusive` + `reconcileProfile` 重载 Host 模块；客户端走 DSH 自带 Client HMR；原生 helper 由插件回收并重启。
5. 在真实 DSH 中核对 Host `sourceHash`、Client 实际执行的 bundle `rev`、原生 helper `buildId`，并确认旧 helper 退出、没有本次流程遗留的进程。

**只有命令以退出码 0 结束，并且输出 `OK`，才能说“已在 DSH 生效”。** 退出码 3 表示被活跃 CU 会话、页面未连接、HMR 不可用或需要重启阻塞；如实报告，不伪造成功。

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
npm test                                  # 完整隔离测试
npm run dev:sync                          # 测试 -> 必要构建 -> 重载 -> 真实核验
npm run dev:sync -- --check-only          # 只检查链接、运行版本与计划，不改动
npm run dev:sync -- --wait-idle=30        # 最多等 30s 空闲 CU
npm run dev:sync -- --skip-tests          # 仅限明确不需要测试的排障；不得声称测试通过
npm run build:bin                         # 手动重建 universal helper
```

详细说明见 `docs/dev-sync.md`。
