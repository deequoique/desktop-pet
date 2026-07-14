# 跨层思考指南

> **目的**：实现前先追踪 `server/`、`web/`、`pet/` 之间的完整数据流、归属和清理路径。

## 先画出实际数据流

本项目常见的数据流如下：

```text
控制命令：React UI → web/src/api.ts → server Socket.IO → 远端 pet renderer
房间状态：server room state → room:peers → 当前参与者的 controller/pet
WebRTC：controller/pet SDP+ICE → server relay → 远端 peer；媒体通过 RTCPeerConnection 点对点传输
TTS 控制：controller → server queue/job → tts:play → pet → tts:status → controller
TTS 音频：provider → server HTTP stream → pet HTMLAudioElement
Electron IPC：renderer → preload bridge → Electron main → OS/文件系统
```

开始实现前明确：

- 原始输入从哪里进入？
- 哪一层负责校验和规范化？
- server 如何从已认证状态推导目标？
- 成功、拒绝、超时、断线分别如何反馈？
- 哪些资源必须在结束时释放？
- Electron 与独立浏览器模式是否有不同路径？

## 边界检查

| 边界 | 当前契约 | 常见遗漏 |
| --- | --- | --- |
| React ↔ `web/src/api.ts` | typed wrapper、listener、Promise/boolean 结果 | UI 直接操作 socket；错误码未转成 UI 文案 |
| controller/pet ↔ server | Socket.IO event、ack、`socket.data` 身份 | 信任客户端目标；漏掉 role/room/call/job 校验 |
| server ↔ provider | ElevenLabs HTTP stream 或 CosyVoice WebSocket | 破坏统一 TTS job/queue/status 路径 |
| WebRTC peer ↔ peer | SDP、ICE、call ID、media track | ICE 过早加入；过期 call 未丢弃；track 未停止 |
| renderer ↔ Electron main | preload 暴露的 IPC bridge | 漏改 preload/type/fallback；renderer 直接使用 Node |
| TypeScript ↔ 生成 JS | `web/src/*.ts(x)` 由 `tsc -b` 生成同名 JS | 手改生成文件或未运行 build |

## Socket.IO 变更清单

新增事件或字段时：

- [ ] server handler 校验发送方 role 和 joined room。
- [ ] 目标从 `socket.data` 与 room state 推导，不接受客户端 socket ID。
- [ ] request/reply 使用 acknowledgement，并定义稳定错误码和超时。
- [ ] fire-and-forget 的非法输入安全返回，不产生副作用。
- [ ] 更新 `web/src/api.ts` 的 type、wrapper 和 listener。
- [ ] 更新 `pet/src/renderer/main.ts` 的 type、handler 或 ack responder。
- [ ] 若影响 room/call/routing，不变量已加入 `server/test/rooms.test.js`。

## WebRTC 变更清单

- [ ] server 只转发信令，不承载媒体。
- [ ] signal 带 call ID，并拒绝过期 call。
- [ ] `remoteDescription` 之前收到的 ICE candidate 被暂存。
- [ ] offer/answer 和 candidate 的处理在 controller/pet 两端保持兼容。
- [ ] teardown 关闭 peer connection，停止本地 track，清空 stream、candidate 和 call ID。
- [ ] disconnect、hangup、call end、track end、connection failure 都能进入清理路径。

## TTS 变更清单

- [ ] controller 输入在 server 校验 text 长度、voice 授权、queue 深度、rate limit 和目标在线状态。
- [ ] BYOK key 只存在于 controller socket；不进入 job、日志或明文持久化。
- [ ] job URL 一次性、不可猜测、会过期，并设置 `no-store`。
- [ ] provider 差异留在上游 adapter，继续复用统一 job、queue 和 status。
- [ ] pet 回报 `playing`、`completed` 或受控 `error`。
- [ ] 断线、过期、上游失败或播放失败都会结束 job 并继续/清空 queue。

## Electron IPC 变更清单

- [ ] OS/文件系统能力只在 `pet/src/main/index.js`。
- [ ] main handler 使用与交互语义匹配的 `ipcMain.on` 或 `ipcMain.handle`。
- [ ] 对应 preload 只暴露必要参数和返回值。
- [ ] renderer 的 `Window` TypeScript 声明同步更新。
- [ ] 适用时更新 `browserPetBridge` fallback。
- [ ] 保持 `contextIsolation: true`、`nodeIntegration: false`。

## 状态和资源归属

不要让同一个状态在多个层分别推导出不同真相：

- room/call/job 权威状态在 server。
- 可视 UI 状态在 React `App`。
- `RTCPeerConnection`、`MediaStream` 和 DOM media resource 保存在对应 renderer 的 ref/module state。
- 配对与 secure credential 的持久化由 Electron main 负责。
- 独立浏览器只保存非敏感本地偏好。

## 完成后验证

- [ ] 正常路径和拒绝路径都有验证。
- [ ] 不会向自己或其他房间泄漏事件。
- [ ] 超时、断线和重连行为保持一致。
- [ ] Electron 内置 controller 与独立浏览器差异已考虑。
- [ ] 所有 listener、timer、track、stream、audio 和 peer connection 都有清理路径。
- [ ] 所有本地契约副本已同步。

运行：

```bash
npm test --prefix server
npm run build:web
npm run build:pet
```
