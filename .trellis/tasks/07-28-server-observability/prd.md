# 服务端结构化日志与运行诊断

## Goal

让服务端日志能够安全、结构化地复盘连接、鉴权、通话、WebRTC 信令、TTS、持久化和进程故障，并在 PM2 环境中有明确轮转和保留策略。

## Dependency

依赖父任务 `07-28-end-to-end-diagnostics` 冻结事件 envelope、错误码命名和禁止字段。本子任务不增加客户端 incident 上传 endpoint 或远程诊断文件存储。

## Requirements

- 实现带 `debug/info/warn/error/fatal`、domain、event、errorCode、instance/runtime session 和 correlation 的 JSONL logger。
- 启动日志记录应用版本、Node 版本、PID、instance ID 和无秘密的配置指纹；RTC 只记录 STUN/TURN 数量、policy、realm 是否设置。
- HTTP 请求记录 request ID、归一化 route、status 和 duration，不记录 secret、TTS job URL 参数或请求正文。
- Socket 记录 connection、join/reject、replace、disconnect reason、transport 和脱敏后的 room/device reference。
- call 记录 start/end、participants reference、reason、duration。
- WebRTC 信令只记录/汇总 description/candidate 类型、方向、forwarded/rejected 和原因，不记录 SDP/candidate 全文。
- TTS、note、storage 使用稳定 errorCode 和异常序列化；不记录用户文本、媒体或便签内容。
- 捕获 `uncaughtException`、`unhandledRejection`、HTTP server error/clientError 和 Socket.IO engine error，并遵守安全退出策略。
- 高频拒绝与信令事件限频或在 call end 聚合。
- 提供受版本控制的 PM2 启动、日志轮转、保留和诊断提取说明；stdout/stderr 单文件 20 MB、保留 7 代并压缩。

## Acceptance Criteria

- [ ] 每行日志为可解析 JSON，并包含父任务要求的基础 envelope。
- [ ] 一次通话可按 `callId` 得到 start、信令汇总、end/duration。
- [ ] stale call、wrong role、no target 等静默 return 变为带原因的受控诊断，但不泄露 payload。
- [ ] server handler/process 异常包含 errorCode、stack 和 correlation。
- [ ] 压测式 candidate 输入不会产生无界日志。
- [ ] PM2 日志达到 20 MB 后轮转，最多保留 7 代并压缩。
- [ ] server 测试通过，敏感内容测试证明禁止字段不落盘。

## Out of Scope

- 外部日志 SaaS、指标数据库和 pager 告警。
- 保存完整 SDP、ICE candidate、TTS 文本、便签或媒体。
- 改变现有 Socket.IO 业务协议和通话行为。

## Notes

- 当前主要证据：`server/src/index.js:614-1272` 的 Socket handlers 大多静默 return；`server/src/index.js:1290-1293` 仅有启动摘要。
