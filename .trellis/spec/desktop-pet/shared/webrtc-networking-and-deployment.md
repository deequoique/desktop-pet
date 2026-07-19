# WebRTC 网络与 TURN 部署契约

## 1. Scope

适用于 `server/`、Electron controller (`web/`) 与 pet renderer (`pet/`) 的双人通话及 coturn。Socket.IO 只承载信令/配置；媒体走 WebRTC P2P 或 coturn，绝不经过 Node server。

## 2. Runtime ownership

- Server 验证房间、call ID和角色，签发 TURN REST 临时凭据。
- Controller 是唯一 ICE restart offerer；一次失败周期最多 restart 一次，等待15秒。
- Pet 采集媒体并根据 selected pair 决定是否启用 screen track。
- coturn 提供 STUN 与最终 relay；relay 只保证音频。

## 3. Configuration contract

Server 环境变量为 `RTC_STUN_URLS`、`RTC_TURN_URLS`、`RTC_TURN_SHARED_SECRET`、`RTC_TURN_REALM`、`RTC_TURN_CREDENTIAL_TTL_SEC` 和 `RTC_ICE_TRANSPORT_POLICY`。URL 用英文逗号分隔。生产 policy 为 `all`；`relay` 只用于验收。日志不得输出 shared secret 或临时 credential。

coturn `static-auth-secret` 必须和 server secret 相同。用户名是 `<expiryUnixSeconds>:<participantId>`，credential 是 `Base64(HMAC-SHA1(secret, username))`，默认 TTL 12小时。

## 4. Cross-layer events

```ts
socket.emit('webrtc:get-config', ack)
// { ok:true, iceServers:RTCIceServer[], iceTransportPolicy:'all'|'relay', expiresAt?:number }
// { ok:false, code:'not_joined' }

type MediaStatus = {
  callId: string;
  media: 'screen'|'camera'|'microphone'|'system-audio';
  state: 'available'|'paused'|'unavailable';
  reason?: 'relay_audio_only'|'controller_disabled'|'capture_failed'|
    'permission_denied'|'device_lost'|'track_ended';
};
```

screen/microphone/system-audio status 只能由当前 call 的 pet 发出；camera status 只能由 `cameraSenderDeviceId` 对应 controller 发出。事件只路由给该媒体的观看 controller。事件名、枚举和类型副本必须同步。

## 5. Route and media invariants

- 每次创建 peer connection 前请求 server config；失败时 host-only，不恢复 Google STUN。
- selected pair 同时兼容 transport `selectedCandidatePairId` 与 nominated/succeeded pair。
- Screen track 初始禁用。只有明确判定非 relay 后启用；unknown 不能启用。
- relay 时 screen 保持禁用并上报 `paused/relay_audio_only`，麦克风继续。
- 屏幕拒绝或 track ended 只上报媒体状态，不能结束可用的音频连接。
- disconnected/failed 时 pet 不 hangup；controller restart一次，恢复清 timer并重新判路，15秒超时后才结束 call。
- call ID过滤、candidate 暂存与集中幂等 teardown 必须保留。
- camera 使用独立 controller↔controller peer connection；发送端 controller 独占 camera track，同一 track 同时供本地预览和远端 sender。
- camera 和 screen 均不得通过 relay 发送；camera 选中 relay 时 sender 保持 null track，本地预览可以继续。

## 6. Deployment contract

自动化入口为 `server/deploy/install-coturn-ubuntu.sh`，支持 `--preflight|--dry-run|--install|--verify|--rollback` 配合 `--config`。目标为 Ubuntu 24.04/systemd/apt/UFW。配置文件必须 mode 600；脚本不得修改云防火墙。

最小公网端口：UDP/TCP 3478、UDP 49160-49200，可选 TCP 5349。不得默认开放完整动态端口范围。操作细节只维护在 `docs/ubuntu-coturn-deployment.md`。

## 7. Verification and examples

跨层改动必须运行 server tests、web build、pet build和 `bash -n`。手工矩阵至少覆盖 LAN、IPv6 P2P、IPv4打洞、强制 relay、15秒内恢复、恢复超时、屏幕拒绝和屏幕结束。

错误：客户端硬编码公共 STUN；route 未确认就启用视频；任何 disconnected 立即 `call:end`；把 shared secret 发给客户端；部署脚本静默开放云安全组。

