# Harness 内嵌 CU：总设计复核与下一轮范围

日期：2026-11-04。复核基线：`52b244f`，main ahead origin/main 4 commits。结论：**第一阶段集成成立，稳定性验收未闭环；先修竞态和交付一致性，再打磨视觉。**

本次只新增审查、探针和方案；未修改产品源码，未重启服务或 Harness，未执行实际桌面输入。

## 1. 证据等级

- 亲自读取：当前源码、验收与回滚文档、22 分钟采样 CSV。
- 亲自执行：四个新增内存探针，全部 `reproduced:true`；现有四个相关测试文件 **26/26 通过**；四处本机引擎 SHA-256。
- 亲自观看：45 秒演示中约第 5 秒的画面抽帧，可确认内嵌大面板、半透明背景、TextEdit 画面、停止入口和常驻诊断信息。没有把单帧当作整段动态验收。
- 执行 AI 的报告：真实 Harness gate、目标切换、首帧、8.4–8.9 fps 等。本轮没有重新在真实宿主跑一遍，因此保留为上轮报告，不冒充独立实测。
- 未完成：真实双 Agent 竞争、目标退出／最小化、断线／重启、30 分钟完整长测、停止端到端 P95。

复现命令：

```bash
node docs/reviews/harness-round2-probes.mjs
node --test test/cu_ui_session.mjs test/harness_ui_bridge.mjs test/harness_ui_manifest.mjs test/preview_stream_transport.mjs
```

探针代码：[harness-round2-probes.mjs](harness-round2-probes.mjs)；结果：[JSON](evidence/harness-round2-probes.json)。探针 exit 0 仅代表完成运行，`reproduced:true` 表示缺陷存在，不是产品通过。Client 探针从当前 client.js 在内存中暴露类，使用模拟计时器／解码 Promise；没有修改真实 Client 或操作桌面。

## 2. 已复现的阻断项

### R1 / P1：卸载中的轮询会复活

位置：`client.js:509–551`，`SessionStore.stop/pollNow/schedule`。

`stop()` 清计时器并 abort 在途请求，但请求的 finally 无条件 schedule。探针在请求未完成时 stop，结果 mounts=0 但 timersAfterStop=1。它可能继续向旧会话轮询；Host state route 又会 armIdleStop，所以 UI 卸载后仍可能延长 owner 生命周期。

修复：store 具有 active/disposed 与 lifecycle epoch；每次 start 捕获 epoch，stop 使其失效；finally、applySnapshot、schedule 都检查当前 epoch 且 active。重新 mount 能开启新 epoch；旧请求不能修改新 epoch 的 inflight/abort。

验收：请求 pending 时 unmount/stop，abort resolve 后没有 timer/fetch；重复 mount/unmount 50 次，单一活动 poller；重新 mount 后旧请求 settle 不影响新请求。

### R2 / P1：异步解码完成后可以画出旧目标

位置：`client.js:336–392`，`PreviewController.present`。

解码前验证 generation，但 createImageBitmap.then 只检查当前 running/abort。目标 A 的解码尚未完成时切到 B，新 stream running=true，A 的 then 会通过并 drawImage。探针确认 generation1 在切到 generation2 后仍绘制一次，状态变 live。

修复：每次 present 捕获 stream token、cuSessionId、targetGeneration；解码前后都检查同一身份。旧 Promise 不得清除新 stream 的 decoding 状态。切目标清空 canvas 或明确标旧画面；首帧计数与 timeout 按 stream 重置，不沿用累积 frames。

验收：延迟 A 解码→切 B→A resolve，draw=0，bitmap.close 恰好一次，B 的解码锁不变；B 第一帧到达后才能 live。连续切 20 次，旧帧不回闪。

### R3 / P1：旧动作结果能覆盖同一聊天的新会话

位置：`lib/cu-ui-session.mjs:227`、`lib/index.mjs:506–539`。

endAction 只检查 hostSessionId 和 owner 是否 active。A 动作未结束→停止→同一聊天重新 claim/start→A 结果返回，会修改新 owner。现有 late-result 测试只覆盖“仍停着”的分支。探针里新 cu_type 会话被旧 click 结果改成 failed / old_click_failed。

