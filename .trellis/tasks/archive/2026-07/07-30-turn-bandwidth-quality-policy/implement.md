# TURN 带宽与动态画质实施记录

> 用户已明确批准执行；实现与自动验证已于 2026-07-30 完成。真实双机/腾讯云带宽验收仍需在用户环境中执行。

## 1. 实施顺序

### Phase 1：先固化测试与契约

1. 扩展 `pet/test/video-profile.test.cjs`，同时加载 web/pet 两份 profile，先定义：
   - `480p30 → 720p30 → 720p45` TURN 状态表；
   - 3/6 个健康样本升级；
   - bandwidth 软压力只延长窗口、不会永久自锁；
   - 两个普通坏样本逐级回退、严重样本立即回 480p30；
   - P2P↔TURN route 切换重置到各自 480p30；
   - TURN 请求 level 4/5 或 60/90fps 仍被硬封顶；
   - camera relay profile 不能应用，P2P camera 五档不变；
   - TURN screen 使用 `maintain-framerate`。
2. 扩展 `pet/test/media-main.test.cjs` 的 source regression：
   - camera prewarm 受主 connection + selected pair gate 控制；
   - early camera signal 被暂存并有 call ID guard；
   - camera relay 路径包含 `replaceTrack(null)`、stop capture、desired=false 与 `relay_disabled`；
   - route 恢复不调用 `getUserMedia()`；
   - camera surface 只在 `remoteCameraAvailable && !cameraHidden` 时挂载。
3. 扩展 `server/test/rooms.test.js`：
   - `relay_disabled` 只转发给当前 call 的另一 controller；
   - server 覆盖伪造的 `sourceDeviceId`；
   - wrong role、stale call、第三设备和其他 room 不能泄漏；
   - 原有 reason/quality/qualityLevel 兼容不变。

### Phase 2：实现镜像 screen 策略

同步修改：

- `web/src/video-profile.ts`
- `pet/src/renderer/video-profile.ts`

实施内容：

1. 新增 `SCREEN_RELAY_STATES` 和 route-aware screen state controller。
2. P2P 七状态与阈值保持不变；TURN 使用独立 state index、升级窗口和硬上限。
3. Refactor relay screen limit 计算，按分辨率与目标 fps 计算 600k/1.25m/1.875m。
4. `availableOutgoingBitrate` 只影响观察窗口；不作为单独降级或永久升级门槛。
5. Screen 两种 route 均设置 `degradationPreference='maintain-framerate'`。
6. Camera relay 参数应用返回受控失败，防止调用层遗漏后发送低清 TURN camera。
7. 完成后用 `diff -u web/src/video-profile.ts pet/src/renderer/video-profile.ts` 确认镜像完全一致。

### Phase 3：Pet screen sender 接入

复用 `pet/src/renderer/main.ts` 现有的 route-aware controller 接入点，无需修改该文件：

1. `handleScreenNetworkSample()` 把 effective relay 交给新的 TURN state controller，而不是固定 1档/5fps。
2. `applyRequestedScreenState()` 保留 generation guard、串行 `setParameters()`、screen desired 和 fail-closed 行为。
3. Route 变化只重新应用 profile，不重新采集 screen track。
4. `webrtc.quality-changed` 记录 TURN state、目标 fps、软带宽判断、实际发送码率/fps和退档原因。
5. 保持 audio sender 64 kbit/s cap、主通话恢复和 15 秒 ICE restart 超时不变。

### Phase 4：Camera 延迟预热与 relay fail-closed

修改 `web/src/App.tsx`：

1. 增加 call-scoped camera prewarm ready/started/signal queue refs，并在 `teardownCall()` 完整清理。
2. `onCallStart` 只保存 offerer metadata 并启动 main call。
3. 主 PC connected 且 selected pair 明确后，幂等启动 camera prewarm并flush early signals。
4. `handleCameraSignal()` 在 prewarm ready 前只暂存；所有异步 continuation 继续检查 call ID 与 PC identity。
5. 抽取幂等的 local camera capture cleanup，供用户关闭、设备丢失、teardown 和 relay disable 复用。
6. Camera selected pair 为 relay 时：
   - detach sender；
   - stop/clear capture与preview；
   - reset desired；
   - 上报 `unavailable/relay_disabled`；
   - 记录结构化诊断；
   - 不调用主通话 teardown。
7. Camera route 恢复 P2P 时仅解除 blocked UI 并提示手动打开，不自动采集。
8. Camera P2P 继续使用现有五档 controller和双方 `sendrecv` sender。

### Phase 5：协议、UI 与生成文件

1. 修改 `web/src/api.ts` 的 `MediaStatus.reason`，加入 `relay_disabled`。
2. 修改 `server/src/index.js` reason allowlist，保留当前 call/role/device 路由边界。
3. 修改 `web/src/App.tsx`：
   - camera surface 挂载条件改为 remote available 且未隐藏；
   - unavailable/relay_disabled/track ended 时 screen 自动成为主画面；
   - 本地 camera 卡片显示检测中、P2P ready、TURN blocked；
   - TURN blocked 时不允许开启硬件；
   - 远端 relay disabled 使用独立受控提示。
4. 运行 web build 生成并核对 `web/src/App.js`、`web/src/api.js`、`web/src/video-profile.js`；不手改生成文件。
5. 更新 `.trellis/spec/desktop-pet/shared/webrtc-networking-and-deployment.md`：
   - TURN 三状态 screen；
   - camera relay disabled；
   - camera prewarm gate；
   - `relay_disabled` 契约和验证矩阵；
   - 删除“TURN固定360p5/camera低清发送”的旧契约。

