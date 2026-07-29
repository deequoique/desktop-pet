# 客户端错误分级与崩溃诊断

## Goal

让 Electron 主进程、桌宠 renderer 和控制面板 renderer 的异常及崩溃自动留证、正确分级，并向用户提供稳定错误码和可执行恢复动作。

## Dependency

依赖父任务 `07-28-end-to-end-diagnostics` 冻结 envelope、errorCode、禁止字段和保留策略。本子任务必须先交付安全的 renderer→main 诊断通道，WebRTC 子任务才能接入。incident 只自动保存在本机，只有用户主动操作才导出。

## Requirements

- 扩展现有 JSONL 诊断而非另起互不兼容的日志系统。
- renderer 注册同步异常、未处理 Promise 和 React ErrorBoundary；关键业务 catch 使用稳定错误分类。
- main 进程补齐 renderer gone、unresponsive、load failure、child process gone、uncaught/unhandled 和 clean-shutdown marker。
- 自动维护有界 breadcrumbs，并在 `error/fatal` 或 crash 时冻结 incident snapshot。
- native/renderer crash 的本地 artifact/metadata 在下次启动可发现、关联和导出。
- incident 指纹合并重复错误，记录 first/last/count，防止错误风暴。
- client JSONL 使用 2 MB × 4 代边界；incident 最多 10 个、每个最多 200 条 breadcrumbs；crash 索引最多 5 个。
- renderer IPC 严格校验 sender、事件类型、深度、字符串/数组和总字节数。
- 导出包增加 schemaVersion、incident、breadcrumbs 与 crash metadata；继续多层脱敏。
- 导出动作显示保存对话框，并在操作前说明诊断包包含网络地址元数据、不包含密钥或媒体内容。
- 设置页新增独立“诊断与故障”区块；设置按钮、托盘快捷入口和 crash banner 复用同一 main-process 导出 handler。
- UI 根据 `recoverability` 展示非阻塞降级、可重试错误、需要权限/配置操作或崩溃恢复提示。
- 上次 crash/fatal 不得触发启动弹窗或强制显示控制面板；用户下次主动打开控制面板时显示持久提示，直到导出或忽略。
- 诊断写入失败不得再次触发无限异常，也不得阻断应用启动或通话。

## Acceptance Criteria

- [ ] pet/control renderer 的同步异常、Promise 拒绝和 React render error 均进入本地 incident。
- [ ] renderer crash 在 main 记录原因，重启后 incident 仍存在。
- [ ] main-process 异常以最小同步事件留证。
- [ ] 最近 breadcrumbs 能解释故障前的启动、Socket、通话和媒体状态。
- [ ] 用户看到稳定错误码和恢复动作，普通 warn 不制造弹窗风暴。
- [ ] crash 重启保持原有桌宠启动行为；控制面板打开后才出现可导出/忽略的持久提示。
- [ ] 导出包不含 secret、credential、媒体/便签/TTS 内容或完整 SDP。
- [ ] 导出成功后向用户显示文件位置；用户取消保存不产生 error incident。
- [ ] 三个导出入口的文件内容、提示和脱敏结果一致。
- [ ] 日志、incident、breadcrumbs 和 crash 索引达到上述边界后会轮转、裁剪或淘汰。
- [ ] IPC 伪造 source、超长 payload 和禁止字段测试通过。
- [ ] `npm test --prefix pet`、web build 和 pet build 通过。

## Out of Scope

- 任何后台上传、远程诊断 API 或第三方遥测。
- 自动截屏、录音或收集用户文档。
- 在本任务中修复捕获到的所有业务错误。

## Notes

- 当前 main 已有部分 crash hooks，但 renderer 没有持久化异常入口；现有手工导出只包含 snapshot 与普通 JSONL。
