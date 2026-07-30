# TURN 带宽与动态画质技术设计

## 1. 目标与边界

本任务在不修改 ICE 判路、coturn 认证和 P2P 七级策略的前提下，完成三项互相依赖的改造：

1. TURN screen 从固定 360p5 改为有硬上限的三状态自适应。
2. camera 独立选路；camera 自身走 TURN 时彻底停止视频发送和本地采集。
3. camera 不可用时移除空画面，并把屏幕恢复为唯一主画面。

三项工作共享 `VideoRouteProfile`、`MediaStatus`、`web/src/App.tsx` 的 call teardown 和 RTC diagnostics 生命周期，因此保留为一个任务，按实施阶段分别验证，不拆成会同时修改相同状态所有权的 child task。

Node server 仍只负责信令、配置和状态转发；媒体由 WebRTC 直接或经 coturn 传输。这里的“3 Mbps 服务器出口”指同机 coturn、TTS 和应用控制流量共享的公网出方向峰值。

## 2. 运行时数据流

```text
主通话 controller ↔ peer pet
  ├─ selected pair = P2P
  │    └─ screen 使用现有七状态 P2P controller，最高 2K90
  └─ selected pair = effective relay
       └─ screen 使用独立三状态 TURN controller，最高 720p45

camera controller ↔ controller（独立 RTCPeerConnection）
  ├─ selected pair = P2P
  │    └─ 用户可手动打开 camera，沿现有 camera 五档发送
  ├─ selected pair = effective relay
  │    └─ replaceTrack(null) → stop capture → relay_disabled
  └─ unknown / failed
       └─ 不发送 video，主通话不受影响
```

主通话 selected pair 只决定何时允许 camera 开始后台 ICE 预热，不能代替 camera 自身 selected pair 做发送决策。

## 3. TURN screen 状态机

### 3.1 状态与硬上限

在 `web/src/video-profile.ts` 与 `pet/src/renderer/video-profile.ts` 增加完全镜像的独立常量：

```ts
const SCREEN_RELAY_STATES = [
  { qualityLevel: 2, frameRateTarget: 30 }, // 854×480, 600 kbit/s
  { qualityLevel: 3, frameRateTarget: 30 }, // 1280×720, 1.25 Mbit/s
  { qualityLevel: 3, frameRateTarget: 45 }, // 1280×720, 1.875 Mbit/s
] as const;
```

TURN screen 的分辨率、帧率和码率必须同时被最后一个状态硬封顶。即使调用方错误传入 level 4/5 或 60/90fps，`applyVideoSenderProfile()` 也只能应用不高于 1280×720、45fps、1.875 Mbit/s 的合法 TURN 状态。Camera 的 relay profile 不再是可发送 profile；传入 `profile='relay-low'` 且 `kind='camera'` 时应返回受控失败，作为调用层判断遗漏时的第二道保护。

`quality:'relay-low'` 暂时保留为跨版本 route 标记，避免扩大协议变更；它不再等价于固定 360p5。实际清晰度继续由 `qualityLevel` 表示，目标帧率保留在 sender diagnostics，接收 UI 展示实际接收帧率。

### 3.2 升级

RTC stats 每约 2 秒采样一次：

| 当前状态 | 下一状态 | 基础健康样本 | 约需时间 |
| --- | --- | ---: | ---: |
| 480p30 | 720p30 | 3 | 6 秒 |
| 720p30 | 720p45 | 6 | 12 秒 |

健康判定复用现有 RTT、loss、jitter 条件。`availableOutgoingBitrate` 不作为硬容量门：

- 字段缺失或单独偏低不能永久阻止升级。
- 只有它与 `qualityLimitationReason === 'bandwidth'` 一起表现出压力时，观察窗口加倍。
- 加倍窗口结束后仍允许一次有硬码率上限的恢复试探，避免重新产生低码率自锁。

每次升级只前进一步，并在成功应用 sender profile 后重新计数。

### 3.3 降级

