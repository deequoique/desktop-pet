# Technical Design

## Overview

保留现有 controller↔pet WebRTC 连接负责屏幕、麦克风和系统声音；新增一条独立的、单向 controller↔controller 摄像头连接。发送端控制面板拥有唯一 camera `MediaStreamTrack`，同一条 track 同时用于本地预览和远端发送。控制端的嵌入式媒体视图通过 React portal 移入同源 Electron 子窗口，实现系统级浮窗而不复制 `MediaStream`。

这一任务不拆子任务：摄像头信令、媒体状态、统一媒体视图和 Electron 浮窗需要共享同一个 call ID、清理路径和端到端验收矩阵，独立交付会留下不可用的中间协议状态。

## Runtime Ownership

| State / resource | Authority and owner |
| --- | --- |
| room、call ID、通话两台设备、call initiator/target | `server/src/index.js` |
| 屏幕、麦克风、系统声音采集与发送 | 现有 `pet/src/renderer/main.ts` |
| 屏幕期望开关 | 远端 controller 发起；pet 保存并执行，实际状态由 pet 回报 |
| camera track、设备选择、本地预览、camera peer connection | 摄像头发送端 `web/src/App.tsx` |
| 远端 screen/camera stream、主次布局、浮窗/嵌入状态 | 观看端 `web/src/App.tsx` |
| 浮窗 BrowserWindow、bounds 持久化、workArea clamp、置顶 | `pet/src/main/index.js` |
| renderer 可访问的浮窗 native 操作 | `pet/src/main/control-preload.js` 窄 bridge |

## Call Roles and Media Direction

- `call:start` 在现有 `callId`、`peerDeviceId` 之外同步 `cameraSenderDeviceId`。当前 call 的 target device 是单向摄像头发送端，initiator device 是摄像头观看端。
- 现有屏幕/语音连接和 ICE recovery 不改方向、不合并 peer connection，降低对已上线链路的回归风险。
- 摄像头使用独立 `RTCPeerConnection`：观看端建立 `recvonly` video transceiver 并作为固定 offerer；发送端 answer 后持有带空 track 的 `RTCRtpSender`。首次开启摄像头时使用 `replaceTrack(cameraTrack)`，关闭时先 `replaceTrack(null)` 再 `track.stop()`，无需为每次开关重新协商。
- camera connection 继续通过 server 获取相同的 RTC config，并保留 call ID 过滤、ICE candidate 暂存、一次 ICE restart 和集中 teardown。

## Socket.IO Contracts

### `webrtc:camera-signal`

```ts
type CameraSignal = {
  callId: string;
  description?: RTCSessionDescriptionInit | null;
  candidate?: RTCIceCandidateInit | null;
};
```

- 只允许当前 call 两台设备的 controller endpoint 使用。
- server 从已认证 participant 和 `room.call` 推导另一 controller；不接受客户端 socket ID，不广播到 room。
- 过期或缺失 call ID 静默拒绝。

### `webrtc:media-control`

```ts
type MediaControl = {
  callId: string;
  media: 'screen' | 'camera';
  enabled: boolean;
};
```

- `screen`：controller 只能控制当前 call 中与自己配对的远端 pet；server 转发到该 pet。pet 不暴露本地屏幕开关。
- `camera`：只有 camera viewer controller 可远程控制 camera sender controller；camera sender 的本地 UI 调用同一套本地状态转换，不经过远端授权。
- API wrapper 使用 acknowledgement 返回 `ok` 或稳定错误码（`not_in_call`, `invalid_media`, `peer_unavailable`, `not_allowed`）；ack 只表示命令已合法转发，实际结果以后续 media status 为准。

### `webrtc:media-status`

```ts
type MediaStatus = {
  callId: string;
  media: 'screen' | 'camera' | 'microphone' | 'system-audio';
  state: 'available' | 'paused' | 'unavailable';
  reason?:
    | 'relay_audio_only'
    | 'controller_disabled'
    | 'capture_failed'
    | 'permission_denied'
    | 'device_lost'
    | 'track_ended';
};
```

- screen/microphone/system-audio 仍只接受 pet 上报；camera 只接受当前 `cameraSenderDeviceId` 的 controller 上报。
- server 按 media 和 sender role 校验后只路由给对应观看 controller。
- UI 的开关使用 pending 状态，直到收到实际 media status，不把本地点击直接当成成功。

## Screen Control State

- pet 保存 `screenRequestedByController`，默认 `true`。
- 实际 `screenTrack.enabled = screenRequestedByController && routeIsConfirmedP2P`。
- 控制端停止共享时保留 screen capture stream 但禁用发送，便于控制端快速恢复；桌宠端不提供对应 UI。
- relay、用户控制、capture failure 分别上报明确 reason。P2P 恢复时只在 `screenRequestedByController === true` 时重新启用。
- call end、退出软件或 track ended 仍进入现有集中清理路径并停止采集。

## Camera Capture and Local Preview

