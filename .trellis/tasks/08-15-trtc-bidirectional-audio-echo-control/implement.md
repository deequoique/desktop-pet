# Implementation Plan

## Phase 0 — Prove Windows 11 API

- [ ] 建立最小 Win32 POC：exclude Electron root process tree，输出 48 kHz stereo s16le PCM。
- [ ] 在 Windows 11 双机上证明“外部应用声音保留、TRTC 远端播放排除”，并记录 TRTC render stream PID 归属。
- [ ] 用 20 ms framing 连续运行 30 分钟，记录 jitter/drop/残留进程；POC gate 未通过不进入完整接入。

## Phase 1 — Server identities and tests

- [x] 在 `server/src/index.js` 增加 target-only system userId/UserSig，保持 call/role/TTL 校验。
- [x] 扩展 `trtc:get-config`：target 只拿 local system credentials；initiator 只拿 remote system userId。
- [x] 更新 `server/test/rooms.test.js`，覆盖互指、不可识别设备 ID、错误角色、stale call、凭据不泄露和 system ID 稳定性。

## Phase 2 — Audio session model and bridge

- [x] 重构 `pet/src/main/trtc-preload-bridge.js` 为 call generation-scoped session，分开 main/system cloud 与 listener/resource ownership。
- [x] main 麦克风改用 `TRTCAudioQualityDefault`，默认不启动；屏幕启动不再隐式启动/混合 main audio。
- [x] 用 `createSubCloud()` 建 system identity；进房前 mute all remote audio，严格 publish-only。
- [x] 提供 source-specific bridge 方法和事件：local mic、remote mic、remote system、system availability/error；所有新通话默认 off。
- [x] macOS system child 接 TRTC native system loopback，并验证核心分源行为。

## Phase 3 — Windows native capture integration

- [x] 在 `pet/native/windows-process-loopback/` 实现 process-loopback exclude helper、版本化 frame protocol、bounded buffering、parent death/pipe close teardown。
- [x] 在 Electron main/control preload 增加窄 root-PID/resource-path 边界；固定路径 `spawn` helper，禁止 shell 和任意路径。
- [x] system child 启用 custom capture，解析/校验 20 ms PCM frame，以正确 PTS 调用 `sendCustomAudioData()`；对 burst/slow consumer 做有界丢帧和诊断。
- [x] 检测 Windows 产品版本/helper/protocol：Windows 10 明确使用 TRTC 旧 full-system loopback；Windows 11 helper 异常时只关闭 system source，不静默降级。
- [ ] 补齐 helper early-exit、capture silence、child enter failure、renderer reload 的专项回归覆盖；malformed frame、hangup race 和 stale callback 已覆盖。

## Phase 4 — UI contracts and independent controls

- [x] 更新 `web/src/api.ts` / `App.tsx` 的 `TrtcConfig`、bridge type、source state 和 call reset。
- [x] initiator 提供两个远端开关并映射到不同 userId；target 只提供 remote mic；全部默认关闭且不持久化。
- [x] source 不支持/失败时显示局部提示，屏幕和其他音源保持可操作。
- [x] 运行正式构建，同步生成的 `web/src/App.js` / `api.js`，不手改 generated JS。

## Phase 5 — Packaging and release

- [x] 增加 Windows helper build script，并接入 `pet/package.json` 的 Windows dist 流程。
- [x] 更新 electron-builder `extraResources`、打包 presence/PE x64 检查和 `.github/workflows/pet-release.yml` 的 Windows native build step。
- [x] 证明 macOS job 不尝试构建/加载 Windows helper，现有 TRTC native asset 仍完整。
- [x] 添加独立 system-audio kill switch 和回滚说明；验证 `TRTC_MEDIA_MODE=webrtc` 不加载 helper/system child。

## Phase 6 — Validation

- [x] 自动化：`npm test --prefix server`。
- [x] 自动化：`npm test --prefix pet`。
- [x] 构建：`npm run build:web`。
- [x] 构建：`npm run build:pet`。
- [ ] Windows：helper unit/protocol tests、Release build、packaged runtime smoke、无残留进程检查。
- [ ] Windows 11↔Windows 11：10 分钟全双工外放/AEC矩阵，30 分钟 system capture 稳定性，四种 remote source 开关组合。
- [ ] Windows 11：外部播放器 + TRTC 人声指纹/录音对照，证明前者上行、后者不回采；不使用耳机代替。
- [ ] Windows↔macOS：双向 mic、单向 system、角色化独立开关和新通话默认 off；macOS 免提 AEC 不设 gate。
- [ ] 故障矩阵：mic permission denied、helper unavailable、Windows 10 旧 loopback 路径、device change、TRTC reconnect、窗口关闭和立即重拨。
- [ ] 计量测试房的第三 identity 音频用量，记录观察值和套餐影响。

