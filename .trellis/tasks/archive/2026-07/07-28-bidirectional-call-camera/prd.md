# 修复双向通话并支持双向摄像头

## Goal

恢复双方稳定接收对方屏幕/音频，并把 v1.6.0 的单向摄像头扩展为对称能力：A、B 都可以开启自己的摄像头、在本机预览，并在同一通话中看到对方摄像头。

## Background

- 当前主通话本来由两条对称关系组成：每个 controller 向对方 pet 发 offer，接收对方屏幕、麦克风与系统声音；server 只转发 SDP/ICE（`server/src/index.js:1100-1111`）。
- v1.6.0 出现确定性生命周期回归。被呼叫方收到 `call:start` 后会把 `isCameraSender` 从 `false` 切为 `true`（`web/src/App.tsx:971-979`）；该状态是 listener effect 依赖，而 effect cleanup 会执行 `teardownCall()`（`web/src/App.tsx:1018-1022`），从而清空被呼叫方刚创建的主 PeerConnection、camera PeerConnection 与 `callId`。这解释了“A 能看见 B、B 看不见 A”以及摄像头控制失效。
- 现有 camera 连接是单向 controller↔controller PeerConnection：发起方固定 `recvonly` offer，被呼叫方设为 `sendonly` answer，并且 server 只接受被呼叫方 camera status（`web/src/App.tsx:792-881`, `server/src/index.js:1113-1122`, `server/src/index.js:1171-1198`）。
- 现有 camera state 只有一份 `cameraDesired`/`cameraStatus`，无法同时表达“我的摄像头”和“对方摄像头”。
- Electron 媒体权限已经限定到 pet/control 受信窗口（`pet/src/main/index.js:384-391`），macOS 已声明摄像头与麦克风用途（`pet/package.json:60-61`）。
- 每次通话摄像头默认关闭；现有实现首次开启才调用 `getUserMedia()`，关闭会 `replaceTrack(null)`、停止 track 并释放硬件（`web/src/App.tsx:731-790`）。

## Requirements

### R1. 修复通话生命周期

- Listener 注册/注销与媒体资源 teardown 必须分离；React handler、角色或设备状态变化不得结束活跃通话。
- 真正卸载、显式结束、`call:end`/hangup、对端离线或恢复超时仍执行完整清理。
- 主通话与 camera 初始化的异步步骤必须校验当前 `callId`，旧 call 的延迟结果不能污染新 call。

### R2. 对称摄像头媒体

- A、B 各自拥有独立的 local camera desired/status、`MediaStreamTrack`、本地预览和 sender。
- A、B 各自拥有独立的 remote camera status、远端 stream 和 `<video>`。
- Camera 仍使用 controller↔controller 的独立 PeerConnection，与屏幕/音频主连接隔离；任一摄像头失败不能挂断主通话。
- 初始协商建立双向 video transceiver；双方后续开关使用各自 sender 的 `replaceTrack()`，不得因普通开关重复协商。

### R3. 摄像头默认与权限

- 每次通话开始时双方摄像头默认关闭，不因上次通话状态自动开启。
- 每一方只能打开、关闭和切换自己的摄像头；对方只能接收状态与画面，不能通过 server 命令控制本机摄像头。
- 首次主动开启自己的摄像头时才申请本机权限；拒绝或无设备只影响本地方向，并把可理解状态同步给对方。
- 双方各自记住上次选择的本机摄像头设备；设备丢失时回退到默认设备并提示。
- 关闭自己的摄像头必须先从 sender 移除 track，再停止采集并释放硬件。

### R4. 双方 UI

- 双方控制面板都显示“我的摄像头”预览与设备选择；本地预览收起不停止发送。
- 双方媒体舞台都显示对方屏幕和对方摄像头，支持现有主次交换、隐藏、自动顶替和系统浮窗。
- 控件和状态必须明确区分“我的摄像头”与“对方摄像头”，不能用同一 `cameraDesired`/`cameraStatus` 混合表达。
- 系统浮窗只展示远端媒体，不展示本地预览。

### R5. 状态、隔离与清理

- Server 接受当前 call 中任一 controller 的 camera status，并只转发给另一个 controller；payload 必须能识别来源设备。
- `webrtc:media-control` 只保留远端 screen 控制；camera 不再是可远程控制的 media 类型，旧客户端发送 camera control 必须被拒绝且不得启动硬件。
- 权限拒绝、设备断开、capture failure、camera ICE failure 或对方关闭摄像头时，屏幕和音频继续。
- 挂断、断线、renderer 销毁或应用退出时，双方 camera track、stream、sender、PeerConnection、candidate queue、listener 与 timer 全部清理。
- 旧客户端不能理解双向 camera 时不得破坏主屏幕/音频通话；发布说明继续要求 server 与双方客户端同步升级。

### R6. 任务依赖

- 本 child 可以独立实现和验证。
- 本任务负责双向 camera 协议、轨道与 UI；`.trellis/tasks/07-28-turn-low-bandwidth-video/` 负责把已建立的 screen/camera sender 在 relay 下切换到受限低画质。两者的职责不得混写。
- `.trellis/tasks/07-28-diagnose-ipv4-webrtc-p2p/` 的诊断代码可按其基础设施依赖推进，但 Phase 5 双端人工对照测试必须等待本任务验证双向主通话稳定后执行。

## Acceptance Criteria

- [ ] A 发起通话后，A、B 都能持续收到对方 pet 的屏幕/音频；任何 camera 角色或设备状态变化都不会触发通话 teardown。
- [ ] A、B 可以分别开启自己的摄像头并同时看到对方摄像头；任一方关闭只结束自己的发送方向。
- [ ] 任一方都不能远程开启、关闭或切换对方摄像头；伪造或旧版 camera media-control 请求被 server 拒绝，目标端硬件状态不变。
- [ ] 每一方都能看到本地预览并选择本机摄像头；收起预览不停止发送，关闭后硬件指示灯熄灭。
- [ ] 摄像头默认关闭且按本机首次开启请求权限；一方拒绝权限时另一方摄像头及双方主通话仍正常。
- [ ] 双方 UI 明确区分本地/远端摄像头状态；远端屏幕和远端摄像头在嵌入视图及系统浮窗中保持现有布局能力。
- [ ] Camera PeerConnection 或单侧 track 失败不会触发 `call:end`，可在不重建主通话的情况下重新开启。
- [ ] 结束通话、断线和窗口销毁后双方均无摄像头占用、残留 track、PeerConnection、listener、timer 或 candidate。
- [ ] Server 协议测试覆盖双方 camera signal/status 的合法路由、错误角色、旧 call 与其他房间隔离。
- [ ] 回归测试锁定 listener cleanup 不 teardown 活跃通话、camera state 分向独立以及旧 async call 结果被丢弃。
- [ ] Server/pet 测试、web/pet 类型检查与生产构建通过，并用两个隔离 Electron profile 完成双开摄像头验收。

## Out of Scope

- 多人会议、同一成员多台设备同时入会。
- 美颜、虚拟背景、录制、截图或画面标注。
- 将摄像头合并进 pet 屏幕/音频 PeerConnection。
