# Codex 式体验 · 实施报告（对照 2026-11-04 计划与第二轮复查）

- 分支：`codex-experience`（基于 `8e1f6ce`，`main` 未动）
- 计划：[2026-11-04-cu-codex-experience.md](superpowers/plans/2026-11-04-cu-codex-experience.md)
- 技术方案：[2026-11-04-cu-codex-experience-technical-design.md](2026-11-04-cu-codex-experience-technical-design.md)
- 复查：[second-review.md](reviews/second-review.md)
- 验收记录（含逐项通过/失败/未测与实测数字）：[codex-experience-acceptance.md](reviews/codex-experience-acceptance.md)

本报告只陈述**已实现且有证据**的部分；凡本机环境无法可靠验证的，一律在验收文档标「未测」，不写成绩。

## 规模

相对基线 `8e1f6ce`：50 个文件、+6236 / −565。新增原生单元 `AXIdentity.swift` / `AXSessionWorker.swift` / `PreviewController.swift` / `PreviewCapture.swift` / `VisualFeedback.swift`，以及 JS `lib/action-events.mjs` / `lib/preview-deadline.mjs` 和 12 个原生测试、6 个 JS 测试。

## 按任务

| 任务 | 状态 | 主要改动 | 证据 |
|---|---|---|---|
| 1 目标整体解析 + schema（F1/F8） | 完成 | `resolveTargetArgs` 原子化；引擎 `resolveTargetPair` 拒绝 pid/window 不一致；snapshot/expect pid 可省 | `test/target_resolution.mjs`；demo 不匹配→`target_mismatch` 且计数不变 |
| 2 预览链共享 deadline（F3/F7） | 完成 | `createPreviewDeadline`；排队/出队/fallback/附件/发布全链预算；`sessionGeneration` | `test/preview_budget.mjs` RED→GREEN |
| 3 状态/停止独立通路（F2） | 完成（核心） | 读取/分类移出动作队列；有界读并发 8；控制队列；pause 闸门 + `cleanupState`；子进程取消 | `service_responsiveness.py`：status 2310→24ms |
| 4 统一动作事件 + native 流（M1） | 完成 | `action-events.mjs`（Spec §5.2、去重+seq、NDJSON）；`exec(...,{eventsVersion,onEvent})`；`--events-v1` 原生阶段事件 | `test/action_events.mjs`、`action_event_stream.py` |
| 5 常驻可打断多屏动画（M1/F6） | 完成 | rim 持久+默认关；latest-wins 调度≤64；Reduce-Motion 拆除；字素标签；per-display 面板；`CursorLayerView` 迁出 | `visual_event_view.py`、`aura_view.py`、真实 `cursor-overlay` 冒烟 |
| 6 基准纠正 + 呈现测量（F5） | 完成 | `bench/results.mjs`（null≠0、计数必须变化、唯一 token、非零退出）；`visual-latency.mjs` 三时分离 | `test/benchmark_results.mjs`；`codex-experience-bench.json` |
| 7 原生观看预览（M2） | 核心完成 | `PreviewController`/`PreviewCapture`（SCStream 首帧预算+降级）、可见 `AVSampleBufferDisplayLayer` 卡片、visible/stop+隐藏暂停、静态帧回退、120ms 淡入、并入 cursor helper | `preview_stream/panel/control/static/card_anim`、`helper_preview_control` |
| 8 真实控件身份（M3/F4） | 核心完成 | `AXIdentity` 契约、按 token 派发、retained worker、常驻 `ax-worker`、JS `snapshot.elementTokens`+`click(ref)` 路由、`verify-before-type`、目标绑定重启、在途取消 | `ax_identity/dispatch_resolution/worker/worker_resident`、`ax_wiring`、`inflight_cancel` |
| 9 宿主集成/录像 | 部分 | build.sh 从根可跑；全量回归；诚实验收文档；实测基线；构建身份核对 | 见验收文档 §1/§5/§6/§7 |

## 测试总览（最终一轮全绿）

- `npm test` → **115/115**
- `bash engine/tests/run_all.sh --quick` → exit 0（各子集 0 failed）
- `bash engine/build.sh`（仓库根）→ 通过
- 15 个原生测试脚本全部 exit 0：service/event/preview 系列/visual/aura/ax/geometry/card/identity/dispatch/helper-preview

## 未完成 / 未测（需真机或宿主，本机无法代跑）

1. 重装安装产物（当前安装的是旧构建，见验收文档 §6）——涉签名/TCC，未自动执行。
2. Task 7 目标切换交叉淡化（现有架构每目标独立预览进程，跨进程不可淡化；属架构改动）与 30 分钟长跑资源。
3. Task 8 AXObserver 通知失效（正确性由派发前即时校验保证，通知只是优化）。
4. Task 9 真实 DSH 宿主 + 大模型端到端任务、30–60 s 演示录像、30 分钟资源曲线。

## 合并/续跑建议

先重装再在真实会话跑「开始→定位→点击→输入→等待→验证→停止」并录像，按计划 §10 固定任务集填「通过/失败/未测」。在此之前，本分支在本机开发目录的所有自动化项已全绿。
