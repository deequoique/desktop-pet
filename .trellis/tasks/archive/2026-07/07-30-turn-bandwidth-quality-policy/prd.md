# TURN 带宽与动态画质策略

## Goal

在服务器公网带宽约 3 Mbps、月流量包 300 GB 的约束下，重新设计 TURN 视频策略：优先保证通话音频和屏幕共享流畅度，同时避免当前固定 640×360、5fps、240 kbit/s 过度牺牲体验，也不能让并发媒体把 TURN 公网出口打满。

## Background

- 用户已确认服务器为腾讯云轻量应用服务器（Lighthouse）。控制台显示公网带宽为 3 Mbps，月流量包为 300 GB；当前仅使用约 2 GB，月流量总量暂时不是主要瓶颈。
- 3 Mbps 是瞬时吞吐上限，300 GB 是累计传输额度，两者不能混为一谈。
- 腾讯云官方[流量包说明](https://cloud.tencent.com/document/product/1207/82259)与[计费概述](https://cloud.tencent.com/document/product/1207/44368)说明：轻量应用服务器流量包只统计实例公网出流量，超出流量包后的计费也只统计出流量；流量包按实例计费周期在每个自然月重置。
- 腾讯云[基本概念](https://cloud.tencent.com/document/product/1207/79254)将控制台公网带宽定义为实例公网出方向峰值带宽；峰值带宽不是承诺带宽，在共享资源繁忙时实际可用吞吐可能低于 3 Mbps。因此策略必须保留余量，不能以持续跑满 3 Mbps 为目标。
- 用户确认这台服务器除桌宠应用、TTS 与 coturn 外没有网站、下载、代理等其他公网业务；3 Mbps 预算无需再为不相关业务预留份额，但应用控制流量、TTS 突发和 TURN 协议开销仍共享同一公网出口。
- 当前 `RELAY_VIDEO_LIMITS.screen` 固定为 640×360、5fps、240 kbit/s；每路 TURN camera 固定为 320×180、10fps、120 kbit/s，音频 sender 上限为 64 kbit/s。
- 当前主屏幕/音频和camera使用两套独立ICE会话：主通话由 `web/src/App.tsx:702` 与 `pet/src/renderer/main.ts:2228` 创建peer connection，camera由双方controller在 `web/src/App.tsx:1029-1036` 另建peer connection。
- 两个peer connection拥有不同的本地UDP socket、ICE username/password、候选收集时序和NAT映射。即使运行在同一台设备上，一条连接可能选中IPv4/IPv6 P2P，另一条也可能因端口映射、候选竞速或网络切换而回退TURN；一条打洞成功不能证明另一条必然成功。
- 当前 `web/src/App.tsx:1354-1364` 在主通话offer发出后立即开始camera协商，并不等待主通话ICE connected/selected pair；camera默认未开启，因此此阶段没有camera RTP，只产生第二套STUN/TURN候选、connectivity check和可能的空闲TURN allocation。
- 单纯camera ICE打洞通常只产生很小的控制流量，不应显著降低主屏幕画质；真正可能争抢主屏幕的是camera开启后的RTP上行、设备CPU/GPU编码，以及两路连接同时经TURN时的共享服务器出口。
- 当前 P2P 屏幕码率模型的 60fps 基线为：480p 1.2 Mbps、720p 2.5 Mbps、1080p 5 Mbps、2K 8 Mbps；30fps 按比例减半，因此 720p30 上限约 1.25 Mbps，1080p30 上限约 2.5 Mbps。
- 一次通话可能同时存在单向屏幕、双向音频，以及双方各一路 camera。用户已决定不通过 TURN 传 camera；camera 自身路径需要明确判为 P2P 才能发送。
- `availableOutgoingBitrate` 是 Chromium 的端到端拥塞估算，不等于服务器配置的 3 Mbps；它可用于客户端自适应，但不能替代服务器总出口预算。
- 上一任务保留固定 5fps 是出于未知 TURN 成本的保守决策；现在已有明确的 3 Mbps/300 GB 约束，可以重新量化。

## Capacity Model

在只考虑一场双人通话、camera 不经 TURN、双向音频各按 64 kbit/s，并对媒体合计预留 20% 协议/重传余量时：

| TURN 屏幕目标 | 屏幕上限 | 含双向音频及余量的出口预算 | 300 GB 约可用时长 | 体验判断 |
| --- | ---: | ---: | ---: | --- |
| 480p30 | 约 0.6 Mbps | 约 0.874 Mbps | 约 0.393 GB/小时；763 小时/月；25.4 小时/天 | 流畅，文字细节一般；安全降级档 |
| 720p30 | 约 1.25 Mbps | 约 1.654 Mbps | 约 0.744 GB/小时；403 小时/月；13.4 小时/天 | 推荐稳定档，屏幕文字和动作较均衡 |
| 720p45 | 约 1.875 Mbps | 约 2.404 Mbps | 约 1.082 GB/小时；277 小时/月；9.2 小时/天 | 健康链路最高试探档，仍留约 0.6 Mbps 峰值余量 |
| 1080p30 | 约 2.5 Mbps | 约 3.154 Mbps | 已超过 3 Mbps 峰值 | 不可作为 TURN 档位 |
| 1080p45 及以上 | ≥3.75 Mbps | 明显超过 3 Mbps | 不适用 | 不可作为 TURN 档位 |

作为上界对照，3 Mbps 连续跑满约消耗 1.35 GB/小时，300 GB 约可支撑 222 小时/月、平均 7.4 小时/天。以上为按十进制网络单位和持续跑满码率计算的保守上界；桌面静止、编码器未持续打满目标码率时，真实流量通常更低。TURN 接收发送方媒体属于服务器入流量，不占流量包；服务器转发给接收方的媒体属于出流量并计入流量包，因此表中计入单向屏幕和双向音频的服务器出流量。

最终预算采用 720p30/约 1.2–1.3 Mbps 为稳定档，并允许在健康链路下试探到720p45/约1.875 Mbps；不进入1080p。关闭TURN camera后，720p45加双向64 kbit/s音频并预留20%协议/重传开销约为2.40 Mbps，仍保留约0.60 Mbps出口余量。由于 3 Mbps 是峰值而非承诺带宽，720p45只能是可快速回退的试探档，不能视为持续可保证档位。

## Requirements

### R1. 区分瞬时带宽与月流量

- 策略设计以 3 Mbps 共享公网出口作为硬约束。
- 300 GB 只用于估算可用通话时长和成本告警，不能直接决定瞬时画质。
- 流量估算按腾讯云轻量应用服务器只统计公网出方向的规则计算。

### R2. 音频优先

- TURN 拥塞时先降低屏幕和 camera，不能以音频卡顿换取更高清画面。
- 为音频、协议开销、重传和突发流量保留明确预算，不允许把 3 Mbps 全部分给 screen sender。

### R3. TURN 不再永久固定 5fps

- TURN screen从固定360p5改为独立的有限状态表：`480p30 → 720p30 → 720p45`。
- 接通先使用480p30；连续健康约6秒后升到720p30；再连续健康约12秒且带宽软信号有余量时试探720p45。
- 普通拥塞从720p45退到720p30；严重RTT、丢包、抖动或连接恶化立即回480p30。
- 720p45按约1.875 Mbps screen上限、双向音频和20%协议/重传余量计算，总TURN预算不得超过2.4 Mbps。
- TURN 状态必须和 P2P 2K90 状态表分离，不能因一次 route 恢复或 bandwidth 估算错误越过 TURN 硬上限。

### R4. TURN camera 禁用

- camera peer connection 可以继续尝试选路；只有 camera 自身 selected pair 明确为P2P时才能发送视频。
- 主屏幕是否为TURN不决定camera可用性；主屏幕TURN但camera自身P2P时允许正常发送camera。
- camera 自身 selected pair 为effective relay/TURN时，必须detach sender track、停止本地camera capture并上报受控状态，不能继续发送当前120 kbit/s低清画面。
- camera 因 TURN 禁用统一上报 `state:'unavailable'`、`reason:'relay_disabled'`，该原因需要在 web、server 和测试中的本地契约副本同步。
- camera 因 TURN 被关闭时同步把本地用户开启意图复位为关闭；即使 camera 路径随后恢复 P2P，也不得自动重新采集或发送，只提示用户已经可以手动重新打开。
- TURN camera禁用不能影响主屏幕、麦克风或系统声音。
- UI必须说明camera因TURN被关闭，避免把它误报成权限或设备故障。
- 主通话和camera的有效路径必须分别记录、分别决策，不能用主通话selected pair冒充camera selected pair。
- camera ICE预热必须延迟到主通话connected且selected pair已确认之后，避免两套ICE在接通阶段并行竞速；camera初始化失败不能反向结束或降级主通话。
- 主通话connected后camera仍在后台预热，因此用户稍后打开camera时无需重新等待完整主通话协商。

### R5. 共享出口预算

- 策略必须考虑 screen、双向 audio 和协议开销的总和；camera不占TURN预算。
- 当前版本只有客户端 RTC stats，没有 coturn 总出口遥测；在没有服务器总带宽反馈前，客户端策略必须使用保守的静态预算。

### R6. 媒体舞台空状态

- 当前 `web/src/App.tsx:2099-2106` 在 `cameraHidden=false` 时始终渲染远端camera surface，即使 `remoteCameraStatus !== 'available'`；但隐藏按钮只在camera available时出现，因此用户会看到无法关闭的“摄像头未开启”空窗口。
- 远端camera未开启、已关闭、因TURN禁用或track ended时，不渲染camera surface；屏幕画面直接使用主区域。
- camera从available变为unavailable时，媒体舞台自动移除camera surface并把primary恢复为screen；不要求用户先点“隐藏摄像头”。
- camera重新变为available时可以重新显示；显式“隐藏摄像头”只用于已有可用camera画面的用户偏好。

### R7. 可验证诊断

- 诊断应能区分 P2P/TURN、screen目标分辨率/帧率/码率、实际发送/接收码率、拥塞原因和camera因TURN禁用状态。
- 真实测试至少覆盖screen+audio TURN、camera P2P可用、camera TURN自动关闭，以及流量/带宽接近上限时的音频连续性。

## Acceptance Criteria

- [ ] 给出基于3 Mbps共享出口的明确媒体预算表，screen+双向audio+协议开销合计保留至少20%安全余量。
- [ ] 给出 300 GB 在不同目标总码率下的每小时消耗、每月小时数和日均可用时长。
- [ ] TURN screen在健康链路下可达到至少480p30，稳定档达到720p30，最高试探不超过720p45。
- [ ] TURN screen 不会应用 1080p30 或更高的可能饱和出口配置。
- [ ] camera自身路径为TURN时不发送video track并停止本地capture；camera为P2P时保持现有能力。
- [ ] `relay_disabled` 经过 server 校验并只转发给当前通话的另一 controller；旧的权限、设备和 profile 失败原因保持兼容。
- [ ] camera因TURN关闭后，路由恢复P2P不会自动重新打开硬件；用户手动打开后才重新采集和发送。
- [ ] screen+双向音频的最高TURN配置不超过2.4 Mbps预算。
- [ ] 拥塞时优先保证音频；视频按明确顺序降级且不重捕获 track。
- [ ] `remoteCameraStatus !== 'available'` 时媒体舞台不渲染camera surface，屏幕自动占满主画面；camera恢复后可重新出现。
- [ ] P2P 策略和 TURN 硬上限保持独立，IPv4/IPv6 判路逻辑不在本任务中改变。
- [ ] pet/web 镜像实现、纯函数回归、客户端构建和强制 relay 双机测试均有实施计划。

## Out of Scope

- 不购买或自动调整云服务器带宽套餐。
- 不修改 coturn 认证、端口、防火墙或 ICE 判路。
- 不实现多房间/多场同时通话的全局带宽调度；当前先针对一场双人通话。
- 不把 `availableOutgoingBitrate` 当作服务器出口总带宽监控。
