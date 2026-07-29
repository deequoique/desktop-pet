# 通话可靠性与低带宽视频总体设计

## Architecture

父任务不直接修改代码，负责两个 child 的边界与最终集成：

```text
主通话（两条 controller ↔ peer pet）
  ├─ screen
  ├─ microphone
  └─ system audio

camera 通话（一条 controller ↔ controller）
  ├─ A camera → B
  └─ B camera → A

selected ICE route
  ├─ P2P → normal profile
  └─ relay → audio priority + screen low + camera low
```

`07-28-bidirectional-call-camera` 拥有通话生命周期、camera 合同、sender/track 和 UI。`07-28-turn-low-bandwidth-video` 拥有 route profile、视频编码参数、TURN 容量与强制 relay 验收。

## Dependency and Integration

- Camera child 先提供对称 sender 和分离的 local/remote state。
- TURN child 的 screen 代码可独立开发；camera 代码在对称 sender 落地后接入。
- IPv4 诊断任务独立记录 candidate 与 selected pair；其人工实验应使用两个产品 child 集成后的同一版本。

## Shared Invariants

- Route 未知时不发送未限速视频；先靠音频/ICE 建连，识别 selected pair 后再应用 profile。
- Track capture ownership 不随 route 改变；切换 profile 不重新 `getUserMedia()`/`getDisplayMedia()`。
- 用户 camera desired 为 false 时，任何 route change 都不能 attach track。
- Camera failure 独立；主通话失败按既有恢复策略处理。
- 编码参数应用失败时 fail closed：relay 保留音频并提示视频降级失败，不允许无上限视频进入 TURN。

## Rollback

- 双向 camera 可单独关闭，保留双向屏幕/音频。
- TURN low video 可回滚为 relay audio-only，不改 ICE 配置和 coturn 凭据。
- 两个回滚路径都不需要服务端数据迁移。
