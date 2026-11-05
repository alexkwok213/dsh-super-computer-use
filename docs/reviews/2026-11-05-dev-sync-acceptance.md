# 2026-11-05 — dev:sync 真实 DSH 验收

> 本报告取代 `2026-11-05-real-dsh-acceptance.md` 中“Host 插件必须重启 DSH”的旧结论。该结论在当前 DSH 0.2.2-rc.1 上不成立：同进程 HMR 已实测可用。

## 环境

| 项 | 值 |
|---|---|
| DSH | 0.2.2-rc.1（desktop） |
| Host profile | `desktop` |
| Host pid | 36179（整个验收期间未重启） |
| 插件链接 | `~/.dsh/profiles/desktop/node_modules/dsh-super-computer-use` → `/Users/johnkwok/Downloads/work/dsh-super-computer-use` |
| helper | `bin/cu`，universal，Apple Development 签名 |
| 测试 | `node --test`，239 项，隔离 `CU_STATE_DIR` |

## 实际能力核对

- Host HMR：`ctx.hmr` 服务存在，公开 `runExclusive`、`watchConfig`、`reconcileProfile`。受控修改 `lib/index.mjs` 后触发 profile 重算，**同一 pid 36179** 出现新的 `module evaluated` 和 `apply()`，`cu_status.plugin.loadedAt/sourceHash` 立即变化，helper 从旧 pid 换到新 pid。证明 linked package 的 Host 模块可在进程内替换。
- Client HMR：`/plugins/events` 返回 `text/event-stream` 和完整 graph；`client.js` 的 artifact 变化经 `dsh-client-hmr` 推送，浏览器实际执行的 bundle URL 带 `rev`。
- 原生 helper：`buildId` 是 `bin/cu` 的 SHA-256；`cu_status.buildId` 与磁盘一致。
- 旧 README 的“HMR 只标记 pending”结论已被上述实测推翻。

## 最终运行版本

```text
hostPid                  36179
plugin.loadedAt          2026-11-05T14:57:16.593Z
plugin.sourceHash        1f95de3a3eb5445ed9eb4ef437c78a2a510c5a821c26e896408869cb4ced5355
plugin.client.entryRev   0f91020612d1
plugin.client.sourceHash 015c2601f50232f06a54be9370c7d73313a0e85895a20e1484043e63a530402a
plugin.native.serviceBuildId        8fe68aae0c560aa61ca7b93dfa1b45af051531cc26452b37cc14baac6d77c291
plugin.native.runningServiceBuildId 8fe68aae0c560aa61ca7b93dfa1b45af051531cc26452b37cc14baac6d77c291
plugin.native.runningPid            46267
```

`sourceHash` 的覆盖范围是 `package.json` + 全部 `lib/*.mjs`（9 个文件）；`client.js` 与 `bin/cu` 使用独立字段，不能用一个 `sourceHash` 冒充三部分都已更新。

## 验收记录

### 1. Host + Client 同轮更新

修改 Host 能力列表与 `client.js` 的 hello 间隔后执行 `npm run dev:sync`：

```text
[dev:sync] tests    passed
[dev:sync] reload   requested …
[dev:sync] client   rev 4794fe4cc860 observed, entry 4794fe4cc860
[dev:sync] native   pid 44726 build 8fe68aae0c56…; old pid 44426 exited
[dev:sync] leftover no helper/build process from this run remains
[dev:sync] OK       DSH is running this checkout (host c189a7397088…, client 4794fe4cc860, native 8fe68aae0c56…)
```

退出码 0。`loadedAt` 变化，Host pid 不变；浏览器 hello 的 `rev` 与当前 client graph entry 一致；旧 helper 退出。

### 2. 原生构建

在 `engine/Sources/main.swift` 加一行无行为影响的注释，执行 `npm run dev:sync`。`scripts/build-universal.sh` 产出新的 universal helper（`a1b73ead…`），插件回收旧 helper 并在新 pid 上启动新 buildId。随后恢复原二进制并重新构建/同步，最终回到 `8fe6…`。构建失败时 CLI 用新 inode 恢复旧二进制；测试失败时不重载。

### 3. 原生-only 更新与 helper 回收

只替换 `bin/cu`（使用同代码、不同签名的 `cu-preview` 作为受控原生物），Host 模块不变：

