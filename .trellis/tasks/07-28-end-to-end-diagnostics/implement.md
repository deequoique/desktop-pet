# 端到端诊断系统实施计划

## Gate 0：确认产品边界

- 固化“本机自动留证、用户主动导出、绝不后台上传”的产品边界。
- 冻结 envelope、errorCode 命名、禁止字段、保留策略和 UI 严重度。
- 各子任务在自己的 PRD/design 中写明依赖。

## Phase 1：客户端诊断地基

执行 `07-28-client-crash-diagnostics`：交付 envelope、renderer→main 安全 IPC、breadcrumbs、incident manager、异常/crash 本地留证、统一诊断包 export handler、设置页独立诊断区块，以及只在控制面板打开后出现的持久 crash 提示。这是 WebRTC 专项诊断的前置依赖。

## Phase 2：服务端可观测性

执行 `07-28-server-observability`：交付 JSON logger、HTTP/Socket/call/TTS/storage 生命周期、信令聚合、进程异常和 PM2 日志运维。

## Phase 3：WebRTC 专项

执行 `07-28-diagnose-ipv4-webrtc-p2p`：交付 candidate、state、candidate pair、STUN error 和 selected route UI，并以 `callId` 对齐三端。

## Phase 4：跨层故障演练

至少演练 server 不可达/鉴权失败、renderer 异常与 crash、媒体权限拒绝、IPv6 P2P/IPv4 direct 失败/TURN 回退、server handler 异常、诊断目录不可写和日志轮转。

每个案例验证 UI code/action、client incident、server event、关联 ID、脱敏和保留边界。

## Quality Gate

```bash
npm test --prefix server
npm test --prefix pet
npm run build:web
npm run build:pet
```

另做 Electron 打包版本的 crash/restart 手工验收；开发模式不能替代 native crash artifact 验收。

## Rollback Points

- 客户端 IPC 与 incident manager 独立提交。
- server logger 替换和业务事件接入分开提交。
- WebRTC 观测与 ICE 行为分开提交。
- 任何阶段不得把诊断故障提升为产品 fatal。
