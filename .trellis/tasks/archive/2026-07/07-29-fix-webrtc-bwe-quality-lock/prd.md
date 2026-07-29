# 修复 WebRTC 带宽估算自锁降档

## Goal

修复真实 P2P 链路在低延迟、网络等级“极佳”时仍被自动画质长期锁在 1 档（240 kbit/s、5fps）的问题。P2P 屏幕共享需要把帧率与清晰度拆成两个可独立调整的维度，沿单调提升的内部状态逐步改善，最高允许2K/90fps。只有 effective relay/TURN 使用5fps流量保护。

## Background

- 现场截图显示主链路为 `IPv4 P2P`、RTT `29 ms`、网络等级“极佳”，但远端 screen sender 上报 `1档`，接收端稳定只有 `5 fps`。
- 1 档的 `5 fps` 是应用通过 `RTCRtpSender.setParameters()` 设置的硬上限，不是网络或解码器只能达到 5 帧。
- 当前 `recommendVideoQualityLevel()` 将 selected candidate pair 的 `availableOutgoingBitrate` 当作硬容量上限：先为屏幕减去 `128 kbit/s`，再要求剩余值覆盖目标档最大码率的 `1.25×`（`web/src/video-profile.ts:88`）。
- `availableOutgoingBitrate` 是 Chromium 拥塞控制器根据近期发送与反馈给出的瞬时估算，不是独立测速结果，也不是某一路视频的固定预算。估算会受当前发送量、探测阶段和编码上限影响。
- 当前算法若算出目标 1 档，会把它视为严重恶化并立即从当前档跳到 1 档（`web/src/video-profile.ts:138`）。降档后 sender 被限制到低发送量，带宽估算可能继续偏低，目标档仍为 1，升级计数无法开始，形成自锁。
- `41 kbps` 是当前实际接收码率；屏幕内容静止时它本来就可能远低于档位上限，不能反向证明线路容量只有 41 kbit/s。
- 当前五档 screen profile 把帧率从 5fps 到 15fps 与清晰度一起降低，因此即使路径是低延迟 P2P，也会由应用主动制造不流畅。`maxFramerate` 只是发送上限，不能保证最低实际帧率。

## Requirements

### R1. `availableOutgoingBitrate` 降为辅助信号

- P2P 路径上不得再由单个或持续偏低的 `availableOutgoingBitrate` 独自触发跨多档降至 1 档。
- 该字段只用于保守限制升档或在连续样本中辅助降一档；不得把它解释为独立测速值。
- TURN/effective relay 继续固定 1 档，不受本修复影响。

### R2. 使用可验证的拥塞证据

- 严重 RTT、实际丢包、抖动、连接失败仍可快速降档。
- `qualityLimitationReason=bandwidth` 和低 `availableOutgoingBitrate` 只用于延长升档观察；普通 P2P 的降档依据必须来自 RTT、丢包、抖动或连接状态。
- 实际发送/接收码率只用于观察编码结果，不能直接当成线路容量。

### R3. 低档恢复试探

- 真实 P2P 在 RTT、丢包和抖动连续健康时，即使带宽估算仍偏低，也必须允许从安全状态480p30逐档恢复试探。
- 每次只升一档并观察后续样本；若真实拥塞指标恶化，可快速退回。
- 恢复不得重新捕获屏幕、替换 track 或中断音频。

### R4. P2P 帧率与清晰度双维自适应

