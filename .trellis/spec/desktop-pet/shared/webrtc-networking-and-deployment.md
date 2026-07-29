# WebRTC 网络与 TURN 部署契约

## 1. Scope

适用于 `server/`、Electron controller (`web/`) 与 pet renderer (`pet/`) 的双人通话及 coturn。Socket.IO 只承载信令/配置；媒体走 WebRTC P2P 或 coturn，绝不经过 Node server。

## 2. Runtime ownership

- Server 验证房间、call ID和角色，签发 TURN REST 临时凭据。
- Controller 是唯一 ICE restart offerer；一次失败周期最多 restart 一次，等待15秒。
- Pet 采集媒体并根据 selected pair 对 screen sender 应用 normal 或 relay-low profile。
- Controller 对本机 camera sender 应用同样的 route profile；coturn 提供 STUN 与最终受限低清 relay。

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
  quality?: 'normal'|'relay-low';
  qualityLevel?: 1|2|3|4|5;
  reason?: 'controller_disabled'|'capture_failed'|'permission_denied'|
    'device_lost'|'track_ended'|'profile_failed';
};
```

screen/microphone/system-audio status 只能由当前 call 的 pet 发出；camera status 可由当前 call 任一 controller 发出，并由 server 注入真实 source。事件只路由给该媒体的观看 controller。事件名、枚举和类型副本必须同步。

## 5. Route and media invariants

- 每次创建 peer connection 前请求 server config；失败时 host-only，不恢复 Google STUN。
- selected pair 同时兼容 transport `selectedCandidatePairId` 与 nominated/succeeded pair。
- Screen/camera video track 初始禁用或保持 null。只有 selected pair 明确为 normal/relay-low 且对应 sender profile 成功应用后才能启用/attach；unknown/failed 不能发送。
- relay-low screen 固定不超过 640×360、5fps、240 kbit/s；每路 camera 固定不超过 320×180、10fps、120 kbit/s。scale 按采集尺寸等比计算且不得放大小源。
- P2P 恢复 normal profile，撤销 relay bitrate/framerate cap 并恢复 scale 1；route 切换不得重新捕获或改变用户 desired。
- 同一 sender 的 profile mutation 必须串行执行，并在执行前后检查 route generation；只做异步结果 guard 不够，因为过期的 `setParameters()` 仍可能覆盖最新硬上限。
- relay profile `setParameters()` 失败时对应视频 fail closed 并上报 `profile_failed`，麦克风/系统声音继续。
- 屏幕拒绝或 track ended 只上报媒体状态，不能结束可用的音频连接。
- disconnected/failed 时 pet 不 hangup；controller restart一次，恢复清 timer并重新判路，15秒超时后才结束 call。
- call ID过滤、candidate 暂存与集中幂等 teardown 必须保留。
- camera 使用独立 controller↔controller peer connection；每端 controller 独占自己的 camera track，同一 track 同时供本地预览和自己的远端 sender。

## 6. Deployment contract

自动化入口为 `server/deploy/install-coturn-ubuntu.sh`，支持 `--preflight|--dry-run|--install|--verify|--rollback` 配合 `--config`。目标为 Ubuntu 24.04/systemd/apt/UFW。配置文件必须 mode 600；脚本不得修改云防火墙。

最小公网端口：UDP/TCP 3478、UDP 49160-49200，可选 TCP 5349。不得默认开放完整动态端口范围。操作细节只维护在 `docs/ubuntu-coturn-deployment.md`。

## 7. Verification and examples

跨层改动必须运行 server tests、web build、pet build和 `bash -n`。手工矩阵至少覆盖 LAN、IPv6 P2P、IPv4打洞、强制 relay、15秒内恢复、恢复超时、屏幕拒绝和屏幕结束。

错误：客户端硬编码公共 STUN；route 未确认就启用视频；任何 disconnected 立即 `call:end`；把 shared secret 发给客户端；部署脚本静默开放云安全组。

正确：server 短期签发、host-only 降级、relay-low 硬上限、profile 失败时单视频 fail closed、一次 ICE restart，以及外部 allocation/带宽验收。

## 8. Scenario: call-scoped screen authority and bidirectional camera

### 1. Scope / Trigger

- Trigger：修改通话媒体开关、摄像头信令、摄像头采集、统一媒体视图或系统浮窗时。
- 屏幕共享的开关权属于观看端 controller；pet 只执行，不能提供本地停止入口。摄像头是 controller↔controller 双向媒体，每端只能开关和采集自己的摄像头。

### 2. Signatures

```ts
type CallStart = {
  callId:string;
  peerDeviceId:string;
  cameraOffererDeviceId:string;
  cameraSenderDeviceId:string; // 过渡兼容字段，新逻辑不得用于限制发送方
};
type MediaControl = { callId:string; media:'screen'; enabled:boolean };
type CameraSignal = {
  callId:string;
  description?:RTCSessionDescriptionInit|null;
  candidate?:RTCIceCandidateInit|null;
};
type CameraStatus = {
  callId:string;
  media:'camera';
  state:'available'|'paused'|'unavailable';
  quality?:'normal'|'relay-low';
  reason?:'controller_disabled'|'capture_failed'|'permission_denied'|
    'device_lost'|'track_ended'|'profile_failed';
  sourceDeviceId?:string; // server 转发时从已认证 socket 注入
};

