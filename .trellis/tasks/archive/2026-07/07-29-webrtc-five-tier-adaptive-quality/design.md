# WebRTC 五档自适应设计

## 1. 数据流

```text
RTCPeerConnection.getStats (2s)
  → compact RtcNetworkSample
    ├─ controller main → 实时接收质量 UI
    ├─ controller camera sender → camera 五档 controller
    ├─ pet main screen sender → screen 五档 controller
    └─ 每 10s / 档位变化 → 本地诊断

selected pair
  → effective relay 判定
    → candidateType=relay OR relayProtocol 存在
      OR TURN host 命中
      OR same-port + same-ufrag relay alias
```

Server 不接收网络采样，只继续转发受控的 media status。媒体仍直接走 WebRTC/coturn。

## 2. 五档 profile

| 档位 | 屏幕 | 摄像头 | 用户语义 |
|---:|---|---|---|
| 5 | 2560×1440 / 15fps / 3.5Mbps | 1280×720 / 24fps / 1.5Mbps | 极佳 |
| 4 | 1600×900 / 12fps / 1.5Mbps | 960×540 / 20fps / 900kbps | 良好 |
| 3 | 1280×720 / 10fps / 900kbps | 640×360 / 15fps / 500kbps | 一般 |
| 2 | 854×480 / 7fps / 450kbps | 480×270 / 12fps / 240kbps | 拥堵 |
| 1 | 640×360 / 5fps / 240kbps | 320×180 / 10fps / 120kbps | 较差 / TURN |

档位通过 `RTCRtpSender.setParameters()` 更新 `maxBitrate`、`maxFramerate` 与等比 `scaleResolutionDownBy`。不得放大小源。

## 3. 判级与防抖

每个 sender 拥有独立 controller。输入优先使用 sender 可见的 `remote-inbound-rtp` RTT/丢包，其次 selected pair RTT；可用上行带宽、jitter 与 `qualityLimitationReason=bandwidth` 共同下压推荐档。

- 严重恶化（推荐比当前低至少两档或落到 1 档）立即降档。
- 普通恶化连续两个样本后降至推荐档。
- 升档需连续六个稳定样本（约 12 秒），且一次只升一档。
- TURN/有效 relay 直接锁定 1 档。
- route 恢复后从 3 档开始，避免一恢复就注入最高码率。

阈值是产品初始值，诊断事件保留输入和决定，后续根据真实环境调整。

## 4. 采样契约

`RtcNetworkSample` 包含：

- selected pair：candidate 摘要、effective relay、RTT、available outgoing bitrate。
- outbound video：实际 bitrate、fps、尺寸、packets/retransmissions、NACK/PLI、quality limitation reason。
- remote inbound video：RTT、fraction loss、packets lost、jitter。
- inbound video：实际 bitrate、fps、尺寸、packets lost、jitter、frames dropped、freeze count。

速率字段由连续 report 的 timestamp/byte delta 计算。生命周期 snapshot 可保留少量候选 pair；periodic 只写 selected pair 与 RTP summary。

## 5. 兼容与回滚

- `MediaStatus.quality` 保留 `normal|relay-low`；新增 `qualityLevel`，旧客户端忽略未知字段。
- 新客户端缺少 `qualityLevel` 时从旧 quality 推导 1 或 5。
- 关闭采样 handle 会同步清理 interval，不能在挂断后继续 getStats。
- 若 stats 或 setParameters 不受支持，保持音频并 fail closed 对应视频。

## 6. coturn

当 `PUBLIC_IP != PRIVATE_IP` 时，`external-ip=PUBLIC_IP/PRIVATE_IP` 是硬约束。verify 除进程/端口/secret 外，还检查 relay address mapping 与配置端口范围，防止私网 relay candidate 被 NAT 学成伪 `prflx`。