- 普通拥塞连续两个样本后反向退一级：`720p45 → 720p30 → 480p30`。
- `connected === false`，或 RTT ≥ 550ms、loss ≥ 9%、jitter ≥ 180ms 时立即回到 480p30。
- selected pair 变为 unknown/failed 时沿现有 fail-closed 路径暂停 screen video，音频和通话恢复流程继续。
- 不增加 5fps 紧急状态；连接仍成立时最低保持 480p30，连接不可用时才暂停视频。

### 3.4 与 P2P 的隔离

`AdaptiveScreenQualityController` 保存 route mode 和对应状态索引：

- P2P 使用现有 `SCREEN_P2P_STATES`，行为和最高 2K90 不变。
- TURN 使用 `SCREEN_RELAY_STATES`。
- P2P→TURN、TURN→P2P 都重置到各自的 480p30 起点，清空 bad/stable counters。
- route 切换只调用串行 `setParameters()`，不重新执行屏幕采集，不改变用户 screen desired。

Screen 在 P2P 和 TURN 下都使用 `degradationPreference='maintain-framerate'`；画质优先通过 scale 和 bitrate 调整，保持已选择的 30/45fps 目标。

## 4. Camera 生命周期与 TURN 禁用

### 4.1 延迟预热

当前 `onCallStart` 在主通话 offer 发出后立即调用 `beginCameraCall()`。新流程为：

1. `onCallStart` 只保存 `cameraOffererDeviceId` 并启动主通话。
2. 只有本机主 `RTCPeerConnection.connectionState === 'connected'`，且 diagnostics/readRtcRoute 已得到非 unknown/failed 的 selected pair，才把 camera prewarm 标记为 ready。
3. 每个 call ID 只执行一次 `beginCameraCall()`；offerer 创建 camera offer，answerer 准备接收。
4. 在本机 prewarm ready 之前收到的 camera offer/candidate 按原顺序暂存，ready 后再交给现有 camera signal handler。
5. teardown 清除 prewarm ready、started call ID、暂存 signal、camera PC/init promise 和全部 candidate。

这样双方主通话的 selected pair 确认时间即使略有不同，也不会迫使较慢一端提前启动第二套 ICE；camera 初始化或 signal 失败只记录 camera 诊断与不可用状态，不能调用主通话 teardown。

### 4.2 Camera 自身选路

Camera sender 仅在下列条件全部满足时允许 attach：

```text
用户 desired = true
AND camera selected pair = normal/P2P
AND camera track live
AND P2P sender profile 应用成功
```

camera selected pair 为 effective relay 时，执行一个幂等、带 generation guard 的关闭 helper：

1. 将 camera route 标记为 relay blocked。
2. 递增 profile generation，串行等待/淘汰过期 `setParameters()`。
3. `sender.replaceTrack(null)`。
4. stop 本地 camera stream 的全部 track，清空 stream 和本地 preview `srcObject`。
5. 把 `cameraDesiredRef` 与 React `cameraDesired` 都复位为 `false`。
6. 上报 `state:'unavailable'`、`reason:'relay_disabled'`，不带 relay quality/level。

Camera route 后续恢复 P2P 时，只移除 blocked 状态并提示“已恢复 P2P，可手动打开摄像头”；不得自动调用 `getUserMedia()`。这样既释放硬件，也避免网络恢复后未经用户操作自动重新启用摄像头。

如果主屏幕走 TURN、camera 自身走 P2P，camera 保持现有发送能力；反之也分别决策。Camera route unknown/failed 时继续 fail closed，但不得影响 screen、microphone、system audio 或主通话 ICE restart。

## 5. MediaStatus 与兼容性

`MediaStatus.reason` 新增：

```ts
type MediaStatusReason =
  | 'controller_disabled'
  | 'capture_failed'
  | 'permission_denied'
  | 'device_lost'
  | 'track_ended'
  | 'profile_failed'
  | 'relay_disabled';
```

同步位置：

