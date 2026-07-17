# 前端开发规范

适用于 `web/` 的 React 控制面板、`pet/src/main/` 的 Electron main/preload 代码，以及 `pet/src/renderer/` 的命令式桌宠 renderer。

## 开发前检查清单

- 阅读[前端与 Electron 模式](./frontend-and-electron-patterns.md)。
- 涉及 Socket.IO、WebRTC、配对、TTS 或 IPC 时，同时阅读共享架构索引。
- 先确定变更由哪个运行时负责：React 控制 UI、Electron main/preload，或 pet renderer。

## 质量检查

- web 的 socket 操作必须经过 `web/src/api.ts`；OS 能力必须经过 preload bridge。
- listener、timer、track、stream 和 peer connection 必须在创建它们的同一生命周期中清理。
- Electron 内置 controller 是产品目标；独立浏览器 fallback 只作开发调试兼容，不为其新增产品功能。
- 运行 `npm run build:web` 和 `npm run build:pet`。

## 规范索引

- [前端与 Electron 模式](./frontend-and-electron-patterns.md)：源码布局、React 状态与 effect、renderer 风格、IPC、类型、CSS 和构建约定。