## 2. 自动验证

按顺序执行：

```bash
npm test --prefix pet
npm test --prefix server
npm run build:web
npm run build:pet
diff -u web/src/video-profile.ts pet/src/renderer/video-profile.ts
git diff --check
```

验收自动检查：

- 两份 profile 镜像一致；
- server reason/source/routing 契约通过真实 Socket.IO integration；
- web TS 与生成 JS 同步；
- pet renderer typecheck/build 通过；
- 没有新增 lint 覆盖声明，因为仓库当前没有对应 lint script。

## 3. 双机与真实服务器验证

### 3.1 强制 relay

临时使用 `RTC_ICE_TRANSPORT_POLICY=relay` 的验收环境，不改生产默认 `all`：

1. 双方连接后确认主 selected pair 为 effective relay。
2. Screen 从 480p30 开始；健康约6秒达到720p30，再健康约12秒试探720p45。
3. 客户端 UI/诊断确认目标档位、实际接收fps和实际码率；腾讯云监控确认公网出带宽不持续超过约2.4 Mbps预算。
4. 双向说话并播放系统声音，确认720p45试探和退档期间音频连续。
5. 人为限速/丢包，确认普通退档为720p45→720p30→480p30，严重恶化直接到480p30或连接失败时暂停video。

### 3.2 Camera

1. Camera PC 为P2P时，双方都能手动打开、关闭并看到远端画面。
2. Camera PC 为TURN时，sender无video track、本机硬件指示灯熄灭、preview清空，双方状态为`relay_disabled`。
3. 主screen为TURN而camera为P2P的环境下，camera仍允许发送；验证两套selected pair分别记录。
4. Camera TURN→P2P后只提示手动打开，等待期间不自动调用硬件。
5. Camera permission denied、device lost和profile failed仍使用原有原因，且不结束主通话。

### 3.3 UI 与诊断

1. 对方camera未开启、关闭、TURN禁用或track ended时没有空camera窗口，screen自动占满。
2. Camera重新available后按用户hidden偏好显示；交换/隐藏按钮只在available时出现。
3. 嵌入页和系统浮窗行为一致。
4. 用户主动导出的诊断包能找到：
   - main与camera各自selected pair；
   - TURN screen每次quality/fps变更及原因；
   - 实际inbound/outbound bitrate/fps；
   - camera relay disabled与后续P2P恢复但未自动采集。

### 3.4 P2P回归

1. IPv4 P2P与IPv6 P2P仍沿现有七状态最高试探2K90。
2. 主通话offer/answer、candidate暂存、一次ICE restart、15秒恢复超时和hangup清理不变。
3. Screen route切换不重新capture；camera预热失败不影响screen/audio。

## 4. 风险文件与回滚点

| 风险点 | 文件 | 控制与回滚 |
| --- | --- | --- |
| 两套profile漂移 | `web/src/video-profile.ts`、`pet/src/renderer/video-profile.ts` | 同一测试加载两份模块并执行diff；可回滚TURN state数组 |
| 过期camera signal污染新call | `web/src/App.tsx` | call ID、PC identity、prewarm generation与teardown queue清理 |
| Relay route瞬间仍发送camera | `web/src/App.tsx` | 串行profile chain；先replaceTrack(null)再stop；防御性拒绝camera relay profile |
| UI状态与ref分叉 | `web/src/App.tsx` | relay helper同时更新desired ref/state、route UI state和status |
| 旧server丢弃新reason | `server/src/index.js` | state仍为unavailable并安全关闭；升级server后恢复解释文案 |
| 720p45挤压峰值 | video profile与真实服务器 | 1.875 Mbps硬cap、两级快速回退、20%总预算和腾讯云实测 |

无数据库或本地持久化迁移。若现场验证发现峰值带宽不足，第一回滚项是移除720p45试探、保留480p30/720p30；若仍不稳定，再把TURN screen临时固定为480p30。Camera relay fail-closed和不自动恢复硬件不随画质回滚撤销。

## 5. 启动前检查

- [x] 用户已审阅并明确批准 `prd.md`、`design.md`、`implement.md`。
- [x] 任务保持单任务 inline 实施，不需要jsonl dispatch清单。
- [x] 开发开始时加载 `trellis-before-dev`，重新读取前端、共享WebRTC和诊断规范。
- [x] `task.py start` 只在用户批准后执行。

## 6. 实施结果

- TURN screen 已改为 `480p30 → 720p30 → 720p45`，最高 sender cap 为 1.875 Mbps。
- 健康升级窗口为 3/6 个样本；带宽软压力只延长窗口。轻度拥塞连续两个样本逐状态回退，严重拥塞立即回 480p30。
- P2P 七状态保持独立，最高仍为 2K90；web/pet profile 已确认完全镜像。
- Camera ICE 延迟到主通话 connected 且 selected pair 明确后预热；早到信令按 call 暂存。
- Camera 自身走 TURN 时 detach sender、停止采集、复位 desired，并上报 `relay_disabled`；恢复 P2P 后仅允许用户手动重开。
- Camera 不可用时不再挂载空白远端画面。
- 自动验证通过：pet 49 项、server 19 项、web build、pet typecheck/build、镜像 diff 与 `git diff --check`。
