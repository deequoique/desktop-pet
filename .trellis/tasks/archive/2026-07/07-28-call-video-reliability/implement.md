# 通话可靠性与低带宽视频集成计划

## Ordering

1. 完成并验证 `07-28-bidirectional-call-camera` 的生命周期修复、双向 camera 合同和 P2P 矩阵。
2. 可并行实现 `07-28-turn-low-bandwidth-video` 的 screen profile 与 route 状态。
3. Camera sender 稳定后接入 relay camera low profile。
4. 合并后执行同一版本的 P2P、强制 relay、P2P↔relay 恢复和清理矩阵。
5. 对照 coturn 配额、outbound RTP stats 与服务端网络统计，确认最低清 profile 真正生效。

## Parent Review Gate

- 两个 child 的 PRD、design、implement 均完成收敛和用户审核。
- TURN 最低清的具体分辨率、帧率和每路码率上限已确认。
- Camera child 先于 TURN child 的 camera 接入实施；依赖写在两个 child 文档中。
- 父任务不直接 `task.py start`；分别启动和归档 child，最后执行父级集成复核。

## Final Validation

```bash
npm test --prefix server
npm test --prefix pet
npm run build:web
npm run build:pet
```

手工至少覆盖：

- 正常 IPv6/IPv4 P2P；
- `RTC_ICE_TRANSPORT_POLICY=relay` 强制 TURN；
- 双方 camera 先后/同时开启；
- route 恢复、camera 关闭、权限拒绝、设备丢失与挂断；
- coturn allocation、吞吐、丢包和客户端 outbound RTP 实际画质。