修复：beginAction 返回不可变 ticket `{hostSessionId,cuSessionId,actionId}`，endAction 要求 ticket 匹配当前活动动作；包装器捕获 ticket 后 await，不从最新 owner 临时补身份。异步 stop 完成也必须绑定其开始时的 owner。

验收：旧会话、同会话旧 action、停止后同聊天新会话、不同聊天接手四类迟到结果都不覆盖新状态。

### R4 / P1：正常状态更新能让停止按钮失效

位置：`lib/cu-ui-session.mjs:311`、`client.js:619–649`。

Client 带轮询取得的 expectedRevision；动作完成或 preview 状态变化都会 bump。若点击停止发生在两次轮询之间，control 因 stale_revision 返回 409，在关闭输入闸门之前退出。探针确认 status=409、inputGateClosed=false；Client 仅刷新，未完成本次停止。

**这是上一版设计需要纠正的地方**：STOP/TAKEOVER 应校验 hostSessionId + cuSessionId，允许同一控制会话内 revision 落后；不允许跨 cuSessionId 停止新会话。不能靠自动给新 owner 重发停止“修复”。

验收：当前 cuSessionId 下任意旧 revision，stop 都能关闸；旧 cuSessionId 必须 409 且不影响新 owner；并发重复 stop 只执行一次清理，先返回既有 stopPromise 再处理普通状态冲突。

## 3. 源码已发现、尚需补充行为测试的问题

### S1 / P1：用户停止的锁存和自动重新开始

UI control 不传 pause，调用 stopVisualSession({pause:false})。下一次工具包装器可重新 claim；坐标 click 在没有 activeSession 时自动 startVisualSession，而该方法重开 inputGate、清 pause 并 resume。见 `lib/index.mjs:1588`、`lib/core.mjs:1965–1986`。

因此不能以“stop 返回时 gate=true”证明同一轮 AI 后续调用都被阻断。下一轮必须用真实工具包装器＋模拟 native executor 复现，不真实点击用户桌面。设计要求：用户 STOP/TAKEOVER 锁存暂停，普通 click/type/batch 不能解除；明确 start/resume 才恢复。工具自然结束／idle timeout 与用户停止分开。

### S2 / P1：状态源未统一，自动停止可能没有释放 owner

当前 UI 状态来自工具包装器 begin/end，不是统一 action event 的订阅。manager 的 idle/session timer 直接 stopVisualSession，registry 没有对应同步入口；活动 owner 可能仍占用，目标还是旧值。`cu_expect` 成功返回 ok:true 时，若没有 wrapper 所识别的 verified 字段，UI 还可能显示未验证。

要求：manager 的自动结束通知 registry；动作状态按带 ticket 的规范事件归约，verified 有证据才成立。不要创建第二套猜测引擎状态的计时器。观察者 presence 和真实输入活动分开，避免轮询本身无限续命。

### S3 / P2：预览 helper 自然退出没有统一清理

`lib/preview-stream.mjs:191–212` exit 分支直接设 closed，没有调用 cleanup；guard interval 与 byOwner 引用留存。dispose 只遍历 active 子进程，不能清这些已 exit 的定时器。request.signal 也未显式绑定；仅 response.cancel 的测试不能覆盖所有退出路径。

要求：一个幂等 finalize 负责 timer、byOwner、active、监听器和流；旧 helper 的 finalize 不覆盖新 helper 状态；分别测自然 exit、error、abort、cancel、dispose、换代。背压当前是丢新帧、保留队列旧帧，不是“最新帧替换”，需在报告中准确描述，或实现一帧 pending latest。

### S4 / P2：Swift 捕获跨队列共享可变状态

`PreviewFrameOutput.swift:68–91`：captureQueue 写 encoding，encodeQueue 清 encoding，主线程修改 stopped，dropped 也跨队列访问；无锁或串行归属。静态可确认存在未同步访问，但本轮没有跑 Thread Sanitizer。

要求：明确 state 的唯一串行队列或同步机制，保持编码不阻塞采集；处理 SCStream didStopWithError、无首帧和退出；不要只把 fps 参数调大。

