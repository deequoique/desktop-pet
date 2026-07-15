# 技术设计：双栈 P2P 与 TURN 音频兜底

## 架构与边界

保留现有 Socket.IO 信令和单个 `RTCPeerConnection`/方向的结构。每台 Electron 客户端仍提供 `controller` 与 `pet` endpoint；两个 controller 分别向对方 pet 发起 offer。应用 server 只协调房间、call ID、SDP/ICE、RTC 配置和媒体状态。

选路由标准 ICE 在 IPv6/IPv4 host、srflx 与 relay candidate 间决定；应用不通过 SDP munging 强制地址族，但所有直连 candidate 均优先于 relay。双方可直连时传输屏幕、麦克风和系统声音；selected pair 包含 relay 时只保留音频，screen video 不持续经过腾讯云。

## 配置与跨层契约

### Server 环境变量

```dotenv
RTC_STUN_URLS=stun:turn.example.com:3478
RTC_TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
RTC_TURN_SHARED_SECRET=<与 coturn static-auth-secret 相同的随机密钥>
RTC_TURN_REALM=turn.example.com
RTC_TURN_CREDENTIAL_TTL_SEC=43200
RTC_ICE_TRANSPORT_POLICY=all
```

- `RTC_STUN_URLS` 可为空；非空项必须是 `stun:`/`stuns:` URL。
- `RTC_TURN_URLS` 与 `RTC_TURN_SHARED_SECRET` 必须同时配置，否则 TURN 视为禁用并只返回 STUN/host 配置。
- TTL 默认 12 小时，允许 10 分钟到 24 小时；覆盖正常私人通话时长，避免 allocation refresh 时凭据过期。
- `RTC_ICE_TRANSPORT_POLICY` 生产环境固定为 `all`；`relay` 仅用于部署验收和手动测试。

### RTC 配置请求

两个已入房角色均可调用：

```ts
socket.emit('webrtc:get-config', ack)

type RtcConfigResponse =
  | {
      ok: true;
      iceServers: RTCIceServer[];
      iceTransportPolicy: 'all' | 'relay';
      expiresAt?: number;
    }
  | { ok: false; code: 'not_joined' };
```

TURN 用户名为 `<expiresUnixSeconds>:<participantId>`，credential 为 `base64(HMAC-SHA1(sharedSecret, username))`。响应只包含临时 username/credential，绝不包含共享密钥。controller 在创建 offer 前请求；pet 在处理 offer并创建 peer connection 前请求。配置请求失败时允许使用空 `iceServers` 继续 IPv6/局域网 host-only 尝试，并在 UI/日志标记配置不可用。

### 媒体状态

pet 经 server 转发给对方 controller：

```ts
type WebRtcMediaStatus = {
  callId: string;
  media: 'screen' | 'microphone' | 'system-audio';
  state: 'available' | 'paused' | 'unavailable';
  reason?: 'relay_audio_only' | 'capture_failed' | 'track_ended';
};

socket.emit('webrtc:media-status', status);
```

server 校验 call ID、发送方为 pet、房间归属和目标 controller；过期或非法状态静默丢弃。现有 `WebRtcSignal` shape 不变，ICE restart 继续通过带同一 call ID 的新 offer/answer 传输。

## 客户端媒体与选路状态机

1. controller 与 pet 分别获取 RTC 配置后创建 peer connection；两端继续缓存 remote description 前到达的 ICE candidate。
2. pet 将 screen track 初始设为 disabled；麦克风和系统声音使用保守音频码率上限。屏幕采集失败不再阻止音频 peer connection 建立；controller 的屏幕可用状态以 `webrtc:media-status` 为准，不再仅凭远端 video track 是否存在判断。
3. `connected` 后两端读取 selected candidate pair：任一本地/远端 candidate 为 `relay` 即判定 TURN；否则按地址族显示 IPv6/IPv4 P2P。
4. P2P：pet 启用 screen track并发送 `screen/available`；TURN：保持 screen track disabled并发送 `screen/paused + relay_audio_only`。controller 显示“TURN 音频兜底，屏幕不可用”。
5. screen track `ended` 或 capture failed 只更新媒体状态并释放视频资源，不清理麦克风、远端音频或 peer connection。
6. controller 是唯一 ICE restart offerer。`disconnected`/`failed` 首次出现时进入 `recovering`，调用 `restartIce()`并发送新 offer；15 秒内恢复则重新判定 route，超时才发送 `call:end`。pet 等待 restart offer，不主动制造 glare，也不在短暂 disconnected 时挂断。
7. server/socket 真正断线、用户挂断或恢复超时仍走集中 teardown。

## 通用 Ubuntu coturn 部署

