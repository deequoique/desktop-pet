# TURN 低带宽屏幕与摄像头视频

## Goal

将 TURN relay 从仅音频改为受限最低画质的视频模式：优先保证语音，同时让双方仍能看到低清屏幕共享和各自已开启的远端摄像头。

## Background

- Pet 当前只有 `screenRouteIsP2P` 布尔值；relay 时直接把 screen track disabled，并上报 `paused/relay_audio_only`（`pet/src/renderer/main.ts:1754-1755`, `pet/src/renderer/main.ts:1850-1863`）。
- Camera 当前 relay 时使用 `replaceTrack(null)` 并上报 `paused/relay_audio_only`（`web/src/App.tsx:718-730`）。
- 屏幕捕获通常为 1280×720 到 2560×1440 或 1600×900@15fps（`pet/src/renderer/main.ts:1973-2019`）；camera 为 1280×720、15–24fps（`web/src/App.tsx:753-760`），不能原样放入 TURN。
- 现有代码只对 audio sender 设置约 64 kbit/s 上限，没有 video sender profile（`pet/src/renderer/main.ts:1879-1887`）。
- coturn 默认 `max-bps=64000` bytes/s（约 512 kbit/s/会话）、`bps-capacity=250000` bytes/s（约 2 Mbit/s 总容量），每用户最多 4 个 allocation、总计 8 个，原设计面向一组两人音频兜底（`docs/ubuntu-coturn-deployment.md:52`）。
- 用户已决定 relay 下继续传输最低清屏幕和双向摄像头，而不是保持纯音频。

## Requirements

### R1. Route-specific Profile

- 只有 selected candidate pair 明确为 relay 时使用 `relay-low`；P2P 使用 normal profile，未知/失败状态不得发送未限速视频。
- Route 变化必须幂等地更新所有 outbound video sender，并保留用户 screen/camera desired。
- P2P↔relay 切换不重新捕获媒体、不重新请求权限、不重复协商普通 track 开关。

### R2. Relay Screen

- Relay 下 screen track 在用户允许共享且捕获正常时保持 enabled，不再上报 `relay_audio_only`。
- Screen sender 的 relay-low 上限固定为 640×360、5fps、240 kbit/s，并按捕获尺寸计算 `scaleResolutionDownBy`，以屏幕文字勉强可辨为优先。
- P2P 恢复后撤销 relay 限制并恢复 normal profile；用户手动关闭 screen 时任何 route 都不得发送。

### R3. Relay Camera

- 双方本机 camera desired 为 true 时，relay 下仍 attach 各自 track，但应用独立的 camera low profile。
- 每路 camera 的 relay-low 上限固定为 320×180、10fps、120 kbit/s，以人物动作基本连续为优先。
- 本 requirement 的实现依赖 `.trellis/tasks/07-28-bidirectional-call-camera/` 先提供双向 sender 与分离的 local desired。

### R4. Audio Priority and Fail-closed

- 保留现有麦克风/系统声音 sender 上限，视频必须在 coturn 当前单 allocation 与总容量边界内给音频留出余量。
- `setParameters()`、route inspection 或 profile 应用失败时，relay 禁用对应视频并继续音频；不得无上限发送视频。
- Congestion、packet loss 或 RTT 升高时允许 WebRTC 进一步降码率，但不能超过配置上限。

### R5. Status and Diagnostics

- UI 将 `TURN 音频兜底` 改为 `TURN 低清视频`，并分别显示 screen/camera 处于低清还是不可用。
- Media status 增加机器可读的 `quality: 'normal' | 'relay-low'`（或等价字段），不能把可用低清视频伪装成 paused。
- 强制 relay 验收记录 selected pair、outbound RTP 实际 frameWidth/frameHeight/fps/bytesSent、packet loss/RTT 与 coturn 吞吐。

### R6. Deployment Capacity

- 对照现有 coturn `max-bps`、`bps-capacity`、allocation quota 验证单组两人通话；只有实测无法容纳批准 profile 时才调整默认配额。
- 若调整部署脚本或文档，必须明确单位是 bytes/s 还是 bits/s，并保留 3 Mbps 小实例的容量余量。
- 不取消配额，不把 TURN 改为不受控视频中继。

## Acceptance Criteria

- [ ] 强制 relay 时双方音频连续可懂，双方都能看到对方低清屏幕；已开启 camera 时也能互相看到低清 camera。
- [ ] Outbound RTP stats 证明 screen 不超过 640×360、5fps、240 kbit/s，每路 camera 不超过 320×180、10fps、120 kbit/s，而不是只靠 UI 文案判断。
- [ ] Relay 视频总负载在 coturn 当前或明确更新后的单会话/总容量内，不出现持续限流、allocation 失败或音频断续。
- [ ] P2P 使用 normal profile；P2P↔relay 切换不弹权限、不重捕获、不自动打开用户关闭的 camera。
- [ ] Profile 应用失败时对应视频 fail closed，音频继续且 UI 显示明确原因。
- [ ] Server/pet 测试、web/pet 构建、强制 relay 与恢复矩阵通过。

## Out of Scope

- 多档自适应 simulcast/SVC、多人容量或高清 TURN。
- 自动扩容 coturn、按流量计费或全局带宽调度器。
- 改变双方只能控制自己摄像头的规则。
