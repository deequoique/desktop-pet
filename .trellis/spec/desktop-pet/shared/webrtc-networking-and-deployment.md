# WebRTC 网络与 TURN 部署契约

## 1. Scope

适用于 `server/`、Electron controller (`web/`) 与 pet renderer (`pet/`) 的双人通话、coturn 与可选 TRTC 主媒体。Socket.IO 只承载信令/配置；媒体走 WebRTC P2P、coturn 或 TRTC，绝不经过 Node server。

## 2. Runtime ownership

- Server 验证房间、call ID和角色，签发 TURN REST 临时凭据。
- Controller 是唯一 ICE restart offerer；一次失败周期最多 restart 一次，等待15秒。
- Pet 采集媒体并根据 selected pair 对 screen sender 应用 P2P 七状态或 TURN 三状态 profile。
- Controller 只在 camera 自身 selected pair 明确为P2P时发送camera；camera走TURN时detach并停止采集。coturn提供STUN与有硬上限的screen relay。

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
    'device_lost'|'track_ended'|'profile_failed'|'relay_disabled';
};
```

screen/microphone/system-audio status 只能由当前 call 的 pet 发出；camera status 可由当前 call 任一 controller 发出，并由 server 注入真实 source。事件只路由给该媒体的观看 controller。事件名、枚举和类型副本必须同步。

## 5. Route and media invariants

- 每次创建 peer connection 前请求 server config；失败时 host-only，不恢复 Google STUN。
- selected pair 同时兼容 transport `selectedCandidatePairId` 与 nominated/succeeded pair。
- Screen/camera video track 初始禁用或保持 null。Screen只有selected pair明确且对应sender profile成功应用后才能启用；camera还必须自身selected pair为P2P。unknown/failed不能发送。
- TURN screen使用独立状态`480p30/600k → 720p30/1.25m → 720p45/1.875m`，绝不进入1080p；scale按采集尺寸等比计算且不得放大小源。
- Camera selected pair为effective relay时必须`replaceTrack(null)`、停止本地capture、清空preview、复位用户desired并上报`unavailable/relay_disabled`。恢复P2P只提示手动重开，不得自动采集。
- P2P恢复normal screen profile；route切换不得重新捕获screen或改变screen desired。Camera因TURN停止后的手动恢复是明确例外。
- 同一 sender 的 profile mutation 必须串行执行，并在执行前后检查 route generation；只做异步结果 guard 不够，因为过期的 `setParameters()` 仍可能覆盖最新硬上限。
- relay profile `setParameters()` 失败时对应视频 fail closed 并上报 `profile_failed`，麦克风/系统声音继续。
- 屏幕拒绝或 track ended 只上报媒体状态，不能结束可用的音频连接。
- disconnected/failed 时 pet 不 hangup；controller restart一次，恢复清 timer并重新判路，15秒超时后才结束 call。
- call ID过滤、candidate 暂存与集中幂等 teardown 必须保留。
- camera 使用独立 controller↔controller peer connection；每端 controller 独占自己的 camera track，同一 track 同时供本地预览和自己的远端 sender。
- Camera transport不得随主PC自动预热；只有任一方明确发送`cameraDesired:true`后才能创建。双方都为false时立即释放camera PC、ICE/TURN状态与相关异步初始化。Camera失败不得teardown主通话。

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
  cameraDesired?:boolean;
};
type CameraStatus = {
  callId:string;
  media:'camera';
  state:'available'|'paused'|'unavailable';
  quality?:'normal'|'relay-low';
  reason?:'controller_disabled'|'capture_failed'|'permission_denied'|
    'device_lost'|'track_ended'|'profile_failed'|'relay_disabled';
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
- camera自身走TURN时必须完全停止发送与采集并复位desired；后续恢复P2P只解除UI阻塞，不自动打开硬件。
- camera transport按需创建：本机明确打开时先发送`cameraDesired:true`；远端收到后也进入按需初始化。固定offerer只创建一次offer，answerer等待并响应，任一方先打开都不能造成glare或永久等待。
- 本机关闭时先`replaceTrack(null)`并停止capture，再发送`cameraDesired:false`。每端分别保存本机与远端desired；两者都为false时立即关闭camera PC、清空sender/candidate/remote stream/诊断和异步初始化，不保留重开宽限期。再次打开必须重新请求RTC config并建链。
- description/candidate只有在本机或远端至少一方desired时才处理，防止关闭后的迟到candidate或旧版预热信令重新创建camera PC。异步RTC config返回还必须检查call ID与camera transport generation，销毁后的continuation不得复活连接。
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
| camera selected pair 为 relay | detach sender、停止capture、复位desired并上报`unavailable/relay_disabled` |
| camera relay 后恢复P2P | 只提示用户可手动重开，不自动`getUserMedia()` |
| camera P2P参数缺少尺寸或`setParameters()`失败 | 对应video null/disabled，`unavailable/profile_failed`，主通话保持 |
| 双方从未打开camera | 不创建camera PC，不请求RTC config，不产生camera ICE/TURN流量 |
| 双方先后或同时发送`cameraDesired:false` | 每端在观察到本机和远端均为false后立即销毁camera transport |
| camera transport销毁后迟到candidate/RTC config返回 | 丢弃，不重新创建PC；下一次明确打开重新开始 |

### 5. Good/Base/Bad Cases

- Good：A 发起后由A或B任一方先打开camera；双方按desired信令建立同一个固定offerer连接，各自只采集自己的camera。最后一个开启方关闭后，两端立即释放camera transport。
- Base：双方 camera 默认off、screen on，整个通话期间不存在camera PC/ICE/TURN；关闭浮窗后媒体视图回嵌入页，主call和tracks不重建。camera未available时不挂载空surface，screen自动成为主画面。
- Bad：主PC连通后自动预热camera；关闭后保留宽限期；迟到candidate复活PC；listener effect 因 camera state 变化执行整通话teardown；双方同时 create offer产生glare。

### 6. Tests Required

- Server integration：断言 screen control 只到配对 pet；camera signal/status 双向到另一 controller；status source 不能伪造；camera control 双方均为 `invalid_media`；wrong role、stale call、非 call device和其他 room 无泄漏。
- Web source/runtime：断言没有camera prewarm effect；`cameraDesired`意图双向转发；任一方先打开都由固定offerer协商；offerer/answerer均为`sendrecv`并保存sender；双方false立即关闭PC并清空资源；迟到candidate/RTC config受desired与transport generation guard拦截；listener cleanup不调用整通话teardown。
- Pet/Web build：TypeScript 通过，生成 `web/src/*.js` 与 TS 同步；teardown 停止双方本地 tracks、关闭两个 PC、清 in-flight init/candidate 与 DOM `srcObject`。
- Electron test/package：断言 window allowlist、topmost/resizable/bounds persistence、无 aspect-ratio lock、preload listener cleanup；检查成品 Info.plist 三个 camera/microphone key。
- Renderer source regression：断言 float portal 不挂载 controls/label/placeholder，主 surface 填满 client area，视频为 `object-fit: contain`，嵌入式按钮采用统一紧凑尺寸。
- 双机手工：A/B分别发起；双方按不同顺序及同时开启camera；任一方关闭、设备切换/热拔插/拒权不影响另一方向与主通话；camera TURN自动关闭与P2P手动恢复；screen TURN三状态与P2P恢复；浮窗移动/缩放/关闭。

### 7. Wrong vs Correct

#### Wrong

```ts
return () => {
  setListeners({});
  teardownCall(); // state change rebinds listeners and destroys the active call
};
useEffect(() => void beginCameraCall(callId), [rtcRoute]); // cameras off时也预热并占用ICE/TURN
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
sendCameraSignal({ callId, cameraDesired: true });
await cameraSender.replaceTrack(null);
cameraTrack.stop();
sendCameraSignal({ callId, cameraDesired: false });
if (!remoteCameraDesiredRef.current) teardownCameraTransport('both-cameras-disabled');
const applied = await applyVideoSenderProfile(screenSender, screenTrack, routeProfile, 'screen');
screenTrack.enabled = screenRequestedByController && applied.ok;
const controls = !floatContainer && <div className="media-controls">...</div>;
// .media-float-root .media-surface.primary { inset: 0 }
// video { object-fit: contain }
```

## 9. Scenario: effective relay and dual-axis adaptive video

### 1. Scope / Trigger

- Trigger：修改 candidate-pair 判路、RTC stats、屏幕/摄像头 sender profile、实时网络 UI、`MediaStatus` 档位或 coturn 公私网映射时。
- NAT 后的 coturn allocation 可能在 Chromium stats 中表现为 `candidateType=prflx`；路径真相必须综合 candidate 类型、TURN 属性、配置地址和 relay alias，不能只看 selected candidate 的类型。

### 2. Signatures

```ts
type VideoQualityLevel = 1|2|3|4|5;
type ScreenAdaptiveState = {
  qualityLevel: VideoQualityLevel;
  frameRateTarget: 30|45|60|90;
};
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

interface AdaptiveScreenQualityController {
  update(
    metrics: AdaptiveVideoMetrics,
    relayed?: boolean,
  ): {
    state: ScreenAdaptiveState;
    healthTargetLevel: VideoQualityLevel;
    bandwidthLevel: VideoQualityLevel;
    changed: boolean;
    reason: string;
  };
}

applyVideoSenderProfile(
  sender: RTCRtpSender,
  track: MediaStreamTrack,
  route: 'normal'|'relay-low',
  kind: 'screen'|'camera',
  level: VideoQualityLevel,
  frameRateTarget?: number,
): Promise<{ok:true; level:VideoQualityLevel}|{ok:false; error:string}>;
```

### 3. Contracts

- Effective relay 为以下任一条件成立：candidate 是 `relay`；存在 `relayProtocol`；candidate address 命中 `RTC_TURN_URLS` host；selected `prflx` 与同一 report 中的 relay candidate 共享 port 和 username fragment。
- P2P screen 使用内部状态 `480p30 → 720p30 → 720p45 → 1080p45 → 1080p60 → 2K60 → 2K90`；`qualityLevel` 仍只表示分辨率，最高2K是2560×1440。
- P2P screen 的60fps码率基线依次为 360p/800k、480p/1.2m、720p/2.5m、1080p/5m、2K/8m；实际 `maxBitrate = base60 × frameRateTarget / 60`。P2P 设置 `degradationPreference='maintain-framerate'`。
- TURN screen不进入P2P状态表，使用`480p30 → 720p30 → 720p45`，对应600k/1.25m/1.875m硬上限；传入更高level/fps也必须clamp到720p45。
- camera 档位 1→5 分别为 `320×180/10/120k`、`480×270/12/240k`、`640×360/15/500k`、`960×540/20/900k`、`1280×720/24/1.5m`。
- 每2秒读取compact selected pair/RTP stats。P2P screen普通状态连续3个健康样本升一级，2K60/2K90连续6个健康样本升一级。TURN的480p30→720p30需3个健康样本，720p30→720p45需6个健康样本。bandwidth软信号有压力时观察窗口加倍，窗口结束仍允许有硬cap的恢复探测。普通拥塞连续2次反向退一级，严重RTT/loss/jitter或连接失败立即回到480p30。
- `availableOutgoingBitrate` 是 Chromium 基于近期发送反馈的估算，不是独立测速。它不得单独降低P2P状态；与 `qualityLimitationReason='bandwidth'` 同时出现时只能延长升级观察，且健康P2P必须保留恢复探测机会。
- `webrtc.quality-changed` 至少记录 `qualityLevel`、screen的`frameRateTarget`、`healthTargetLevel`、`bandwidthLevel`、reason和参与决策的网络指标。
- `webrtc:media-status.qualityLevel` 是可选整数 1..5。server 仅校验并转发当前 call 的合法来源；旧 `quality` 字段继续兼容。
- coturn 在公网 IP 不等于私网 IP 时必须配置精确的 `external-ip=<PUBLIC_IP>/<PRIVATE_IP>`，同时固定 `relay-ip` 与 relay 端口范围。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| `qualityLevel` 非整数或不在 1..5 | server 丢弃该可选字段，其他合法 status 可继续转发 |
| selected `prflx` 命中 TURN host/relay alias | screen进入TURN三状态；camera停止并上报`relay_disabled` |
| 健康P2P但初始 `availableOutgoingBitrate` 偏低 | 不降档；连续健康后执行逐级恢复探测 |
| RTT ≥550ms、loss ≥9%或jitter ≥180ms | P2P/TURN screen立即回到480p30；P2P camera进入1档 |
| selected pair unknown/failed | 对应视频 fail closed，音频保持 |
| stats 暂缺 RTT/带宽/RTP | 使用已有指标保守判级，不抛错、不结束 call |
| `setParameters()` 失败 | null/disable 对应视频并上报 `profile_failed` |
| coturn 缺少/错误 external-ip、relay-ip 或端口范围 | `install-coturn-ubuntu.sh --verify` 非零退出 |

### 5. Good/Base/Bad Cases

- Good：真实 IPv4/IPv6 P2P 从480p30逐级恢复，普通台阶约6秒、高成本2K台阶约12秒；拥堵时沿状态表回退且不重捕获。
- Base：TURN或NAT后伪`prflx`的screen从480p30有限升级且最高720p45；camera关闭；声音连续，UI每约2秒更新RTT、接收码率与帧率。
- Bad：把低 `availableOutgoingBitrate` 当硬容量门造成5fps自锁；只以 `candidateType !== relay` 宣称P2P；在TURN上发送2K；每次状态变化都stop/reacquire track。

### 6. Tests Required

- 纯函数：七个P2P screen状态、三个TURN screen状态、独立fps/scale/bitrate、低估算恢复探测、严重/连续降档、TURN硬封顶、camera relay拒绝与P2P帧率不变。
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
const level = estimateFromAvailableOutgoingBitrate(sample); // hard capacity gate
```

#### Correct

```ts
const relayed = isEffectiveRelayCandidate(selectedCandidate, allCandidates, configuration);
const next = screenController.update(sample, relayed);
await applyVideoSenderProfile(
  sender,
  track,
  relayed ? 'relay-low' : 'normal',
  'screen',
  next.state.qualityLevel,
  next.state.frameRateTarget,
);
```

## 10. Scenario: call-scoped TRTC main media

### 1. Scope / Trigger

- Trigger：修改 `TRTC_MEDIA_MODE`、UserSig、TRTC Electron preload、主屏幕/系统声音媒体层或 WebRTC 回滚路径时。
- TRTC 只替代主屏幕与音频媒体；Socket.IO call、摄像头按需 WebRTC、房间和控制信令保持原权威边界。

### 2. Signatures

```ts
type CallStart = {
  callId:string;
  mediaMode?:'webrtc'|'trtc'; // 旧 server 缺失时立即按 webrtc
  peerDeviceId:string;
  cameraOffererDeviceId:string;
};
type TrtcConfig = {
  ok:true;
  mode:'trtc';
  sdkAppId:number;
  roomId:number;
  userId:string;
  userSig:string;
  expiresAt:number;
  publishScreen:boolean;
  remoteUserId:string;
  videoProfile:'720p30'|'1080p30';
};
socket.emit('trtc:get-config', { callId }, ack);
socket.emit('trtc:media-status', mediaStatus);
```

Server 环境变量：`TRTC_MEDIA_MODE=webrtc|trtc`、`TRTC_SDK_APP_ID`、`TRTC_SECRET_KEY`、`TRTC_USER_SIG_TTL_SEC`（300–3600，默认900）和 `TRTC_VIDEO_PROFILE=720p30|1080p30`。

### 3. Contracts

- Server 只有在 mode 为 `trtc` 且 app ID/SecretKey 完整时，才在 `call:start.mediaMode` 宣告 `trtc`；否则宣告 `webrtc`。客户端不得各自静默选择不同媒体层。
- 旧 server 不提供 `mediaMode` 时客户端立即走 WebRTC，不能先等待未知的 `trtc:get-config` 超时。
- UserSig 使用 `HMAC-SHA256` 和 zlib `deflate` 的 TLS Sig 2.0 格式。SecretKey 只在 server 环境变量与签名调用栈中出现；客户端、ack 之外的日志、诊断、task和Git不得包含它。
- TRTC roomId 和 userId 从当前 call/device 单向派生。`trtc:get-config` 只允许当前 call 的 controller；签名短时有效，call end 后即使尚未过期也不再由业务接受新配置请求。
- 一次通话只由 target device 的内置 control 发布主屏幕辅流与系统声音，initiator control 订阅。每台设备一个 TRTC 身份，pet renderer 不重复进房，避免重复计费和系统声音回路。
- Native SDK 固定在 control preload 中，通过窄函数桥接给 renderer。Control BrowserWindow 必须保持 `contextIsolation:true`、`nodeIntegration:false`；因 native addon 无法在 sandbox preload 中 `require`，仅该 preload 显式 `sandbox:false`。
- `trtc-electron-sdk` 必须精确锁版，`app.asar.unpacked` 必须包含 `.node`、`liteav.dll`、`liteav_screen.dll`、`live_kit_engine.dll`、`txffmpeg.dll`、`txsoundtouch.dll` 和 media server。
- 720p30 使用1800kbps，1080p30使用4000kbps；不得在弱网时降到30fps以下。系统声音 loopback 为核心媒体；麦克风默认采集音量0，用户明确开启后才设为100。
- TRTC teardown 必须停止屏幕、系统 loopback、本地音频、远端 view并退出房间；camera teardown仍由独立 WebRTC 生命周期负责。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| mode=trtc 但 app ID/SecretKey 缺失 | `call:start.mediaMode=webrtc`，不签发 UserSig |
| 非 controller、未加入或错误/过期 call | `not_joined` / `not_in_call` / `not_allowed` |
| SDK 未打包或 preload 加载失败 | 本次 call 显示受控 TRTC 错误；不得单端静默回退 |
| UserSig userId 超过32字节、TTL越界 | server 签名 helper 拒绝 |
| TRTC 进房返回负 elapsed | call 进入 error，记录无凭证诊断 |
| 系统声音 loopback 失败 | 上报 capture failure，画面/错误状态可独立观察 |
| target 以外 controller 伪造 TRTC screen status | server 丢弃，不向观看端泄漏 |
| call end/socket disconnect | 两端退出TRTC并释放所有native capture/view资源 |

### 5. Good/Base/Bad Cases

- Good：新加坡 initiator 调用中国 target；两端收到同一TRTC room，只有中国 control 发布720p30/1080p30和系统声音，新加坡显示辅流、RTT/丢包/FPS，camera仍按需P2P。
- Base：Server默认 `webrtc` 或旧 server 无 `mediaMode`，客户端立即保持原主PC行为；TRTC SDK不创建房间和计费。
- Bad：SecretKey放进preload；pet/control各进一次房；双方分别判断失败并一端TRTC一端WebRTC；为了加载SDK开启renderer `nodeIntegration`；只检查asar而漏打包DLL。

### 6. Tests Required

- UserSig unit：固定时间解压字段、重算HMAC、拒绝非法输入，并与腾讯官方 generator 的解码JSON一致。
- Server integration：两端config同room、互指remote user、只有target `publishScreen=true`、身份不含原device ID；wrong role/stale call拒绝；TRTC control/status不跨设备泄漏。
- Electron unit/smoke：断言窄preload、renderer Node禁用/context隔离、SDK真实加载并报告版本；固定30fps、系统loopback和麦克风音量语义。
- Package：检查 `app.asar.unpacked/node_modules/trtc-electron-sdk/build/Release` 的完整native文件集合。
- Build：server/pet tests、web/pet TypeScript build；双机完成中国→新加坡30分钟720p30和1080p30实测。

### 7. Wrong vs Correct

#### Wrong

```js
contextBridge.exposeInMainWorld('secret', process.env.TRTC_SECRET_KEY);
webPreferences: { nodeIntegration: true };
const mode = localSdkExists ? 'trtc' : 'webrtc'; // 两端可能分叉
gzipSync(userSigJson); // TRTC TLS Sig 2.0 要求 deflate
```

#### Correct

```js
const mediaMode = trtcReady() ? 'trtc' : 'webrtc';
io.to(controller).emit('call:start', { callId, mediaMode });
webPreferences: {
  preload: controlPreload,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false, // 仅为 preload require native addon
}
const compressed = deflateSync(Buffer.from(JSON.stringify(userSigDocument)));
```