```text
[dev:sync] plan     host same, client same, native changed, build skipped
[dev:sync] native   pid 44818 build 7aac8e85de6a…; old pid 44773 exited
[dev:sync] OK       DSH is running this checkout (… native 7aac8e85de6a…)
```

恢复原 `bin/cu` 后再执行，回收回 `8fe6…`，旧 pid 退出。证明“仅原生变化”不依赖 Host 重载也能回收并启动新 helper。

### 4. 活跃 CU 会话暂缓

在 Finder 窗口上启动一个不带 halo/dock 的 CU 会话，然后执行：

```text
[dev:sync] plan     host same, client changed, native same, build skipped
[dev:sync] BLOCKED: CU is busy; the update was deliberately not forced
[dev:sync]   {"reason":"active_cu_session","detail":{"windowId":31867,"pid":14149,"app":"Finder"},"waitedMs":0}
```

退出码 3，Host/Client/helper 均未重载。停止会话后重新执行成功。

### 5. 测试与失败路径

- 完整套件 239 项通过；`scripts/test-isolated.mjs` 使用临时状态目录，结束时核对真实 `~/.cu/config.json` 与 `pause` 未变化。
- 负载下曾出现 helper 启停时序抖动（`service_daemon`/`service_lifecycle_regressions`）和一次 `preview_stream_transport` 长时间等待。已把测试改为串行、单测试 120s 上限，并让 `dev:sync` 失败后重试一次；两次失败仍退出 1 且不重载。这是测试稳定性限制，不是通过跳过测试掩盖。
- 构建/测试失败时不会发送重载请求；旧运行版本继续服务。

## 发现并修复的关键问题

1. **`sourceHash` 覆盖不足**：原来只有 `lib/index.mjs` + `lib/core.mjs`。现覆盖 manifest + 全部 Host 模块，并新增 Client/原生独立身份。
2. **Client bundle 不能重复执行**：最初把 `const SCRIPT_URL/SCRIPT_REV` 放在 classic script 顶层，第一次 swap 成功，第二次因全局词法重声明静默失败。现整体包在 IIFE 中，并增加“同一 VM 连续执行两次”的回归测试。
3. **`ctx.hmr` 访问方式**：Cordis 不允许未声明 `inject` 的 `ctx.hmr` 属性访问；改用 `ctx.get("hmr")` 得到的服务对象。
4. **自重载与 `watchConfig` 死锁**：在 `watchConfig` 的 refresh 内调用 `reconcileProfile` 会让 disposer 等待 refresh、refresh 等待重载。改为 generation 独占的请求文件 + `watchFile`，重载仍走官方 `runExclusive` + `reconcileProfile`；必要时用 `hmr.executing.exit` 清除继承的事务标记。
5. **旧 generation 覆盖新状态**：重载后旧 reconcile promise 仍可能写 `restart_required`。现用 generation `loadedAt` 栅栏阻止旧 generation 覆盖新状态。
6. **原生-only 不重载 Host 时 helper 不换**：新增“仅回收本插件管理的 helper 再启动 bin/cu”，并重新探测 buildId；不杀非本插件管理的服务。
7. **原地恢复签名二进制被 Gatekeeper 杀**：恢复旧二进制改为写临时文件 + rename（新 inode），避免 stale `com.apple.provenance` 导致 SIGKILL。

## 剩余限制

- Client 更新依赖打开的 DSH 页面及其 `dsh-client-hmr` SSE 连接。连接关闭时命令以 `needs_client` 退出 3，需要刷新页面后重跑；不会自动刷新页面或伪造客户端已更新。
- 原生构建需要 Xcode CLT 与可用签名身份；没有时构建失败，命令退出 1，不会用旧 helper 冒充新版本。
- Host HMR 依赖当前 DSH 版本暴露的 `ctx.hmr`。若 `runtime.hmr.available` 为 false，命令退出 3，不尝试私有缓存清理或强制重启。
- 测试套件在系统高负载下仍有少量时序抖动；已串行化并重试一次，但这不等于消除所有 flaky 因素。

## 未做

- 未修改 `app.asar`。
- 未新增控制端口或常驻后台服务。
- 未提交、未推送、未创建 Release。
- 测试未修改真实 `~/.cu/config.json`。验收期间一次手工复现曾在无 `CU_STATE_DIR` 的情况下临时改写 port；已恢复 port 53484、由插件重启 helper 重新生成 token，并清理孤儿 helper。最终配置只由运行中的插件维护。