- IPv4 P2P 和 IPv6 P2P 使用相同策略，不按 IP 协议版本区分画质。
- P2P screen sender 的帧率目标为 30/45/60/90fps，90fps 是最高上限。
- P2P screen sender 的清晰度级别为 360p/480p/720p/1080p/2K，2K 按 2560×1440 处理，不能继续放大。
- 复合状态是控制器内部台阶，不作为七个用户可见“档位”；`qualityLevel` 仍表示清晰度，UI继续显示实际接收fps。
- 链路改善时按以下已确认状态单调升级：`480p30 → 720p30 → 720p45 → 1080p45 → 1080p60 → 2K60 → 2K90`。
- 链路恶化时沿上述状态反向逐级回退；严重拥塞可以直接回到480p30。
- P2P sender 应设置 `degradationPreference='maintain-framerate'`（运行时支持时），明确要求编码器优先牺牲分辨率而不是帧率。
- 30–90fps 均为 sender/capture 的目标或上限，不得在 UI 中表述成网络条件不足、源显示器刷新率不足或画面静止时仍能保证的最低实测值。
- effective relay/TURN 的 screen 1 档继续固定 640×360、5fps、240 kbit/s，以控制服务器中继流量。
- 摄像头保留现有 10–24fps 五档策略，不随本任务统一到 30fps。

### R5. 可解释诊断

- 档位变化诊断保留当前档、目标档、RTT、丢包、抖动、`availableOutgoingBitrate` 和 bandwidth limitation。
- 能从导出包区分“硬拥塞降档”“带宽辅助限制”“健康恢复试探”，避免只看到最终档位而不知道触发原因。

## Proposed Fix

1. 将 RTT、丢包、抖动和连接状态作为主要健康判定。
2. 将 `availableOutgoingBitrate` 从“硬容量门”改成软信号：单独出现时不触发降档，与 bandwidth limitation 同时出现时只延长升档观察。
3. P2P 处于低档且主要健康指标连续正常时，忽略尚未恢复的旧带宽估算，执行一次逐档恢复试探。
4. P2P screen 使用独立的帧率目标和清晰度级别，并按已确认的七级内部状态表单调升降。
5. TURN screen 继续使用独立的 640×360、5fps、240 kbit/s 硬上限。
6. 试探后继续观察真实拥塞反馈；有明确恶化时按“超高帧率→清晰度→基础帧率”的顺序回退。
7. 保持 web/pet 两份 `video-profile` 实现和测试完全一致。

## Acceptance Criteria

- [ ] 初始 3 档、RTT 约 29 ms、无丢包/低抖动、`availableOutgoingBitrate=300000` 时，不会立即跳到 1 档。
- [ ] 已处于480p30的真实 P2P，在连续健康样本后即使 `availableOutgoingBitrate` 未上升，也至少能试探恢复到720p30。
- [ ] RTT ≥ 550 ms、明显丢包或连接失败时仍能快速回到480p30保护音频。
- [ ] effective relay 始终锁定 1 档。
- [ ] IPv4/IPv6 P2P screen 能按 30/45/60/90fps 调整，且不超过90fps。
- [ ] P2P 严格按 `480p30 → 720p30 → 720p45 → 1080p45 → 1080p60 → 2K60 → 2K90` 单调升级，不出现升档时帧率或分辨率倒退。
- [ ] 清晰度不超过2560×1440，帧率目标不超过90fps；拥堵时沿状态表反向回退。
- [ ] P2P screen 设置支持时的 `maintain-framerate`。
- [ ] TURN screen 仍限制为 640×360、5fps、240 kbit/s。
- [ ] camera 五档帧率保持现有 10–24fps。
- [ ] 升档一次只升一级，试探失败能回退，不反复捕获媒体或切断音频。
- [ ] 诊断事件能够说明降档/升档的决定类型和参与指标。
- [ ] pet/web 纯函数回归测试覆盖自锁复现、健康恢复、真实拥塞和 TURN 四种情况。
- [ ] `npm test --prefix pet`、`npm run build:web` 和 `npm run build:pet` 通过。

## Out of Scope

- 不修改 P2P/TURN 路径识别、信令、coturn 或 server 转发协议。
- 不在本任务中设计新的端到端主动测速协议。
- 不保证90fps适用于所有显示器、捕获源、编码器或远端设备；运行时能力不足时以实际 stats 为准。
