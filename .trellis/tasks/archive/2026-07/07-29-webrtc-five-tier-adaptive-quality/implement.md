# WebRTC 五档自适应实施计划

## Phase 1：采样与路径真相

- 扩展 web/pet `rtc-diagnostics` 的 compact RTP sample、周期 polling、有效 relay 判定和有界日志。
- 将 600/701 candidate error 降为 warn，消除 incident 写入风暴。
- 让 controller UI 与 pet sender 使用同一 effective relay 语义。

## Phase 2：五档 sender

- 在两份 `video-profile` 定义五档参数、纯判级函数和带防抖的 controller。
- 接入 pet screen sender 与 controller camera sender；保持现有串行 profile mutation 和 generation guard。
- 档位变化上报 compact 诊断并通过 media status 通知观看端。

## Phase 3：UI 与 server contract

- 扩展 `MediaStatus.qualityLevel` 生产、server 校验转发和 web 消费。
- 通话 UI 展示路径、RTT、网络等级、档位、接收码率/fps；浮窗保持纯媒体。
- 更新 CSS 与 source regression tests。

## Phase 4：部署防错

- 强化 coturn verify 对 external-ip、relay-ip 与 min/max port 的检查。
- 更新部署文档的现场检查和伪 P2P 识别说明。

## Validation

```bash
npm test --prefix server
npm test --prefix pet
npm run build:web
npm run build:pet
bash -n server/deploy/install-coturn-ubuntu.sh
```

补充纯函数测试覆盖五档参数、effective relay、降档/升档防抖和 compact stats；server 测试覆盖 qualityLevel 转发/拒绝。

## Manual Gate

- 真实 IPv4 P2P：观察 RTT、码率/fps与逐档升降。
- `RTC_ICE_TRANSPORT_POLICY=relay`：始终 1 档、音频连续。
- 使用本次 `prflx + relayProtocol` 形态：UI 必须显示 TURN。
- 注入带宽/丢包或切换网络：快速降档、慢速恢复，无反复重捕获。

## Rollback

- 自适应 controller 可回滚为固定 route profile，不改变信令和媒体 ownership。
- `qualityLevel` 是可选字段，可独立回滚。
- coturn verify 只读检查，不改变安装/回滚行为。
