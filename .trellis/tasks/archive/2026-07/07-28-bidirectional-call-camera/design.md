# 双向通话与双向摄像头技术设计

## 1. Architecture

保留两类独立媒体连接：

1. 主通话：现有 controller→peer pet 的两条对称 PeerConnection，承载远端屏幕、麦克风和系统声音。
2. 摄像头：两个 controller 之间的一条双向 PeerConnection，承载 A→B 与 B→A 两个方向的摄像头视频。

Camera connection 由 call initiator 固定担任 offerer，避免 glare。Offerer 创建一个 `sendrecv` video transceiver；answerer 接受同一 transceiver。双方各自保存 transceiver.sender，并通过 `replaceTrack(localCameraTrack | null)` 独立开关，无需在普通摄像头开关时 renegotiate。

## 2. Lifecycle Fix

- API listener effect cleanup 只调用 `setListeners({})`。
- `teardownCall()` 由独立 unmount cleanup 与显式终止路径持有。
- Listener handler 读取 `currentCallIdRef`、`selfDeviceIdRef`、`cameraOffererDeviceIdRef` 等同步 ref，不依赖会导致破坏性重注册的 React state closure。
- `beginMediaCall(callId)`、`beginCameraCall(callId)` 和 signal handler 在跨 `await` 后检查 call generation；不匹配时关闭临时资源并停止继续发送。

## 3. Call and Signal Contracts

`call:start` 增加 `cameraOffererDeviceId`，值为 `call.initiatorDeviceId`。过渡期保留 `cameraSenderDeviceId` 字段供旧客户端使用；新客户端不再用它决定唯一 sender。

`webrtc:camera-signal` 继续在当前 call 的两个 controller 间定向路由，payload 仍以 `callId` 过滤。固定 offerer 只发 offer/处理 answer，answerer 只处理 offer/发 answer；普通 track 开关不发新 SDP。

Camera status 改为双方对称：

```ts
type CameraStatus = {
  callId: string;
  media: 'camera';
  sourceDeviceId: string;
  state: 'available' | 'paused' | 'unavailable';
  reason?: 'relay_audio_only' | 'controller_disabled' | 'capture_failed'
    | 'permission_denied' | 'device_lost' | 'track_ended';
};
```

Server 不信任客户端提供的 `sourceDeviceId`，而是从已认证 socket 写入/覆盖该字段，再只发送给 call 的另一个 controller。

`webrtc:media-control` 收窄为仅允许 `media: 'screen'`。Camera 开关完全在本机执行，远端 controller 没有开启、关闭或切换对方摄像头的协议能力；旧版 `media: 'camera'` 请求返回稳定拒绝码且不转发。

## 4. Camera State Model

拆分现有混合状态：

- `localCameraDesired` / ref
- `localCameraStatus`
- `remoteCameraStatus`
- `localCameraStreamRef`
- `remoteCameraStreamRef`
- `cameraSenderRef`
- `cameraRouteKnownRef` / `cameraRouteIsP2PRef`

双方 UI 只以本机状态控制本地采集，以远端 status/ontrack 表达对方摄像头。远端 status 不能覆盖本地 desired，也不能触发 `getUserMedia()` 或 `replaceTrack()`。

## 5. Capture and Track Flow

开启本机摄像头：

1. 获取选定设备的 video-only stream。
2. 绑定本地 muted preview。
3. 如果 camera route 已确认可发送，`cameraSender.replaceTrack(track)`。
4. 上报本地实际状态。

关闭本机摄像头：

1. `replaceTrack(null)`。
2. 停止本地 stream 的所有 track。
3. 清空 preview `srcObject`。
4. 上报 `unavailable/controller_disabled`。

设备切换只替换本地 track，不影响远端发送方向。对方 track ended/muted 只更新 remote camera UI，不停止本机摄像头。

## 6. Media UI

- 两端均显示本地 camera preview card、设备选择和“我的摄像头”开关。
- MediaStage 的 camera surface 永远表示对方摄像头；继续支持远端屏幕/摄像头主次交换、隐藏和自动顶替。
- 系统浮窗继续 portal 同一个远端 MediaStage，不包含本地 preview。
- 提示文案必须区分本地权限/设备错误与对方关闭/失败。

## 7. TURN and Recovery

本任务建立可被 route profile 管理的双向 camera sender，并保持 route 检测与 desired state 分离。兄弟任务 `.trellis/tasks/07-28-turn-low-bandwidth-video/` 负责把 relay 从 `replaceTrack(null)` 改为受限低清 track、设置编码参数并在 P2P 恢复后恢复正常 profile。

Camera ICE failure 独立恢复或降级，不调用主通话 `endCall`。本地 track 在 camera PC 重建后按 desired 重新 attach。

## 8. Compatibility and Rollback

- Server 过渡期同时发 `cameraOffererDeviceId` 和旧 `cameraSenderDeviceId`。
- 新 server 对双方 camera status 的接收不会破坏旧客户端的唯一 sender 行为。
- 新客户端遇到缺少 `cameraOffererDeviceId` 的旧 server 时回退到现有单向模式并给出升级提示，不猜测 offerer 导致 glare。
- 双向 camera path 可整体关闭并回退到主屏幕/音频，不修改主 PeerConnection。

## 9. Risks

- Listener cleanup 与 teardown 分离后可能发生卸载泄漏：用独立 unmount cleanup 和资源清理测试覆盖。
- 双方同时开关 track 造成 state 串线：本地和远端状态完全分离，server 从 socket 注入 source。
- 旧客户端仍发送远程 camera control：server 明确拒绝，绝不为了兼容而静默开启目标硬件。
- 旧异步协商污染新 call：所有继续步骤使用 call generation guard。
- 双向视频带宽增加：默认摄像头关闭；P2P 保留现有 720p ideal、15–24 fps 上限，TURN 的低清硬上限由兄弟任务独立定义和验收。
