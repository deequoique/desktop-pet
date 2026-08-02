# 诊断 IPv4 WebRTC P2P 从未成功

## Goal

在不改变现有 ICE 选路行为的前提下，为控制端与桌宠端补齐可导出的结构化 WebRTC 诊断信息，并通过一组可重复的对照测试，确定 IPv4 P2P 从未成功属于以下哪一类：

1. 本地没有生成可用的 IPv4 `srflx` candidate。
2. 本地生成了 candidate，但没有通过信令到达对端。
3. candidate 到达了对端，但因 ICE generation、时序或 `addIceCandidate` 失败而未参与检查。
4. 双方 candidate 与信令均正常，但 IPv4 candidate pair 的连通性检查失败，问题位于 NAT、防火墙或运营商路径。

本任务的完成标准是拿到足以支持结论的两端证据，不是保证所有网络都能建立 IPv4 P2P。

## Dependency

依赖 `07-28-client-crash-diagnostics` 先交付统一 envelope、renderer→main 安全 IPC、breadcrumbs/incident 和导出 schema。本任务只定义并接入 WebRTC 专项事件，不再自建另一套持久化通道。

## Background

目前已经确认：

- IPv6 可用时可以建立 P2P 视频连接。
- 无 IPv6 的 macOS 会回退到 TURN，TURN 语音可用。
- coturn、临时凭据和服务端 RTC 配置均已工作。
- 服务器能看到 STUN/TURN 端口流量，但服务端日志看不到浏览器生成了哪些 candidate、对端是否收到、哪些 candidate pair 检查失败。
- 当前界面会把尚未完成选路的 `unknown` 状态显示成“连接稳定”，容易造成误判。
- v1.6.0 另有一个与网络无关的控制端生命周期回归，会造成单向可见并阻塞双端对照实验；该修复与双向摄像头扩展由兄弟任务 `.trellis/tasks/07-28-bidirectional-call-camera/` 独立交付。

因此，现有证据只能证明“IPv4 直连未被选中”，不能证明 STUN 本身失败，也不能直接断言是对称 NAT、CGNAT 或云安全组。

## Requirements

### R1. Candidate 观测

- 控制端和桌宠端都要记录每个本地与远端 ICE candidate。
- 每条记录至少包含：
  - 端角色、方向、媒体连接类型和 `callId`
  - `candidateType`
  - `protocol`
  - `address`、`port`
  - `relatedAddress`、`relatedPort`
  - `foundation`、`priority`
  - `tcpType`
  - `usernameFragment`
  - `sdpMid`、`sdpMLineIndex`
- 必须记录 gathering complete/end-of-candidates。
- 不记录完整 SDP、TURN credential、TURN 临时用户名或房间密钥。

### R2. ICE 错误与状态时间线

- 两端记录 `icecandidateerror` 的 URL、错误码和错误文本。
- 两端记录下列状态变化，并带时间与 `callId`：
  - `iceGatheringState`
  - `iceConnectionState`
  - `connectionState`
  - `signalingState`
- 远端 candidate 入队、出队及 `addIceCandidate` 失败必须可区分。

### R3. Candidate pair 证据

- 在连接成功、选路完成、断开和失败等关键节点采集一次 `getStats()`。
- 记录最终选中的 local/remote candidate pair。
- 同时记录失败、成功或仍在进行 connectivity check 的 candidate pair，至少包含：
  - pair state、selected、nominated、priority
  - local/remote candidate type、protocol、address、port
  - relay protocol
  - RTT、可用发送码率、收发字节数
  - STUN request/response 计数（浏览器提供时）
- 诊断采样必须是事件驱动且有界，不能持续高频轮询。

### R4. 可导出与可关联

- WebRTC 诊断写入现有诊断日志，并通过现有“导出诊断”功能导出。
- 控制端和桌宠端导出的记录必须可以使用 `callId` 与 ICE username fragment 对齐。
- renderer 到主进程的诊断入口必须校验来源和输入大小，继续复用现有敏感字段脱敏与日志轮转。
- candidate 地址是诊断所必需的网络元数据；只写入用户主动导出的本地诊断文件，不上传服务端。
- 用户已明确允许诊断包保留精确 ICE IP、端口和 related address；导出 UI 必须提示包含网络地址信息。

### R5. 状态显示准确

- 未得到 selected candidate pair 时显示“选路中”，不能显示“连接稳定”。
- 已选路后区分 IPv6 P2P、IPv4 P2P 与 TURN relay。
- 界面只提供简洁结论；完整技术数据保留在诊断导出中。

### R6. 第一轮保持变量不变

第一轮诊断实现不得同时修改：

- STUN/TURN 地址和 `iceTransportPolicy`
- candidate 转发、队列和现有 `callId` 过滤逻辑
- offer/answer 协商模型
- ICE restart 次数和超时
- relay 时仅语音的产品策略

先观察现状，避免“修复”本身改变实验结果。

## Root-cause Decision Rules

- 没有 IPv4 `srflx`，并伴随 STUN `icecandidateerror`：客户端到 STUN 的 UDP 请求或响应路径失败。
- 没有 IPv4 `srflx`，也没有 STUN 错误：继续检查客户端实际加载的 ICE 配置与 gathering 是否结束。
- A 端生成 `srflx`，B 端同一 `callId` 中未收到：信令转发、会话过滤或旧连接串线。
- B 端收到 candidate，但 `addIceCandidate` 失败或 username fragment 不属于当前 generation：客户端时序/代际问题。
- 双方均生成、收到并成功添加 `srflx`，但所有 IPv4 direct pair 失败而 relay 成功：NAT、防火墙或运营商 IPv4 路径不允许直接连通。
- 只有在使用至少两个独立 STUN 目的地比较映射行为后，才进一步断言“对称 NAT”；第一轮不得凭 relay 结果单独下此结论。

## Acceptance Criteria

- [ ] 控制端与桌宠端均可导出带 `callId` 的 candidate、状态、错误和 pair 记录。
- [ ] 一次无 IPv6 的 macOS 对照测试可以明确归入上述四类原因之一，或明确指出还缺少哪一项外部证据。
- [ ] 一次 IPv6 成功测试能在诊断中显示 IPv6 host/direct selected pair，作为基线。
- [ ] 一次 TURN 兜底测试能显示 relay selected pair，同时保留此前失败的 IPv4 direct pair 信息。
- [ ] 诊断中不包含完整 SDP、RTC credential、room secret 或 API key。
- [ ] 日志大小有界，已有诊断日志轮转和导出行为不回退。
- [ ] “选路中”不再被误报为“连接稳定”。
- [ ] 相关单元测试、类型检查和构建通过。

## Out of Scope

- 承诺在所有 NAT 组合下实现 IPv4 P2P。
- 在证据出现前调整 STUN/TURN 拓扑或重写 WebRTC negotiation。
- 将客户端候选地址上传到应用服务器。
- 第一轮就自动识别所有 NAT 类型。

## Notes

- 关联背景任务：`.trellis/tasks/07-28-webrtc-server-rtc-config-docs/`。
- 实现可在基础诊断依赖满足后独立进行；Phase 5 双端人工对照测试必须等待 `.trellis/tasks/07-28-bidirectional-call-camera/` 验证双方主通话稳定后再执行。
- 服务器 `tcpdump` 中出现 3478/relay 端口流量，只能证明客户端与 coturn 有通信，不能单独说明 direct ICE pair 为什么失败。
