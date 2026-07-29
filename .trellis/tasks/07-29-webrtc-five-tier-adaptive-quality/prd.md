# WebRTC 实时网络质量与五档自适应

## Goal

让双人通话能够实时显示当前网络质量，并在 P2P、TURN 或网络波动期间自动在五档视频质量之间切换。策略以音频连续和画面流畅为第一优先级，快速降档、保守升档，避免高码率排队造成“一开始流畅、随后卡顿”。

本任务同时修复真实诊断中发现的 route 误判：coturn 私网 relay allocation 经公网 NAT 后可能在 Chromium stats 中表现为带 `relayProtocol` 的 `prflx`，不能继续当作真正 P2P。

## Requirements

### R1. 有效路径识别

- selected pair 任一 candidate 的 `candidateType=relay` 或存在 `relayProtocol` 时都视为 TURN。
- selected `prflx` 命中配置的 TURN host，或与 report 中 relay candidate 共享 port 和 username fragment 时，也视为 TURN relay alias。
- UI、视频 profile 与诊断事件必须使用同一有效路径判定，不能一处显示 P2P、另一处按 TURN 处理。
- 真实 P2P 与 TURN 切换不重新捕获媒体，也不改变用户的屏幕/摄像头开关。

### R2. 五档视频质量

- 屏幕与摄像头各有 1–5 档明确的分辨率、帧率和最大码率；1 档沿用已批准的 TURN 最低清硬上限。
- TURN 始终最多使用 1 档；真实 P2P 根据实时指标在五档间自适应。
- 音频 sender 继续独立限速，视频降档或 profile 失败不得结束可用音频。
- profile mutation 串行执行并使用 generation guard，过期异步操作不能覆盖新档位。

### R3. 自适应控制

- 每两秒读取 candidate-pair 与 RTP stats，使用 RTT、可用上行带宽、丢包、抖动、实际码率、帧率和 bandwidth limitation 判级。
- 严重恶化可立即降至目标档；普通恶化连续出现后降档。升档必须连续稳定并一次只升一档。
- 连接 unknown/failed 时视频 fail closed；恢复后从保守档位重新评估。

### R4. 实时 UI 与远端状态

- 通话侧栏显示当前主链路类型、实时 RTT、网络等级和接收视频实际码率/帧率。
- 屏幕与摄像头状态携带 `qualityLevel: 1..5`，server 只做鉴权、校验和定向转发。
- UI 明确显示当前屏幕/摄像头档位；旧客户端的 `quality: normal|relay-low` 仍兼容。

### R5. 低开销诊断

- 周期采样记录 compact selected pair 与 RTP summary，不再把全部 candidate pair 重复写入每条 stats。
- 常见的单网卡 STUN/TURN 600/701 candidate error 记为可自动恢复的 warn，不能为每条产生 incident。
- 档位变化记录原因与关键指标；不记录媒体内容、完整 SDP 或 credential。

### R6. coturn 配置验证

- 部署验证必须检查 `min-port`、`max-port`、`relay-ip`，并在公网/私网不同时检查精确的 `external-ip=公网/私网`。
- 运维文档提供识别私网 relay candidate 和伪 P2P 的检查方法。

## Acceptance Criteria

- [x] 诊断样本中的 `prflx + relayProtocol + TURN 公网地址` 被显示并处理为 TURN，而不是 IPv4 P2P。
- [x] 屏幕和摄像头各能应用五档 profile；TURN 路径不超过 1 档的既有硬上限。
- [x] 严重 RTT/丢包/带宽恶化快速降档，稳定至少约 10 秒后才逐档升档，不在阈值附近反复抖动。
- [x] 通话 UI 每约 2 秒更新 RTT、网络等级、当前档位、接收码率和帧率。
- [x] `qualityLevel` 只在当前通话的合法 pet/controller 间转发，非法值被丢弃，旧 quality 字段保持兼容。
- [x] 周期诊断包含 inbound/outbound RTP、丢包、抖动、帧率和 effective relay，但单条体积有界。
- [x] benign ICE candidate error 不再触发 incident 写入风暴。
- [x] coturn `--verify` 能拒绝缺失/错误的 external-ip 与 relay 端口配置。
- [x] server tests、pet tests、web build、pet build 与部署脚本语法检查通过。