- 摄像头采集只发生在 camera sender 的 Electron control renderer，避免跨 renderer 复制媒体或在 pet/control 两处重复打开同一硬件。
- 首次开启调用 `getUserMedia({ video: { deviceId, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 24 } }, audio: false })`。摄像头音频不采集，通话继续复用现有麦克风轨。
- 同一 `MediaStream` 绑定本地预览 `<video muted playsInline>`，其 video track 通过 camera peer sender 发送。
- `enumerateDevices()` 驱动设备下拉；设备标签在授权前不可用时显示中性名称。选择写入本机 localStorage。`devicechange` 后若已选设备消失，则停止旧 track、选择系统默认设备、重新采集并提示。
- 收起预览仅改变 DOM 可见性。双方任一关闭操作都执行 `replaceTrack(null)`、`track.stop()`、清空 preview `srcObject` 并回报 unavailable/controller_disabled。
- Electron main 同时配置 `setPermissionCheckHandler` 与 `setPermissionRequestHandler`，仅允许已知本地 pet/control 主页面请求 `media` 权限；未知 origin 拒绝。当前包尚未声明 macOS 媒体用途文本，因此通过 `mac.extendInfo` 同时补充 `NSCameraUsageDescription` 与 `NSMicrophoneUsageDescription`。

## TURN and Recovery

- camera peer connection 也检查 selected candidate pair。relay 被选中时 sender 保持 camera RTP sender 为 null，不持续发送视频；如果用户期望 camera 开启，可以保留本地预览并上报 `paused/relay_audio_only`。
- P2P 恢复后，若期望 camera 仍开启且本地 track 存活，则重新 `replaceTrack(track)` 并上报 available。
- screen 继续执行现有 relay audio-only 规则。camera 连接失败不得结束原有 screen/audio call；仅 camera 降级并提示。

## Unified Media View

- 抽出局部 `MediaStage` 展示组件，但不引入 router、全局 store 或组件库。
- screen 和 camera 分别使用独立 `<video>` 与 stream ref。默认 screen 为主、camera 为右下角 inset；`cameraHidden` 与 `preferredPrimary` 是 React state。
- screen 不可用而 camera available 时，计算出的 effective primary 自动变为 camera；screen 恢复后继续使用 `preferredPrimary`。
- 主次交换只改变布局，不改变 track 或发送状态。视频统一使用 `object-fit: contain`，允许任意窗口比例而不拉伸。
- 嵌入页与浮窗共用同一个 `MediaStage` 实例：浮窗开启时通过 `createPortal` 渲染到 child document，关闭后渲染回控制面板。

## Native Floating Window

- control renderer 调用 `window.open('about:blank', 'media-float', ...)`。Electron 官方说明同源子窗口与父窗口在同一进程，父页面可直接访问子页面，适合 React portal。
- `controlWin.webContents.setWindowOpenHandler()` 只允许 frame name 为 `media-float` 且 URL 为 `about:blank` 的请求；其他新窗口拒绝。override options 保持 `contextIsolation: true`, `nodeIntegration: false`，并设置 `alwaysOnTop`, `resizable`, `skipTaskbar`, `minWidth`, `minHeight`。
- 主进程通过 `did-create-window` 保存 `mediaFloatWin`，绑定 move/resize/closed/unresponsive/render-process-gone。默认 480×270 DIP，最小 320×180 DIP，初始位于当前工作区右下角。
- bounds 存入 `pet-state.json` 的独立 `mediaFloatBounds` 字段。创建和 display metrics changed 时复用 `clampBoundsToWorkArea`；读取实际 bounds 后持久化，避免 DPI/平台修正后状态分叉。
- 浮窗关闭时主进程通知 control renderer、显示并聚焦控制面板；React portal 卸载并把媒体视图恢复到嵌入位置，通话资源不变。
- 独立浏览器 fallback 不显示系统浮窗入口，嵌入媒体视图继续可用。

## Compatibility and Rollback

- server/client 协议副本必须同版本发布；旧客户端不理解 camera 事件时仍应保持原 screen/audio 通话，不把 camera 初始化失败升级为 call failure。
- camera 使用独立 peer connection，失败或临时回滚时可整体禁用 camera path，不修改已稳定的 screen/audio peer connection。
- 浮窗失败时回退到嵌入媒体视图；窗口创建错误不结束通话。
- Electron 28 的同源 `window.open`、`setWindowOpenHandler`、BrowserWindow bounds/resizable/always-on-top 能力已有官方文档支持；实现阶段需在项目锁定版本上做双平台手工验证。

## Technical References

- Electron renderer-created windows: https://www.electronjs.org/docs/latest/api/window-open
- Electron BrowserWindow bounds/resizable/always-on-top: https://www.electronjs.org/docs/latest/api/browser-window
- Electron media permission handling: https://www.electronjs.org/docs/latest/api/session
- electron-builder macOS Info.plist customization: https://www.electron.build/mac/
- WebRTC sender/track behavior: https://www.w3.org/TR/webrtc/
