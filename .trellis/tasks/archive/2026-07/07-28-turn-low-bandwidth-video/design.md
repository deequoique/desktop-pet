# TURN 低带宽视频技术设计

## 1. Video Profiles

使用固定两档，不引入 simulcast：

| Profile | Screen | Camera | Audio |
| --- | --- | --- | --- |
| `normal` | 现有捕获尺寸/15fps，保留正常发送参数 | 720p ideal、15–24fps | 保留现有约 64 kbit/s/sender 上限 |
| `relay-low` | 640×360、5fps、240 kbit/s | 320×180、10fps、120 kbit/s/路 | 优先，不因视频开启提高上限 |

`maxBitrate` 单位使用 bit/s；coturn `max-bps`/`bps-capacity` 文档明确为 bytes/s，验收时统一换算。

## 2. Sender Profile Helper

在共享或同构 helper 中实现 best-effort `applyVideoSenderProfile(sender, track, profile, kind)`：

- 复用现有 `sender.getParameters().encodings`，不改变 encoding 数量或 RID。
- `relay-low` 设置 `maxBitrate`、`maxFramerate` 和 `scaleResolutionDownBy`。
- Scale 根据 `track.getSettings().width/height` 与目标边界计算，保持比例且不放大低于目标的源。
- `normal` 恢复 scale 1、normal frame rate，并移除/恢复 low bitrate cap。
- 所有参数先裁剪到有效范围，`setParameters()` 失败返回结构化结果，不抛进信令控制流。

Screen 与 camera 在不同 renderer，helper 契约保持一致；实现可分别落在 pet renderer 与 web controller，避免跨 bundle 新增复杂共享包。

## 3. Screen Route State

Pet 保存 screen `RTCRtpSender`，把 `screenRouteIsP2P` 替换为明确 profile：`unknown | normal | relay-low | failed`。

连接建立或 ICE 恢复后读取 selected pair：

- `normal`：按 `screenRequestedByController` 启用 track并恢复 normal parameters。
- `relay-low`：先成功应用 low parameters，再启用 track并上报 available/low。
- `unknown/failed`：禁用 video，保留 audio并提示。

用户 screen toggle 仍只改变 desired；profile transition 与 desired 合并计算实际发送状态。

## 4. Camera Route State

Camera child 提供双向 sender、local desired 与 local track。Controller 使用同一 profile 状态：

- `normal`：local desired 为 true 时 attach track并应用 normal。
- `relay-low`：先应用 camera low parameters，再 attach/保持 track。
- `unknown/failed`：`replaceTrack(null)`，保留本地 preview 与 desired。

任一方的 profile 只管理自己的 outbound sender；remote status 只用于展示。

## 5. Status Contract

扩展 media status：

```ts
type MediaQuality = 'normal' | 'relay-low';

type MediaStatus = {
  callId: string;
  media: 'screen' | 'camera' | 'microphone' | 'system-audio';
  state: 'available' | 'paused' | 'unavailable';
  quality?: MediaQuality;
  reason?: string;
};
```

Relay 可用视频上报 `state:'available', quality:'relay-low'`。只有用户关闭、捕获/参数失败或连接失败才使用 paused/unavailable。Server allowlist `quality` 并按现有角色路由。

## 6. Verification and Capacity

强制 `RTC_ICE_TRANSPORT_POLICY=relay` 后，至少持续 10 分钟同时开启：

- 双向 screen；
- 双向 microphone/system audio；
- 双向 camera。

客户端采集 outbound/inbound RTP stats；服务器采集 coturn allocation 与网卡吞吐。验收关注实际 bitrate、frame size/fps、packet loss、RTT、audio concealment 与是否触发 coturn 限流。

若当前配额不足，先降低视频 profile；只有达到用户认可的最低可用画质仍不足时，才有证据地调整 `max-bps`/`bps-capacity`。

## 7. Rollback and Failure

- Feature-level rollback：relay route 恢复为 video disabled/audio-only。
- Profile helper 失败：单个视频 sender fail closed，其他媒体不受影响。
- P2P profile 不依赖 TURN 文档或配额变化。
