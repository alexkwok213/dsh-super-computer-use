# 开发更新：`npm run dev:sync`

本命令把当前 checkout 的代码更新到**正在运行的 DSH**，并在真实运行版本上核验。它不提交、不推送、不发布，也不修改 `app.asar`。

## 快速开始

```bash
npm run dev:sync
```

成功时最后一行类似：

```
[dev:sync] OK       DSH is running this checkout (host 1f95de3a3eb5…, client 0f91020612d1, native 8fe68aae0c56…)
```

退出码：

| 码 | 含义 |
|---|---|
| 0 | 链接、测试、必要构建、重载、真实运行版本全部核验通过 |
| 1 | 链接错误、测试失败、构建失败、重载失败或运行版本核验失败 |
| 2 | 参数用法错误 |
| 3 | 被阻塞：活跃 CU 会话、浏览器页面未连接、HMR 不可用、或需要重启 DSH |

**退出码 3 不是成功。** 不要用重启 DSH、临时常驻 helper 或手工伪造状态来“修好”验收。

常用选项：

```bash
npm run dev:sync -- --check-only       # 只检查链接、运行版本和将要做的事
npm run dev:sync -- --wait-idle=30     # 活跃 CU 会话时最多等 30 秒空闲
npm run dev:sync -- --timeout=90       # 总重载/核验预算
npm run dev:sync -- --force-build      # 即使源码未变也重建 helper
npm run dev:sync -- --skip-tests       # 仅排障；不得声称测试通过
npm run dev:sync -- --json             # 输出机器可读结果
```

## 它实际做了什么

1. **校验链接**：`~/.dsh/profiles/desktop/node_modules/dsh-super-computer-use` 必须 realpath 到本仓库；不会自动改链接。
2. **运行测试**：`scripts/test-isolated.mjs` 使用临时 `CU_STATE_DIR`，串行执行，单个测试 120 秒上限。失败会自动重试一次；两次都失败则不重载，退出 1。真实 `~/.cu/config.json` 与 `pause` 不会被测试修改。
3. **必要时构建原生 helper**：仅当 `engine/Sources/*.swift` 或 `scripts/build-universal.sh` 的哈希与构建记录不同，或 `bin/cu`/`bin/cu-preview` 与记录不一致时，运行 `scripts/build-universal.sh`。只改 JS/Client 不会重复编译。构建失败会用新 inode 恢复旧二进制（macOS 的 provenance/签名缓存拒绝原地覆盖）。
4. **请求运行中插件重载**：CLI 把请求写入运行插件发布的 generation request 文件；插件检查 CU 空闲后，使用官方 `ctx.hmr.runExclusive(() => ctx.hmr.reconcileProfile([...]))`。Host 模块变化时同进程替换，不重启 DSH。
5. **Client 更新**：依赖 DSH 自带的 `dsh-client-hmr`。新 bundle 执行后通过已认证的 `/api/scu/client-hello` 上报实际执行的 bundle `rev` 和 `dev-sync-hello` capability；Host 将其与当前 client graph entry/batch rev 比对。
6. **原生 helper 更新**：Host 重载会回收并重启 plugin 管理的 helper；仅原生变化、Host 未重载时，插件会先回收自己管理的旧 helper，再启动 `bin/cu`。`buildId` 必须等于磁盘 `bin/cu` 的 SHA-256，旧 pid 必须退出。
7. **核验**：CLI 再独立读取运行插件写的 runtime/client 报告、查询 helper `/v1/status`、检查进程路径与遗留进程。任一必需项不匹配都退出非 0。

## 运行版本身份

`cu_status.plugin` 现在分别给出三部分身份：

```jsonc
{
  "sourceHash": "…",          // package.json + 所有 lib/*.mjs
  "hostSourceHash": "…",      // 同上（兼容别名）
  "client": {
    "version": "0.3.0",
    "sourceHash": "…",       // client.js 的 SHA-256
    "entryRev": "…",         // Host client graph 当前 entry rev
    "entryUrl": "plugins/??…&rev=…",
    "batchRevs": ["…"]
  },
  "native": {
    "serviceBuildId": "…",       // 本 generation 加载时 bin/cu 的 SHA-256
    "runningServiceBuildId": "…",// 实际运行 helper 的 buildId
    "runningPid": 12345,
    "previewBuildId": "…"
  }
}
```

`plugin.sourceHash` **不再只覆盖 index.mjs/core.mjs**；它覆盖 manifest 和所有 Host 模块。Client 和 native 不再被这个字段“顺带证明”，各自有独立字段。

## 限制与排障

- **页面必须打开**：Client 更新依赖页面的 `dsh-client-hmr` SSE 连接。若连接已关闭，命令会以 `needs_client` 退出 3；刷新 DSH 页面后重跑。当前实现不会自动刷新页面，也不会把“文件已写”当成“浏览器已执行”。
- **Client bundle 必须可重复执行**：`client.js` 外层使用 IIFE。Client HMR 会在同一个全局词法环境再次执行 classic script；顶层 `const` 会触发 `Identifier has already been declared`，导致第二次 swap 静默失败。
- **活跃 CU 会话不强制**：插件检查 `manager.activeSession`、在飞工具和最近 1.5 秒的 mutating 工具活动。忙时写 `deferred`，CLI 以退出码 3 报告；不会杀会话或强重启。
- **HMR 能力因宿主版本而异**：某些桌面版已验证存在 `ctx.hmr.runExclusive/watchConfig/reconcileProfile`；若当前宿主没有这些 API（`runtime.hmr.available` 为 false，常见于本次验收环境），命令会退出 3 并要求正常重启 DSH。不得伪造同进程重载。
- **原生构建**：需要 Xcode Command Line Tools（`swiftc`、`lipo`）和可用签名身份（`engine/signing-identity`，或 ad-hoc）。构建产物写在仓库 `bin/`，构建记录在 `~/.cu/dev-sync/<repo-key>/build.json`。
- **测试抖动**：套件在系统高负载下出现过 helper 启停竞态。`dev:sync` 已改为串行、单测 120s 上限、失败重试一次；若两次都失败，仍应视为失败并排查，而不是跳过。
- **状态目录**：开发控制文件在 `~/.cu/dev-sync/<repo-key>/`（runtime/status/client/request/build）。若设置了 `CU_STATE_DIR`，Host 和 CLI 必须使用同一个值。

## 不做的事

- 不做“保存即重载”；只在测试和必要构建完成后统一更新。
- 不修改 `app.asar`，不新开控制端口，不依赖私有缓存清理。
- 不启动脱离插件管理的临时常驻服务。
- `dev:sync` 本身不提交、不推送、不发布；每轮强制发布由 `npm run release -- patch|minor|major` 完成，见 [`release.md`](release.md)。
