# TRTC 游戏共享评估实施计划（草案）

## 独立前置修复（已完成）

- 2026-08-12 已移除 camera 自动预热，改用 `cameraDesired` 双向意图信令按需创建固定 offerer 的 camera transport。
- 双方 desired 均为 false 时立即释放 camera PC、ICE/TURN、候选、远端 stream、诊断和异步初始化；重开重新请求 RTC config 并建链。
- 已补 server 信令转发与 web source 生命周期回归测试，并通过 server/pet tests、web build 与 pet build。
- 本修复没有接入 TRTC，也没有改变主屏幕与系统声音媒体链路。

## Phase 1：账户与无代码验证

当前状态：已确认进入 TRTC POC，并已创建独立中国站 `SDKAppID=1600157176`。两个测试 UserID 的临时 UserSig 已由用户在控制台生成，签名不进入聊天、renderer、仓库或诊断。官方 Electron SDK 验证版本固定为 `13.3.801`；隔离的官方 Demo 已完成屏幕共享、系统声音、双档位质量统计适配，并已生成 Windows 安装包。当前机器位于新加坡，作为 `poc_sg_viewer` 接收端；中国机器作为 `poc_cn_sender` 发送端。下一步是按 `research/trtc-poc-runbook.md` 完成真实中国→新加坡双端实测。

1. 在腾讯云创建独立 POC SDKAppID，先使用入门版与 10,000 通用分钟，不立即领取或启用 7 天增值体验。
2. 禁用录制、混流、CDN、审核、AI 和含 UI Kit，设置费用预警与预算上限。
3. 使用官方 Electron Demo 在实际两端验证：
   - Windows 游戏窗口采集；
   - 720p30 / 1080p30；
   - 系统声音 loopback；
   - 中国大陆↔新加坡连续 30 分钟。
4. 导出官方质量数据和实际账单用量，先确认 TRTC 本身能满足硬约束。
5. 只有入门版不达标时，再领取 7 天增值体验，使用相同端点、时段、画质和时长重测，隔离“弱网通话卡顿优化”的增量价值。

官方 Electron SDK 已确认具备本阶段所需低层接口：`getScreenCaptureSources`、`selectScreenCaptureTarget`、`startScreenCapture`、`startSystemAudioLoopback`、`onSystemAudioLoopbackError` 与统计回调；详见 `research/trtc-electron-poc-entry.md`。

## Phase 2：最小混合 POC（进行中）

当前状态：项目内接入已完成。Server 已具备 call-scoped UserSig/room/user 签发和 `TRTC_MEDIA_MODE` 权威开关；内置 control preload 已接入 `trtc-electron-sdk@13.3.801`，目标设备发布主屏幕辅流与系统声音，发起设备订阅；摄像头继续按需 WebRTC。Electron 原生加载烟测、server/pet tests、web/pet build、Windows 目录打包和 NSIS 安装器构建已通过。预发布安装器为 `pet/release/Desktop Pet Setup 1.6.2-beta.1.exe`，SHA-256 为 `A1D046BE201B144D3231066C5506EC357537E1014A352D943E5CD59F9DF1E529`。剩余门槛是真实中国目标端→新加坡发起端双机30分钟验证与账单核对。

1. Server 增加短期 UserSig 签发与 call-scoped room/user 权限，并以 `TRTC_MEDIA_MODE` 作为权威媒体模式开关。
2. 在 `control-preload.js` 通过窄桥接加载 Electron native SDK；不修改 renderer 的安全隔离配置。
3. 目标设备的内置 Control 发布屏幕辅流与系统声音，发起设备的 Control 订阅和渲染，保留现有 Socket.IO 业务层。
4. 增加由 Server 权威下发的 `webrtc` / `trtc` 媒体模式开关；不做单端静默 fallback，避免双方进入不同媒体模式。
5. 接入现有诊断：TRTC 房间、首帧、质量、断线、恢复、真实发送/接收参数和成本关联字段。
6. 摄像头继续使用当前独立 WebRTC PC；移除 camera 自动预热并改为按需建链的工作已由独立前置修复完成。
7. camera 生命周期回归测试已由独立前置修复完成；TRTC POC 继续保留这些测试作为回归门槛。

## Phase 3：验证与决策

1. 同条件 A/B：当前 WebRTC 与 TRTC 各运行至少三次 30 分钟。
2. 分别测试 720p30 与 1080p30，记录是否因码率跳档。
3. 核对系统声音、画面帧率、冻结、CPU/GPU、安装包、首帧和恢复。
4. 核对腾讯账单分钟与本任务成本公式。
5. 判断生产版本：
   - 入门版按量；
   - 基础版 625 元/月；
   - 尊享版 1,875 元/月（需要弱网增值能力）；
   - 停止迁移并保留现有 WebRTC。

## Phase 4：可选完整迁移

只有主媒体 POC 通过后，另建任务评估 camera 迁移、两身份合并、旧 coturn 下线和生产灰度。

## 验证与回滚

- Server tests、web build、pet typecheck/test/build、Windows 打包与安装验证。
- 检查 native `.node` 与 macOS/Windows 打包路径。
- 检查 UserSig/secret 不进入 renderer 日志或诊断导出。
- 用诊断确认通话建立但摄像头从未开启时，camera PC、camera ICE 候选和 camera TURN allocation 均不存在。
- 用诊断确认双方摄像头关闭后 camera PC 立即消失，且没有残留 ICE/TURN keepalive 或重连计时器。
- 回滚只关闭 feature flag；不在 POC 中删除当前 WebRTC 代码。
