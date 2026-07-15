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
  media: 'screen'|'microphone'|'system-audio';
  state: 'available'|'paused'|'unavailable';
  reason?: 'relay_audio_only'|'capture_failed'|'track_ended';
};
```

`webrtc:media-status` 只能由当前 call 的 pet 发出，并只路由给另一 participant 的 controller。事件名、枚举和类型副本必须同步。

## 5. Route and media invariants

- 每次创建 peer connection 前请求 server config；失败时 host-only，不恢复 Google STUN。
- selected pair 同时兼容 transport `selectedCandidatePairId` 与 nominated/succeeded pair。
- Screen track 初始禁用。只有明确判定非 relay 后启用；unknown 不能启用。
- relay 时 screen 保持禁用并上报 `paused/relay_audio_only`，麦克风继续。
- 屏幕拒绝或 track ended 只上报媒体状态，不能结束可用的音频连接。
- disconnected/failed 时 pet 不 hangup；controller restart一次，恢复清 timer并重新判路，15秒超时后才结束 call。
- call ID过滤、candidate 暂存与集中幂等 teardown 必须保留。

## 6. Deployment contract

自动化入口为 `server/deploy/install-coturn-ubuntu.sh`，支持 `--preflight|--dry-run|--install|--verify|--rollback` 配合 `--config`。目标为 Ubuntu 24.04/systemd/apt/UFW。配置文件必须 mode 600；脚本不得修改云防火墙。

最小公网端口：UDP/TCP 3478、UDP 49160-49200，可选 TCP 5349。不得默认开放完整动态端口范围。操作细节只维护在 `docs/ubuntu-coturn-deployment.md`。

## 7. Verification and examples

跨层改动必须运行 server tests、web build、pet build和 `bash -n`。手工矩阵至少覆盖 LAN、IPv6 P2P、IPv4打洞、强制 relay、15秒内恢复、恢复超时、屏幕拒绝和屏幕结束。

错误：客户端硬编码公共 STUN；route 未确认就启用视频；任何 disconnected 立即 `call:end`；把 shared secret 发给客户端；部署脚本静默开放云安全组。

正确：server 短期签发、host-only 降级、relay audio-only、非致命屏幕状态、一次 ICE restart，以及外部 allocation/带宽验收。