## Phase 7 — Explicit same-member device handoff

- [x] 在 `server/src/index.js` 抽取可复用的 call 创建/结束 helper；`call:start` 分类 normal/idempotent/handoff/busy，handoff 只允许同 member 新设备替换当前端点且目标仍是当前对端。
- [x] handoff 预检新设备与对端 pet/controller 完整在线，保留 initiator/target 角色，生成新 call ID；按旧 `call:end(reason:'transferred')` → 新 `call:start` 顺序投递，并返回 `transferred:true`。
- [x] 为所有挂断、媒体控制/状态和信令入口补齐 current call ID + endpoint membership 校验；旧设备迟到事件不能结束或修改新通话。
- [x] 更新 `web/src/api.ts` / `App.tsx` 的 transfer payload、提示和错误码映射；仅点击开始触发接管，旧设备/当前对端显示不同的切换提示，生成 JS 只由正式构建同步。
- [x] 扩展 server 测试：initiator 替换、target 替换与屏幕角色保持；幂等重复；真实 busy；未就绪/错误成员/错误目标拒绝；join/reconnect 不抢占；旧 call 的 end/hangup/signal/status 全部隔离。

## Phase 8 — System-default audio output following

- [x] 在 TRTC preload bridge 的 main instance 进房前调用 `enableFollowingDefaultAudioDevice(TRTCDeviceTypeSpeaker, true)`，连接恢复时对当前 generation 重套；system child 不调用。
- [x] 添加无设备名称的 output-follow available/unavailable 诊断，SDK 调用失败保持主通话和各媒体源运行。
- [x] 扩展 fake SDK 行为测试：Windows/macOS 共用路径、speaker/true 参数、enterRoom 前顺序、reconnect 重套、旧回调隔离及失败不阻断。

## Phase 9 — Handoff/output validation

- [x] 运行 `npm test --prefix server`、`npm test --prefix pet`、`npm run build:web`、`npm run build:pet` 与 `git diff --check`。
- [ ] Windows 与 macOS 分别验证：通话中从系统设置切换内置扬声器、耳机/蓝牙或显示器音频，远端麦克风/系统声音立即跟随，订阅开关不变。
- [ ] 三设备验证：A1↔B 通话中 A2 明确点击开始，1–3 秒内 A1 完整退出、A2↔B 建立新 call；反向替换 target 时新设备承担屏幕/系统声音角色。
- [ ] 故障验证：新设备未就绪时旧通话保持；切换提交后的旧 call 回调/旧设备挂断无效；真实其他通话仍返回清晰 busy 提示。

## Risky Files and Rollback Points

- `pet/src/main/trtc-preload-bridge.js`：主要并发/资源风险；先落 session generation + tests，再接 native PCM。
- `pet/native/windows-process-loopback/`：隐私和稳定性边界；POC 与 helper kill switch 是首要回滚点。
- `server/src/index.js`：凭据边界；任何 role/TTL 测试失败不得部署。
- `web/src/App.tsx`：状态漂移风险；每个状态必须能追到 bridge 的独立 userId。
- `server/src/index.js` / `web/src/api.ts`：handoff 事件顺序与 call ID 权威边界；必须先证明旧 call 事件不能结束新 call，再开放自动接管。
- `pet/src/main/trtc-preload-bridge.js`：默认输出跟随只属于 main playout；不得应用到 publish-only system child，失败不得升级成全通话错误。
- `pet/package.json` / release workflow：缺 helper 的安装包必须 fail build，不能运行时才发现。

## Before `task.py start`

- [x] PRD convergence pass 完成且无 resolved/duplicate Open Question。
- [x] 用户审阅并批准 `prd.md`、`design.md`、`implement.md`。
- [x] `implement.jsonl` 与 `check.jsonl` 已替换 seed row，包含真实 spec/research context。
- [x] 任务在 planning 状态获得明确批准后才运行 `python3 .trellis/scripts/task.py start ...`。
