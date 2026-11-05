# 2026-11-05 录屏问题修复

## 改动

- 显式 resume 在原生服务确认成功后才清除暂停并打开本地输入闸门；恢复失败、取消或会话代际变化时不打开闸门。
- cu_launch 将启动/激活失败传播到顶层，并终止后续激活及预览步骤，保留 outcomeUnknown/actionReplaySafe。
- 已取得但尚未开始原生动作的会话控制权不能被另一聊天抢占。
- cu_status.plugin 与启动日志记录模块加载时的版本、路径、PID、时间和 index.mjs + core.mjs 内容指纹。该指纹不是整个安装包的校验值。
- README 补充源码更新后的 DSH 重载诊断。

## 验证

新增 6 项回归测试，先观察失败，再修复至通过。完整 npm test 最终结果：219 passed，0 failed，0 skipped。

中间一轮完整测试的 live CU service roundtrip 曾出现 Node 内部 setTypeOfService EINVAL；未改业务代码掩盖该错误，后续完整重跑通过。该运行时错误的根因未确认。

独立临时状态目录原生验证通过：插件管理器自行启动打包 helper；带认证的 frontmost 只读请求成功；本地闸门关闭后通过真实 cu_session resume 恢复，再次只读请求成功；dispose 后等待到所创建 helper 的 exit 事件。未打印 token，未使用外部常驻服务代替插件启动。

DSH desktop profile 的插件链接指向本仓库。Computer Use 拒绝访问 DeepSeek Harness，因此本轮没有在真实 DSH 界面重载插件，也未完成聊天内完整交互验收。磁盘修复不等同于运行中的 DSH 已加载修复。

## 重载后验收

完成当前任务后完全退出并重新打开 DSH。先调用 cu_status，核对 plugin.entryPath 指向本仓库，plugin.loadedAt 为此次重载时间。没有 plugin 字段说明仍是旧实现。再验证启动目标、停止、显式恢复和下一次操作；不要让模型通过 shell 启动常驻服务绕过故障。

本次没有修改原生二进制、自动发布或提交 Git。cleanupState: unknown 仍保留为未知，未改成虚假的清理成功。