### S5 / P2：生产默认与诊断体验

`uiProbe` 源码默认 true；目前只在用户 profile 关闭。Client mount 仍 runProbe；产品展开视图常驻 Carrier/Probe/Generation 等诊断信息。正常使用不需要这些。

要求：probe 默认 false，禁用时不发探测请求；诊断收进默认折叠的详情；移除产品对 modules.pkgMeta/dirty/flush 等内部迁移行为的日常依赖。小卡片 previewWanted 默认 false，当前首屏并非自动小窗直播，下一轮需明确“点击观看”而不是空白框。

## 4. 安装与报告必须收尾

本轮独立 SHA-256 检查：

| 路径 | 结果 |
|---|---|
| engine/bin/cu | b950e361…df8d |
| ~/Library/Application Support/cu/bin/cu | b950e361…df8d |
| 同目录 cu-preview | b950e361…df8d |
| /Applications/Computer Use.app/Contents/MacOS/Computer Use | **9beef70a…bf52** |

服务与 helper 同构建、应用本体旧构建属实。先统一发行来源、签名与安装验证，不允许菜单栏和服务长期运行不同版本。`cu-preview` 保留方案可用，但“同路径必然被 macOS 拒绝捕获”目前只有单机报告，需要保留为经验性 workaround，不能写成普遍平台定律。

回滚文档仍写“本轮未提交”，实际已提交。其 `git checkout --` 对当前 HEAD 无法撤掉功能，接着 rm 会删除已跟踪依赖，可能留下不可加载插件。**不要执行该文档 D 段。** 改为先恢复可用配置和一致二进制，再针对明确 commit 范围生成可审阅 revert 或使用已验证的发布快照，禁止覆盖之后的用户配置。

CSV 确认 23 样本、1322 秒。22 分钟是部分证据，不能延长文字成 30 分钟。6 次 CLI median 的 +1.9% 不是 P95，也不是性能回退的“保守上限”。0 ms 是服务收到请求后的同步闸门耗时，不是用户点击到停住的端到端延迟。

## 5. 下一步产品建议：放在哪里、先做什么

### 默认布局

- **主入口放在当前聊天输入框上方**，沿用已工作的 `conversation.input.dock`，不改 Harness 主布局。空闲不占位；开始时显示应用名、状态、停止和“观看”。
- 用户点“观看”后显示 320 px 小预览；可收为约 40 px 状态条。不要开局弹出大模态遮住聊天，也不要显示等待用户点击的空黑画框。
- **大预览仍放在 shell.overlay**，只在用户主动展开时显示。停止按钮固定、Esc 收起并归还焦点。为真正模态补焦点约束／后台不可交互；关闭观看不停止执行，但停止执行必须停止采集。
- **桌面浮窗只作 native 模式和必要回退入口**。已有嵌入 viewer 时不再显示重复胶囊、粉色边框或窗口。
- 诊断数据放在展开面板的“详情”中，默认折叠；普通界面只保留目标、进度含义、画面是否实时、停止。

### 开发顺序

1. **稳定性修复批次**：R1–R4、S1–S4、版本一致、回滚纠正；这一批次决定能否日常使用。
2. **完整验收批次**：异常路径、真实双聊天、完整 30 分钟、用户点击到停住的延迟、client 实际绘制 FPS 和动作 P95。
3. **视觉收敛批次**：状态条／观看卡片／展开三级、诊断折叠、焦点、主题和动画；保持当前 8–10 fps 起点，按用户任务决定是否需要提高。
4. **之后单独立项**：浏览器 DOM 通道、可点击预览、15/30 fps 或视频编码优化。当前不要混进稳定性补丁，也不需要立即 fork Harness。

预览只读是上一轮刻意限定的正确范围，不算未完成缺陷；不能为“像 Codex”仓促加入坐标穿透。没有统一状态、停止和资源回收前，增加动画与帧率会放大问题。

下一轮可执行方案：[稳定性与交付收尾](../superpowers/plans/2026-11-04-harness-cu-round2-hardening.md)。
