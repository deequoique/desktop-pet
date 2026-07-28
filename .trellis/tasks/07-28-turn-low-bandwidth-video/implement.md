# TURN 低带宽视频实施计划

## Phase 1：Profile 基础

1. 读取 pet renderer、web、shared WebRTC 与部署规范。
2. 为 screen/camera 定义 normal 与固定 relay-low 常量（screen 640×360/5fps/240 kbit/s；camera 320×180/10fps/120 kbit/s）和同构 sender profile helper。
3. 为 scale 计算、参数保留、单位换算、normal 恢复与 fail-closed 补单元测试。

## Phase 2：Screen Relay Low

1. Pet 保存 screen sender，并把 P2P 布尔状态升级为 route profile。
2. Relay 下先应用 screen low 参数再启用 track；P2P 恢复 normal。
3. 用户 screen desired、capture ended、ICE recovery 与 cleanup 继续正确合并。
4. Screen status 上报 available + quality，而不是 paused/audio-only。

## Phase 3：Camera Relay Low

前置依赖：`07-28-bidirectional-call-camera` 已提供双方 camera sender/local desired/track。

1. 将 camera route 切换接到统一 profile 状态。
2. Relay 下按本机 desired 应用 camera low 并 attach track。
3. P2P 恢复 normal；unknown/failed fail closed但保留本地 preview。
4. 任一方关闭 camera 后 route change 不得自动重新 attach。

## Phase 4：Contracts and UI

1. 扩展 server/web media status quality allowlist 与类型副本。
2. 更新路由与媒体文案为 `TURN 低清视频`，分别标识 screen/camera。
3. 更新部署、coturn 验收与 troubleshooting 文档，修正旧的“relay 仅音频”说明。
4. 通过 build 生成 tracked JavaScript，不手改生成文件。

## Phase 5：Validation

```bash
npm test --prefix server
npm test --prefix pet
npm run build:web
npm run build:pet
```

强制 relay 手工验证：

1. 双方 screen + microphone/system audio，持续 10 分钟。
2. 再开启双方 camera，持续 10 分钟。
3. 导出 outbound/inbound RTP stats 与 coturn/主机吞吐。
4. 核对实际 frame size、fps、bitrate、packet loss、RTT、audio concealment 与 allocation。
5. 恢复 policy=all，验证 P2P normal profile 与 route transition。

## Review Gate

- 固定最低清 screen/camera 参数已由用户确认。
- Camera child 的依赖已满足后才开始 Phase 3。
- 若实测需要修改 coturn 配额，先回到 planning 更新容量依据与回滚点。

## Rollback

- 单个 sender profile 失败只禁用该视频，不结束通话。
- 整体回滚恢复 relay audio-only，保留 P2P 与 camera 双向能力。