- `web/src/api.ts` 类型；
- `server/src/index.js` allowlist；
- `server/test/rooms.test.js` 定向转发与伪造 source 测试；
- `.trellis/spec/desktop-pet/shared/webrtc-networking-and-deployment.md` 契约。

Server 继续从认证 socket 注入 camera `sourceDeviceId`，不能信任客户端字段。旧 server 会丢弃未知 reason 但仍转发 `unavailable` state，因此安全行为保持，只缺少解释文案；新 client/server 组合提供完整原因。

## 6. 控制面板 UI

### 6.1 远端媒体舞台

Camera surface 的挂载条件改为：

```tsx
remoteCameraAvailable && !cameraHidden
```

而不是当前只有 `!cameraHidden`。状态矩阵：

| remote camera 状态 | Camera surface | Screen 布局 |
| --- | --- | --- |
| available 且未隐藏 | 显示 | 按 primary/inset 偏好布局 |
| unavailable / paused / track ended | 不挂载 | screen 自动成为唯一主画面 |
| relay_disabled | 不挂载 | screen 自动成为唯一主画面 |
| available 但用户隐藏 | 不挂载 | screen 保持主画面 |

隐藏和交换按钮仍只在 remote camera available 时显示。浮窗复用同一个 `mediaStage`，因此同时修复嵌入页和系统浮窗，不增加第二套布局状态。

### 6.2 本地 camera 卡片

增加 camera route readiness 的可视状态：

- 检测中/失败：说明 camera 网络路径尚不可用，不启动采集。
- P2P：允许“打开摄像头”。
- TURN：按钮不可开启，显示“摄像头通道使用 TURN，为保证屏幕和声音已关闭”。
- TURN→P2P：显示一次提示，按钮恢复可用，但保持 camera desired 为 false。

收到远端 `relay_disabled` 时给出受控提示，不把它显示为权限、设备或 profile 错误。

## 7. 诊断

现有 2 秒 stats 采样和约 10 秒持久化频率不变。`webrtc.quality-changed` 对 TURN screen 继续记录：

- `effectiveRelayed`
- `qualityLevel`
- `frameRateTarget`
- `healthTargetLevel`
- `bandwidthLevel`
- decision reason
- RTT/loss/jitter
- `availableOutgoingBitrate`
- outbound bitrate/fps
- `qualityLimitationReason`

Camera TURN 禁用增加一次有 call ID 的结构化事件，例如 `webrtc.camera-relay-disabled`，并保留 camera diagnostics 的 selected pair。路由恢复只记录可手动恢复，不记录或触发自动采集。

不新增自动上传，不记录 SDP、原始 candidate、secret 或 credential；用户导出的诊断包应能还原 screen 档位变化和 camera 被禁用的原因。

## 8. 容量与运行约束

最高 TURN 状态的 sender screen cap 为 1.875 Mbps。加双向 64 kbit/s audio 后再按 20% 预留协议、重传、TTS 和控制突发：

```text
(1.875 + 0.064 + 0.064) × 1.2 ≈ 2.404 Mbps
```

在 3 Mbps 峰值下保留约 0.596 Mbps。该预算只保证单场双人通话；没有 coturn 总出口遥测时，客户端不能安全协调多场并发，因此多通话全局调度保持 out of scope。

## 9. 风险、兼容与回滚

- 3 Mbps 是峰值而非 SLA，720p45 必须可快速退回 720p30/480p30。
- `maxBitrate` 是 sender cap，不是实际保证值；真实画质仍受捕获源、编码器和链路影响。
- Camera signal 延迟队列必须有 call ID/generation guard，避免旧 call 的 offer/candidate 污染新 call。
- Camera relay disable 必须先 detach 再 stop，避免 sender 短暂持有 ended track。
- Web 手写 TS 和构建生成 JS 必须同步；禁止直接修改 `web/src/*.js`。
- 无持久数据迁移。若 TURN 自适应异常，可把 relay state table 回滚为单一 480p30 或旧 360p5；camera relay fail-closed 和手动恢复隐私边界可以独立保留。

