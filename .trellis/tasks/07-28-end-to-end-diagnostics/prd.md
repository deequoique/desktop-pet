# 构建端到端诊断与故障采集系统

## Goal

让一次服务异常、客户端功能失败或崩溃在事后可以回答：

1. 发生在什么版本、设备、进程和用户操作阶段。
2. 严重程度、错误类别及是否自动恢复。
3. 同一业务链路在客户端、服务端和 WebRTC 各经历了什么。
4. 用户或维护者下一步应该重试、检查配置、导出诊断还是升级处理。

诊断采集必须自动发生、数据有界且默认保护隐私。用户不应为了得到有效日志而提前打开开发者工具。

## Confirmed Facts

- Electron 已有本地 JSONL 诊断文件、敏感字段脱敏、1 MB × 3 代轮转和手工导出；控制面板设置及托盘菜单已有导出入口，见 `pet/src/main/diagnostics.js:5-98`、`web/src/App.tsx:1470-1474`、`pet/src/main/index.js:525`。
- 主进程已记录 `uncaughtExceptionMonitor`、`unhandledRejection`、renderer process gone 和 window unresponsive，见 `pet/src/main/index.js:707-714`、`pet/src/main/index.js:1044-1075`。
- renderer 的 JavaScript 异常、未处理 Promise、React render 错误和大多数功能失败没有进入持久化诊断；目前主要是 `console.warn/error`。
- 当前诊断事件集中在窗口、显示器和缩放，缺少 Socket.IO、配对、TTS、媒体与 WebRTC 业务链路。
- 客户端 UI 主要显示临时中文 toast，没有稳定错误码、严重级别、恢复建议或 incident ID。
- 服务端只有分散的 `console.log/warn`，没有统一 JSON envelope、级别策略、请求/通话关联、进程级异常处理或事件采样，见 `server/src/index.js:686`、`server/src/index.js:1100-1110`、`server/src/index.js:1290-1293`。
- 服务端由 PM2 管理，但仓库中没有 PM2 日志轮转、保留期和诊断提取的受版本控制配置。
- 当前不存在客户端诊断自动上传或第三方遥测系统。

## Scope and Child Deliverables

父任务定义统一契约、隐私边界和跨层验收；实现拆为三个可独立验证的子任务：

1. `07-28-server-observability`：服务端结构化日志和运行诊断。
2. `07-28-client-crash-diagnostics`：客户端错误分级、renderer/main 崩溃留证和诊断包。
3. `07-28-diagnose-ipv4-webrtc-p2p`：在统一客户端诊断基础上增加 ICE 专项证据。

通话功能与 TURN 低带宽视频已迁移到独立父任务 `.trellis/tasks/07-28-call-video-reliability/`，不计入本诊断系统的交付和验收范围。

## Requirements

### R1. 统一诊断事件契约

每条事件至少包含：

- `timestamp`
- `level`: `debug | info | warn | error | fatal`
- `domain`: `app | config | socket | call | webrtc | media | tts | note | update | storage`
- 稳定的 `event` 与可检索的 `errorCode`
- `source`: server、electron-main、pet-renderer 或 control-renderer
- app version/build、runtime session ID
- 适用时的 `callId`、request/job ID、socket session ID 与经过裁剪/哈希的设备关联字段
- `recoverability`: `automatic | retryable | user_action | fatal`
- 结构化 `context` 与规范化 exception（name、message、stack、cause）

日志文本面向维护者；UI 文案面向用户。两者通过 `errorCode` 关联，不用易变中文字符串作为机器分类。

### R2. 错误严重度和用户动作

- `debug/info`：正常生命周期和采样数据，不打扰用户。
- `warn`：已降级或已自动恢复，必要时显示非阻塞状态。
- `error`：当前操作失败但应用仍可用，UI 显示错误码、重试或导出入口。
- `fatal`：进程崩溃、不可恢复初始化失败或数据安全风险；自动生成 incident，重启后提示用户。
- 每个产品错误必须声明 domain、errorCode、recoverability 和建议动作；未知异常归入稳定 fallback code，不能只输出 `unknown`。

### R3. 自动 breadcrumbs 与 incident

- 客户端持续保存有界的结构化 breadcrumbs，覆盖启动、连接、配对、业务请求、通话、媒体权限和更新。
- 出现 `error/fatal`、renderer gone、window unresponsive、main-process uncaught exception或上次非正常退出时，自动封装 incident。
- incident 包含错误前后的 breadcrumbs、运行环境、窗口/显示器摘要、网络/通话关联和可用 crash metadata。
- 真正的 native/renderer crash 必须使用 Electron 可用的本地 crash artifact，并在下次启动关联；不能假设崩溃后的进程仍能执行 JavaScript。
- incident 与普通滚动日志都有数量、大小和保留期上限。

### R4. 服务端可复盘

