# 共享产品规范

适用于跨越 `server/`、`web/` 或 `pet/` 的变更，尤其是 Socket.IO 事件、WebRTC 信令、Electron IPC、配对和 TTS。

## 开发前检查清单

- 阅读[系统架构与契约](./system-architecture-and-contracts.md)。
- 修改前，沿每个生产者、中继层和消费者追踪发生变化的 payload 或事件。
- 确认功能属于当前 Electron 产品；`Mate-Engine/` 不在当前 v1 工作流内。

## 质量检查

- 确认跨进程类型或事件名的所有副本已同步更新。
- 保持 server 边界：信令和控制可以经过 server，WebRTC 媒体不能经过 server。
- 修改 Electron bridge 时保留浏览器降级行为。
- 跨层变更必须运行 backend 测试和两个 TypeScript 构建。

## 规范索引

- [系统架构与契约](./system-architecture-and-contracts.md)：运行时职责、端到端数据流、持久化边界和当前不支持的模式。