- 平台契约：任意云厂商或独立 VPS 的 Ubuntu Server 24.04 LTS 64-bit，具有公网 IPv4、sudo、systemd 和可配置的入站防火墙。当前腾讯云3 Mbps实例是容量基线，不写入通用安装逻辑。
- listener：UDP/TCP 3478；relay：UDP 49160-49200。TURN/TLS TCP 5349 作为拥有域名和可续期证书时的可选章节。
- coturn：`use-auth-secret`、`static-auth-secret`、固定 realm、`external-ip=<public>/<private>`、`fingerprint`、`stale-nonce`、`no-multicast-peers`、最小 relay range。
- 资源保护默认：`max-bps=64000`、`bps-capacity=250000`、`user-quota=4`、`total-quota=8`；应用层禁止 relay video形成第一道限制，coturn 配额形成第二道硬限制。
- 云防火墙/安全组与 UFW 同时只开放规定端口；SSH/HTTPS 沿用现有规则。匿名 TURN 禁止，STUN binding 保持公开以服务动态客户端地址。通用正文描述端口契约，腾讯云附录只说明控制台字段映射。
- systemd 管理 coturn；通过 `turnutils_stunclient`、带正确/错误临时凭据的 `turnutils_uclient`、Electron 强制 relay 测试、主机/云厂商出网监控完成验收。

### Agent runbook 契约

- 文档开头给出执行 agent 必须收集的输入表：`PUBLIC_IPV4`、`PRIVATE_IPV4`、`TURN_HOST`、`TURN_REALM`、`TURN_SHARED_SECRET`、应用 server `.env` 路径、是否启用 TLS、云防火墙是否已开放。
- 每个输入都有发现命令、合法格式、示例和“无法确定时停止并询问用户”的条件；禁止 agent 猜公网/私网映射或覆盖现有防火墙。
- 正文按 preflight → 安装 → 备份 → 配置 → 云防火墙 → UFW → systemd → server env → 验证 → 监控排列。重复执行不得生成重复规则或破坏现有配置。
- 每一步给出命令、预期退出码/关键输出和失败分支；secret 通过受限文件或交互变量传递，不出现在 shell history、进程参数、Git diff 或日志。
- 最后提供机器可勾选的验收清单和完全逆序的回滚清单，使 agent 可明确判断完成/失败。

### 一键部署脚本契约

交付以下文件，并将其包含进 Linux server release bundle：

```text
server/deploy/coturn.env.example
server/deploy/install-coturn-ubuntu.sh
```

调用接口：

```bash
sudo ./server/deploy/install-coturn-ubuntu.sh \
  --config /secure/path/coturn.env \
  --install

# 其他互斥模式
--preflight | --dry-run | --verify | --rollback
```

- 脚本仅支持 Ubuntu 24.04、Bash、systemd、apt 和 UFW；不满足时非零退出并说明缺失条件。
- 配置文件必须是 root 可读且不允许 group/other 访问；包含公私网 IP、realm、shared secret、端口/relay范围、配额、应用 `.env` 路径和 TLS 开关。secret 不允许通过命令行参数传递。
- `--preflight` 只检查系统、端口冲突、IP 格式、NAT 映射、配置权限和应用 env 可写性；`--dry-run` 输出脱敏变更计划且不写系统。
- `--install` 使用 apt 幂等安装 coturn，原子写配置，给脚本管理的 UFW 规则加可识别注释，更新应用 RTC env，运行配置检查后才 enable/restart systemd。
- 状态和备份保存到 root-only 的 `/var/lib/desktop-pet-coturn/`；`--rollback` 仅删除带脚本标记的 UFW 规则、恢复脚本保存的 coturn/app env 备份并恢复原 service 状态，不自动卸载 apt 包。
- `--verify` 检查配置权限、systemd、监听端口、UFW、本机 STUN和 server env一致性；公网云防火墙与外部 TURN allocation 必须由 runbook 的外部 agent 步骤验证。

## 兼容、发布与回滚

- 发布顺序：先部署 coturn和端口，再发布支持 `webrtc:get-config` 的 server，最后发布 Electron。避免新客户端拿不到配置。
- server 未配置 TURN 时返回 STUN-only；RTC 配置请求超时则客户端 host-only，保持局域网/IPv6基本能力。
- 旧客户端继续使用原有信令事件，不因新增事件被踢出；server 的原有 call ID 和 room 规则保持不变。
- 回滚先把 server 的 TURN URL/secret 置空，使新客户端停止申请 relay，再回滚 Electron；最后按文档停用 coturn并关闭安全组/UFW端口。

## 主要取舍

- 不拆分音频/视频为两个 peer connection：单连接改动更小；通过 route 确认前禁用视频和 relay 后持续禁用来保证带宽边界。
- 不使用 IP 白名单或设备公钥：私人双人项目继续依赖高熵 room secret；TURN 仍必须限时认证以防自动扫描滥用。
- 不保证 TURN 视频：3 Mbps 优先换取稳定语音；只有非 relay selected pair 才恢复屏幕。