- server 输出一行一个结构化 JSON 事件到 stdout/stderr，适配 PM2 收集。
- 记录启动配置指纹、HTTP 请求摘要、Socket 连接与鉴权结果、设备 join/leave、call start/end、信令计数/拒绝原因、TTS 生命周期、持久化异常和进程异常。
- WebRTC candidate/SDP 不写完整 payload；服务端只记录类型计数、方向、callId 和拒绝原因。
- 仓库提供 PM2 日志轮转、保留期、时间戳/实例标识和安全提取操作说明。
- 高频、攻击者可触发或包含隐私的数据必须限频、聚合或脱敏。

### R5. 跨层关联

- 一次通话以 `callId` 对齐 server、controller 和 pet。
- 非通话操作使用 request/job ID 或 socket session ID 关联。
- 每次 app 启动生成 runtime session ID；稳定设备标识不得原样出现在可分享诊断中。
- 时钟和版本信息足以解释客户端/服务端日志的时间偏差与版本不一致。

### R6. 诊断导出与支持体验

- 现有导出入口升级为诊断包，包含当前快照、滚动日志、incident 索引和可安全分享的 crash metadata。
- 所有诊断和 incident 自动保存在本机；应用不得在后台自动上传。只有用户主动点击“导出诊断”时才生成可分享文件。
- WebRTC 专项事件允许记录并导出精确 ICE candidate IP、port、related address 和 protocol；这些字段只用于网络诊断，不上传。
- 设置页新增独立“诊断与故障”区块和“导出诊断包”按钮；保留托盘快捷入口，crash banner 也调用同一导出动作。
- 导出动作先提示包含网络地址元数据，再打开系统保存对话框，输出带时间戳的单个 JSON 文件；成功显示保存位置，取消属于正常操作。
- 导出前后再次脱敏；媒体内容、便签内容、TTS 文本、完整 SDP、room secret、TURN/TTS credential 永不进入诊断包。
- 检测到上次崩溃或 fatal incident 时，不自动弹窗，也不强制打开控制面板；用户下次打开控制面板时显示持久提示，并提供“导出诊断”和“忽略”。
- 用户看到可理解的故障摘要、错误码、发生时间和“重试/检查权限/导出诊断”等动作，不显示原始 stack。
- 支持人员能根据 incident ID、callId 或 errorCode 快速过滤。

### R7. 可靠性约束

- 诊断失败不能影响主业务，也不能触发递归日志风暴。
- fatal 路径使用同步或可保证落盘的最小写入；普通日志不得阻塞高频媒体/渲染路径。
- 所有 IPC 入口校验 sender、事件 allowlist、payload 类型与大小。
- 默认不新增第三方 SaaS 依赖。

## Acceptance Criteria

- [ ] renderer 抛出同步异常或未处理 Promise 后，不开 DevTools 也能在导出包中找到分级事件、stack、runtime session ID 和前序 breadcrumbs。
- [ ] 模拟 renderer crash 后，主进程保存 crash 原因；重启后仍能看到 incident，并可导出关联 metadata。
- [ ] 崩溃重启不主动弹窗或打开控制面板；下次用户打开控制面板时，持久提示保持可见直到导出或忽略。
- [ ] 模拟 main-process fatal/unhandled rejection 后产生受保护的最小 incident 记录。
- [ ] 一次通话可使用同一 `callId` 串联 server、controller、pet 和 WebRTC 诊断。
- [ ] 服务端 call start/end、信令转发/拒绝和 disconnect 均为结构化、分级、可聚合事件。
- [ ] 客户端能把常见网络、权限、配置、媒体和服务故障显示为稳定错误码与可操作建议。
- [ ] 诊断包和服务端日志中不出现禁止内容或 credential。
- [ ] 用户主动导出的包保留 WebRTC IPv4 定因所需的 ICE 地址/端口，并在导出动作前明确提示其中包含网络地址信息。
- [ ] 设置页、托盘和 crash banner 三个入口调用同一导出 handler，输出内容和脱敏规则一致。
- [ ] client 日志不超过约 8 MB 轮转边界，incident 最多 10 个且每个最多 200 条 breadcrumbs，crash 索引最多 5 个；server PM2 日志按 20 MB × 7 代轮转。
- [ ] 诊断模块自身失败不会中断连接、通话或应用启动。
- [ ] server tests、pet tests、web build、pet build 和跨层手工故障矩阵通过。

## Out of Scope

- 完整 APM、指标时序数据库、分布式追踪平台或告警值班系统。
- 默认采集媒体、用户便签、TTS 文本或完整网络 payload。
- 把所有 `console.*` 无差别重定向并永久保存。
- 在诊断任务中顺带修复所有被发现的业务问题。
- 后台自动上传、远程 incident API、服务端诊断文件存储和第三方遥测。
