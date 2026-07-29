# WebRTC 双维屏幕自适应设计

> 本设计已获用户批准并进入实施。

## 1. 目标与边界

- P2P screen 将“帧率目标”和“清晰度级别”拆开管理。
- 正常链路沿已确认的内部状态逐步提高帧率和清晰度，最高2560×1440/90fps。
- 网络退化时沿内部状态反向回退；严重拥塞可直接回到480p30。
- TURN screen 仍固定640×360、5fps、240kbps。
- Camera 保留现有五档10–24fps，不进入双维控制器。
- 不修改 server、Socket.IO、RTC config、TURN判路和音频链路。

## 2. 状态模型

P2P screen controller 独立保存：

```ts
type ScreenFrameRateTarget = 5 | 30 | 45 | 60 | 90;
type VideoQualityLevel = 1 | 2 | 3 | 4 | 5;

type ScreenAdaptiveState = {
  qualityLevel: VideoQualityLevel;
  frameRateTarget: ScreenFrameRateTarget;
};
```

清晰度级别：

| level | 上限 |
|---:|---|
| 1 | 640×360 |
| 2 | 854×480 |
| 3 | 1280×720 |
| 4 | 1920×1080 |
| 5 | 2560×1440（2K/QHD） |

已确认的初始状态和升级路径：

```text
480p30
→ 720p30
→ 720p45
→ 1080p45
→ 1080p60
→ 2K60
→ 2K90
```

这些是内部试探状态，不是七个用户可见档位。`qualityLevel` 仍只映射分辨率；同一清晰度允许存在多个帧率目标。

## 3. 帧率满足60的语义

不能把单个 `outbound-rtp.framesPerSecond >= 60` 作为硬门：

- 静止桌面可能减少实际编码帧，即使网络完全健康；
- 60Hz以下显示器或捕获源无法产生60fps；
- stats字段可能暂时缺失。

因此“满足60”定义为：

1. sender 已成功应用60fps目标；
2. RTT/loss/jitter 连续健康六个采样周期；
3. 没有持续的实际拥塞证据。

实测 `framesPerSecond` 继续记录和显示，用于诊断，不单独阻塞清晰度升级。

## 4. Sender profile

### 4.1 P2P

- `maxFramerate` 使用 controller 的独立帧率目标。
- `scaleResolutionDownBy` 使用清晰度级别计算。
- `degradationPreference='maintain-framerate'`。
- `getDisplayMedia` fallback 请求最高90fps；实际捕获能力由浏览器和系统决定。

最大码率必须同时考虑分辨率和帧率。初始建议使用60fps基线后按帧率比例缩放：

| 清晰度 | 60fps基线 |
|---|---:|
| 360p | 800kbps |
| 480p | 1.2Mbps |
| 720p | 2.5Mbps |
| 1080p | 5Mbps |
| 2K | 8Mbps |

```text
effectiveMaxBitrate = base60fpsBitrate × frameRateTarget / 60
```

因此2K90的发送上限为12Mbps。该值是初始工程上限，真实环境复测后可调整。

### 4.2 TURN

TURN不进入上述计算，始终使用独立常量：

```text
640×360 / 5fps / 240kbps
```

## 5. 自适应顺序

### 5.1 升级

按确认后的内部状态表逐项升级，每次只前进一步。为避免七级导致恢复过慢：

- 480p30到1080p60的普通台阶：连续三个健康样本（约6秒）。
- 2K60与2K90高成本台阶：连续六个健康样本（约12秒）。
- 每次动作后重新开始稳定计数。

按已确认的七级状态，从最低到最高约需48秒，而不是原方案每级12秒产生的72秒。

### 5.2 降级

普通拥塞连续两个样本后执行一个动作，严重拥塞可立即进入安全状态。

普通拥塞沿内部状态表反向退一级；严重拥塞可以直接回到480p30。这样既可快速稳定，也避免单次跨越过多状态。

严重 RTT/loss/jitter 或连接失败可直接进入 `480p30`；TURN直接进入relay profile。

## 6. `availableOutgoingBitrate`

它仍然是辅助信号，不是测速结果：

- 单独偏低不触发降级；
- 与 `qualityLimitationReason='bandwidth'` 同时出现时，可以延长健康升级的观察窗口；
- 不得因低发送上限反馈出的低估算值产生自锁；
- P2P处于最低状态且主要健康指标恢复后，必须允许一次恢复试探。

主要拥塞真相仍来自connection、RTT、loss和jitter。

## 7. 诊断

档位变化记录：

- `qualityLevel`
- `frameRateTarget`
- `decisionReason`
- `healthTarget`
- `bandwidthLevel`
- RTT/loss/jitter
- `availableOutgoingBitrate`
- `qualityLimitationReason`
- 实际 outbound bitrate/fps

原因枚举至少区分 `relay`、`hard-degrade`、`congestion-step-down`、`recovery-probe`、`frame-rate-upgrade`、`quality-upgrade` 和 `stable`。

## 8. 兼容性与风险

- `MediaStatus.qualityLevel` 继续只表示清晰度级别；无需修改server payload。
- 远端UI已经显示实测fps，不必新增帧率目标协议字段。
- 90fps依赖屏幕刷新率、Electron/Chromium捕获和设备编码性能，属于上限而非保证。
- 2K90上限12Mbps可能增加P2P端CPU、GPU和上行压力；自动控制器必须慢速升级并保留快速回退。
- 若双维状态机效果不佳，可以回滚P2P controller；TURN独立profile和AOB软信号修复必须保留。
