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

## Risky Files and Rollback Points

- `pet/src/main/trtc-preload-bridge.js`：主要并发/资源风险；先落 session generation + tests，再接 native PCM。
- `pet/native/windows-process-loopback/`：隐私和稳定性边界；POC 与 helper kill switch 是首要回滚点。
- `server/src/index.js`：凭据边界；任何 role/TTL 测试失败不得部署。
- `web/src/App.tsx`：状态漂移风险；每个状态必须能追到 bridge 的独立 userId。
- `pet/package.json` / release workflow：缺 helper 的安装包必须 fail build，不能运行时才发现。

## Before `task.py start`

- [x] PRD convergence pass 完成且无 resolved/duplicate Open Question。
- [x] 用户审阅并批准 `prd.md`、`design.md`、`implement.md`。
- [x] `implement.jsonl` 与 `check.jsonl` 已替换 seed row，包含真实 spec/research context。
- [x] 任务在 planning 状态获得明确批准后才运行 `python3 .trellis/scripts/task.py start ...`。