正确：server 短期签发、host-only 降级、relay audio-only、非致命屏幕状态、一次 ICE restart，以及外部 allocation/带宽验收。

## 8. Scenario: call-scoped screen authority and one-way camera

### 1. Scope / Trigger

- Trigger：修改通话媒体开关、摄像头信令、摄像头采集、统一媒体视图或系统浮窗时。
- 屏幕共享的开关权只属于观看端 controller；pet 只执行，不能提供本地停止入口。摄像头是单向 sender→viewer 媒体，但 sender 和 viewer 双方都可开关。

### 2. Signatures

```ts
type CallStart = { callId:string; peerDeviceId:string; cameraSenderDeviceId:string };
type MediaControl = { callId:string; media:'screen'|'camera'; enabled:boolean };
type CameraSignal = {
  callId:string;
  description?:RTCSessionDescriptionInit|null;
  candidate?:RTCIceCandidateInit|null;
};

socket.emit('webrtc:media-control', control, ack);
socket.emit('webrtc:camera-signal', signal);
```

Camera viewer 是固定 offerer，创建 `recvonly` video transceiver；camera sender answer 后保存对应 `RTCRtpSender`，开启使用 `replaceTrack(track)`，关闭必须先 `replaceTrack(null)` 再 `track.stop()`。

### 3. Contracts

- `call:start` 的 target device 是 `cameraSenderDeviceId`，initiator 是 camera viewer。
- `screen` control 从任一 call controller 路由到另一 call device 的 pet；`camera` control 只允许 initiator controller 路由到 target controller。
- sender 本地 camera UI 调用相同本地状态转换，不通过 server 请求自身授权。
- pet 保存 `screenRequestedByController`，实际 enabled 必须为 `screenRequestedByController && routeIsConfirmedP2P`。
- Electron 浮窗只允许 `about:blank` + frame name `media-float`，可调整大小、置顶、持久化并 clamp bounds；原生关闭只返回控制面板，不结束 call。
- 摄像头/麦克风权限只允许 pet/control app webContents；macOS 包必须声明 camera、microphone 与 Continuity Camera usage。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| 未加入、错误/过期 call ID | `not_in_call` 或静默丢弃 fire-and-forget signal/status |
| media/`enabled` 非法 | `invalid_media` |
| camera sender 尝试远控 camera | `not_allowed` |
| 目标 endpoint 离线 | `peer_unavailable` |
| 非 call device、错误 role、其他 room | 不转发任何 signal/control/status |
| camera permission denied/device lost | `unavailable/permission_denied` 或 `unavailable/device_lost`，原 call 保持 |
| selected pair 为 relay | screen/camera null或disabled，`paused/relay_audio_only`，音频保持 |

### 5. Good/Base/Bad Cases

- Good：viewer 开 camera，sender 只采集一次并显示本地预览，P2P 确认后同一 track 发送；任一方关闭后硬件灯熄灭。
- Base：camera off、screen on；关闭浮窗后媒体视图回嵌入页，call 和 tracks 不重建。
- Bad：pet 暴露屏幕停止按钮；客户端传 socket ID；camera 合并进稳定的 screen/audio PC；relay route 未确认就 attach video；只隐藏 preview DOM 却不释放 camera。

### 6. Tests Required

- Server integration：断言 screen control 只到配对 pet，camera control/signal 只到指定 sender controller，camera status 只到 viewer；wrong role、stale call、非 call device 无泄漏。
- Pet/Web build：TypeScript 通过，生成 `web/src/*.js` 与 TS 同步；teardown 停止 tracks、关闭两个 PC、清 candidate 与 DOM `srcObject`。
- Electron test/package：断言 window allowlist、topmost/resizable/bounds persistence、preload listener cleanup；检查成品 Info.plist 三个 camera/microphone key。
- 双机手工：双方 camera 开关、设备切换/热拔插、屏幕远停/恢复、TURN audio-only、浮窗移动/缩放/关闭/显示器变化。

### 7. Wrong vs Correct

#### Wrong

```ts
cameraVideo.hidden = true; // hardware and RTP keep running
screenTrack.enabled = true; // selected route is still unknown/relay
```

#### Correct

```ts
await cameraSender.replaceTrack(null);
cameraTrack.stop();
screenTrack.enabled = screenRequestedByController && routeIsConfirmedP2P;
```