socket.emit('webrtc:media-control', control, ack);
socket.emit('webrtc:camera-signal', signal);
socket.emit('webrtc:media-status', cameraStatus);
```

Call initiator 是固定 camera offerer，创建一个 `sendrecv` video transceiver 并保存 sender。Answerer 在 `setRemoteDescription(offer)` 后把对应 transceiver 设为 `sendrecv` 并保存 sender。双方开启都使用自己的 `replaceTrack(track)`；关闭必须先 `replaceTrack(null)` 再 `track.stop()`。

### 3. Contracts

- `call:start.cameraOffererDeviceId` 固定为 call initiator。过渡期保留 `cameraSenderDeviceId = targetDeviceId`，但新客户端只把它用于推导旧 server 的 offerer，不能据此禁止任一方发送。
- `webrtc:camera-signal` 只在当前 call 的两个 controller 之间双向路由。双方各自保存 sender、local desired/status、local stream；remote status/stream 必须独立保存。
- 任一 call controller 都可上报自己的 camera status。server 忽略客户端伪造的 `sourceDeviceId`，以 `socket.data.participantId` 覆盖后只发给另一 controller。
- `webrtc:media-control` 只接受 screen。旧客户端发送 camera control 时返回 `invalid_media` 且不得转发；camera UI 直接调用本地采集状态转换。
- camera 默认关闭。权限拒绝、设备丢失、camera ICE 失败或协议不兼容只能关闭/暂停 camera path，不能 teardown 主屏幕/音频通话。
- React Socket listener effect 的 cleanup 只执行 `setListeners({})`；整通话 teardown 只属于挂断、call end/error 和组件卸载。依赖变化导致 listener 重绑时不得停止 tracks 或关闭 peer connections。
- 所有跨 `await` 的主通话和 camera 初始化/信令 continuation 都要用 `callId` 与当前 PC identity 做 generation guard。并发 offer/candidate 初始化必须复用同一个 in-flight camera PC Promise。
- pet 保存 `screenRequestedByController`，实际 enabled 必须为 desired、route profile 明确且 sender profile 应用成功三者同时成立。
- Electron 浮窗只允许 `about:blank` + frame name `media-float`，可自由调整宽高、置顶、持久化并 clamp bounds；不得调用 `setAspectRatio` 锁定比例，原生关闭只返回控制面板，不结束 call。
- 系统浮窗是纯媒体画布：portal/detached 状态不得挂载 `.media-controls`、surface label、状态或占位内容；屏幕/摄像头主画面铺满 client area，视频统一 `object-fit: contain` 以完整显示且不裁切。所有操作只留在嵌入式控制面板，并使用一致的紧凑按钮尺寸。
- 摄像头/麦克风权限只允许 pet/control app webContents；macOS 包必须声明 camera、microphone 与 Continuity Camera usage。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| 未加入、错误/过期 call ID | `not_in_call` 或静默丢弃 fire-and-forget signal/status |
| media/`enabled` 非法 | `invalid_media` |
| 任一 controller 尝试通过 media-control 远控 camera | `invalid_media`，不转发 |
| 目标 endpoint 离线 | `peer_unavailable` |
| 非 call device、错误 role、其他 room | 不转发任何 signal/control/status |
| camera permission denied/device lost | `unavailable/permission_denied` 或 `unavailable/device_lost`，原 call 保持 |
| selected pair 为 relay | 成功应用固定 relay-low 参数后发送并上报 `available/relay-low` |
| relay-low 参数缺少尺寸或 `setParameters()` 失败 | 对应视频 null/disabled，`unavailable/profile_failed`，音频保持 |

### 5. Good/Base/Bad Cases

- Good：A 发起后 A、B 分别打开自己的 camera；两端各采集一次、显示本地预览并向对端发送，同一按钮只释放本机硬件。系统浮窗只显示远端媒体。
- Base：双方 camera 默认 off、screen on；关闭浮窗后媒体视图回嵌入页，call 和 tracks 不重建。camera 单侧失败时另一方向及主音频保持。
- Bad：listener effect 因 camera state 变化执行 teardown；A 的按钮远程打开 B 的摄像头；双方同时 create offer 产生 glare；客户端伪造 camera status source；只隐藏 preview DOM 却不释放硬件。

### 6. Tests Required

- Server integration：断言 screen control 只到配对 pet；camera signal/status 双向到另一 controller；status source 不能伪造；camera control 双方均为 `invalid_media`；wrong role、stale call、非 call device和其他 room 无泄漏。
- Web source/runtime：断言 offerer/answerer 均为 `sendrecv`、双方保存 sender、camera 开关只调用本地转换；listener cleanup 不调用 teardown；async continuation 有 call generation guard。
- Pet/Web build：TypeScript 通过，生成 `web/src/*.js` 与 TS 同步；teardown 停止双方本地 tracks、关闭两个 PC、清 in-flight init/candidate 与 DOM `srcObject`。
- Electron test/package：断言 window allowlist、topmost/resizable/bounds persistence、无 aspect-ratio lock、preload listener cleanup；检查成品 Info.plist 三个 camera/microphone key。
- Renderer source regression：断言 float portal 不挂载 controls/label/placeholder，主 surface 填满 client area，视频为 `object-fit: contain`，嵌入式按钮采用统一紧凑尺寸。
- 双机手工：A/B 分别发起；双方按不同顺序及同时开启 camera；任一方关闭、设备切换/热拔插/拒权不影响另一方向与主通话；屏幕远停/恢复、TURN relay-low 上限与恢复、浮窗移动/缩放/关闭。

### 7. Wrong vs Correct

#### Wrong

```ts
return () => {
  setListeners({});
  teardownCall(); // state change rebinds listeners and destroys the active call
};
requestMediaControl({ callId, media: 'camera', enabled: true }); // controls peer hardware
pc.addTransceiver('video', { direction: 'recvonly' }); // preserves one-way camera
screenTrack.enabled = true; // selected route is still unknown/relay
```

#### Correct

```ts
return () => setListeners({});
useEffect(() => () => teardownCall(), [teardownCall]); // unmount ownership
const transceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
cameraSenderRef.current = transceiver.sender;
await cameraSender.replaceTrack(null);
cameraTrack.stop();
const applied = await applyVideoSenderProfile(screenSender, screenTrack, routeProfile, 'screen');
screenTrack.enabled = screenRequestedByController && applied.ok;
const controls = !floatContainer && <div className="media-controls">...</div>;
// .media-float-root .media-surface.primary { inset: 0 }
// video { object-fit: contain }
```

## 9. Scenario: effective relay and five-tier adaptive video

### 1. Scope / Trigger

- Trigger：修改 candidate-pair 判路、RTC stats、屏幕/摄像头 sender profile、实时网络 UI、`MediaStatus` 档位或 coturn 公私网映射时。
- NAT 后的 coturn allocation 可能在 Chromium stats 中表现为 `candidateType=prflx`；路径真相必须综合 candidate 类型、TURN 属性、配置地址和 relay alias，不能只看 selected candidate 的类型。

### 2. Signatures

```ts
type VideoQualityLevel = 1|2|3|4|5;
type RtcNetworkSample = {
  selectedPair?: {
    effectiveRelayed: boolean;
    currentRoundTripTime?: number;
    availableOutgoingBitrate?: number;
  };
  outboundVideo?: RtcOutboundRtpSummary;
  remoteInboundVideo?: RtcInboundRtpSummary;
  inboundVideo?: RtcInboundRtpSummary;
};

collectRtcNetworkSample(
  pc: RTCPeerConnection,
  configuration?: RTCConfiguration,
  baseline?: RateBaseline,
): Promise<RtcNetworkSample>;

recommendVideoQualityLevel(
  metrics: AdaptiveVideoMetrics,
  kind: 'screen'|'camera',
): VideoQualityLevel;

applyVideoSenderProfile(
  sender: RTCRtpSender,
  track: MediaStreamTrack,
  route: 'normal'|'relay-low',
  kind: 'screen'|'camera',
  level: VideoQualityLevel,
): Promise<{ok:true; level:VideoQualityLevel}|{ok:false; reason:string}>;
```

### 3. Contracts

- Effective relay 为以下任一条件成立：candidate 是 `relay`；存在 `relayProtocol`；candidate address 命中 `RTC_TURN_URLS` host；selected `prflx` 与同一 report 中的 relay candidate 共享 port 和 username fragment。
- screen 档位 1→5 分别为 `640×360/5/240k`、`854×480/7/450k`、`1280×720/10/900k`、`1600×900/12/1.5m`、`2560×1440/15/3.5m`。
- camera 档位 1→5 分别为 `320×180/10/120k`、`480×270/12/240k`、`640×360/15/500k`、`960×540/20/900k`、`1280×720/24/1.5m`。
- 每 2 秒读取 compact selected pair/RTP stats。严重恶化或档位 1 立即下降；普通恶化连续 2 次下降；连续稳定 6 次才逐档上升。effective relay 始终锁定 1 档。
- `webrtc:media-status.qualityLevel` 是可选整数 1..5。server 仅校验并转发当前 call 的合法来源；旧 `quality` 字段继续兼容。
- coturn 在公网 IP 不等于私网 IP 时必须配置精确的 `external-ip=<PUBLIC_IP>/<PRIVATE_IP>`，同时固定 `relay-ip` 与 relay 端口范围。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| `qualityLevel` 非整数或不在 1..5 | server 丢弃该可选字段，其他合法 status 可继续转发 |
| selected `prflx` 命中 TURN host/relay alias | UI 和 sender 一律按 TURN、1 档处理 |
| selected pair unknown/failed | 对应视频 fail closed，音频保持 |
| stats 暂缺 RTT/带宽/RTP | 使用已有指标保守判级，不抛错、不结束 call |
| `setParameters()` 失败 | null/disable 对应视频并上报 `profile_failed` |
| coturn 缺少/错误 external-ip、relay-ip 或端口范围 | `install-coturn-ubuntu.sh --verify` 非零退出 |

### 5. Good/Base/Bad Cases

- Good：真实 IPv4 P2P 显示公网两端地址，网络稳定后每约 12 秒最多升一档；拥堵时快速下降且不重捕获。
- Base：TURN 或 NAT 后伪 `prflx` 始终显示 TURN/1档，声音连续，UI 每约 2 秒更新 RTT、接收码率与帧率。
- Bad：只以 `candidateType !== relay` 宣称 P2P；在一次高延迟 TURN 上发送 1440p；每次档位变化都 stop/reacquire track；把周期 stats 发到 server。

### 6. Tests Required

- 纯函数：五档参数、比例不放大、严重/连续降档、六次稳定逐档升级、TURN 锁 1 档。
- RTC stats：覆盖 `relayProtocol`、TURN host、同 port+ufrag alias、delta bitrate/loss、selected pair 与最多 8 个 alternatives。
- Server integration：合法 `qualityLevel` 定向转发，非法值、伪造 source、过期 call 与错误 role 不泄漏。
- 构建/部署：server/pet tests、web/pet build、两份 profile/diagnostics 镜像一致、`bash -n` 与 coturn verify 现场检查。
- 双机：真实 IPv4 P2P、IPv6 P2P、强制 relay、网络切换和“一开始流畅后卡顿”复现路径。

### 7. Wrong vs Correct

#### Wrong

```ts
const relayed = selectedCandidate.candidateType === 'relay';
await sender.replaceTrack(null); // every quality transition
await sender.setParameters({ encodings: [{ maxBitrate: 3_500_000 }] }); // TURN
```

#### Correct

```ts
const relayed = isEffectiveRelayCandidate(selectedCandidate, allCandidates, configuration);
const next = controller.update(sample, mediaKind);
await applyVideoSenderProfile(sender, track, relayed ? 'relay-low' : 'normal', mediaKind, next.level);
```
