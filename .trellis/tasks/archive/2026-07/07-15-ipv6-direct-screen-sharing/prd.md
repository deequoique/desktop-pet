# 双栈 P2P 与 TURN 音频兜底

## Goal

为两个固定、彼此已知的 Electron 桌宠客户端提供稳定的跨公网屏幕共享与语音通话：优先使用 IPv6/IPv4 P2P 传输完整媒体，直连失败时通过低带宽腾讯云 TURN 至少保留音频通话。

## Background

- 产品是私人双人项目，不需要多人房间、动态匹配或公共服务规模扩展。
- 两台目标电脑在原网络中拥有可用 IPv6；同一局域网内现有 WebRTC 通话效果良好。实测发现其中一端换到新网络后不再支持 IPv6，跨地域公网通话随即长期停留在 ICE 选路或失败。
- 当前 `web/src/App.tsx:66` 与 `pet/src/renderer/main.ts:1322` 只配置 `stun:stun.l.google.com:19302`，没有 TURN。
- 当前媒体已经由 WebRTC 点对点传输；腾讯云 server 只负责 Socket.IO 房间、call ID 与 SDP/ICE 信令中转。
- 腾讯云服务器带宽很低，不能把持续的视频或音频中继作为正常工作路径。
- 当前目标实例是腾讯云 Ubuntu Server 24.04 LTS 64-bit，公网带宽上限为 3 Mbps；部署交付物必须适用于任意具有公网 IPv4 的 Ubuntu Server 24.04 LTS 64-bit，腾讯云仅作为云防火墙示例。
- 当前 controller 与 pet 都会把短暂的 `RTCPeerConnection.connectionState === 'disconnected'` 立即升级为全房间通话结束，这会放大网络抖动。
- 产品只支持打包后的 Electron 客户端；`web/` React 控制面板继续作为 Electron renderer 使用，不再要求独立浏览器兼容。

## Requirements

- R1：双方都有可互通 IPv6 时优先使用 IPv6 端到端路径；任一端没有 IPv6 时自动尝试 IPv4 P2P，媒体均不得经过应用 server。
- R2：方案必须严格适配两个已知参与者，不为多人、匿名发现或互联网公共房间增加复杂度。
- R3：应用 server 可以继续承担低带宽信令与在线状态协调，但不得成为正常媒体数据面。
- R4：优先使用公网 IPv6 host candidate；IPv6 不可用时，通过部署者自建、国内可达的 STUN 尝试 IPv4 P2P 后备，不依赖 Google STUN。
- R5：配置受认证的 TURN 作为最后兜底；ICE 仍优先 IPv6/IPv4 P2P，只有所有直连路径失败时才允许选择 relay candidate。TURN 路径只保证音频通话，不要求中继屏幕视频。
- R6：必须区分短暂 ICE/网络抖动与永久失败；短暂 `disconnected` 触发一次 ICE restart，最多等待 15 秒，不应立即挂断双方通话。
- R7：失败时应向用户显示可诊断信息，至少区分 IPv6 P2P、IPv4 P2P、TURN 音频兜底、ICE 恢复中与无可用路径。
- R8：设计需说明防火墙策略、候选地址暴露和 STUN 配置分发方式，但不维护 IPv6 地址/前缀白名单。
- R9：继续使用现有高强度 room secret 与稳定 `participantId`；本任务不增加设备公钥绑定或人工验证码。
- R10：新增云厂商无关的 Ubuntu Server 24.04 LTS 64-bit 完整部署文档，覆盖主机与公网地址前置条件、coturn STUN/TURN 安装与配置、云防火墙/安全组、UFW、systemd、DNS/TLS（如使用）、客户端配置、验证、日志、监控、升级、回滚和故障排查；腾讯云步骤只作为附录实例。
- R11：部署文档必须明确区分 Socket.IO/HTTPS 信令端口、STUN/TURN listener 端口和受限的 TURN relay 端口范围；云厂商防火墙与 Ubuntu UFW 只开放文档规定的最小协议和端口集合。
- R12：把稳定的 WebRTC P2P、STUN 和 TURN 兜底基础设施契约同步进 `.trellis/spec/`，按 infra/cross-layer code-spec 模板记录签名、环境配置、错误矩阵、案例、测试和错误/正确示例，并更新相关 spec 索引。
- R13：TURN 被选中时自动切换为音频兜底模式，禁止屏幕视频经 relay 持续发送；保留双方麦克风，并在可用时保留系统声音，为协议开销、Socket.IO 和 TTS 留出充足余量。恢复 P2P 后允许恢复正常屏幕共享。
- R14：TURN 必须使用限时凭据或等价的受认证机制，禁止开放匿名 relay；凭据密钥只能存在于 server/coturn 配置，不得写入 Electron 安装包或日志。
- R15：屏幕采集失败、屏幕 track `ended` 或 relay 模式停用视频时不得结束仍然可用的音频通话；音频与视频必须具有独立的状态和清理路径。
- R16：部署文档的主要读者是后续自动化 agent。文档必须定义完整输入变量、前置检查、幂等执行顺序、每步预期结果、失败停止条件、验收断言、secret 处理和回滚，不允许把关键决策留给执行 agent 临场判断。
- R17：提供配置文件驱动的 Ubuntu 一键部署脚本，支持 preflight/dry-run、幂等安装、验证和安全回滚；脚本只能管理自身创建或明确接管的 coturn、UFW 和应用环境配置，不得猜测或自动修改云厂商防火墙。

## Technical Constraints

- 保留现有 Electron pet、React controller、Socket.IO 信令和 WebRTC 媒体边界。
- 不再以独立浏览器作为支持目标，但不为此重写现有 React 控制面板。
- 保留 SDP/ICE、call ID、远端描述前暂存 ICE candidate，以及集中清理媒体资源的现有契约。
- 不把已知 IPv6 地址直接作为未经验证的客户端目标路由依据；参与者身份仍由现有房间和稳定 `participantId` 约束。
- 方案应优先使用标准 WebRTC ICE 能力，而不是另建自定义视频传输协议。

## Acceptance Criteria

- [ ] AC1：两端具有可互通公网 IPv6 时选中 IPv6 非 relay candidate pair；任一端没有 IPv6但 IPv4 NAT 可打洞时，自动选中 IPv4 非 relay candidate pair并建立画面和语音。
- [ ] AC2：正常 IPv6 或 IPv4 P2P 期间，腾讯云 server 只产生信令、STUN 和状态流量，不承载媒体流。
- [ ] AC3：Google STUN 不可达时，IPv6 可直连环境仍能建立通话；IPv6 不通但 IPv4 可打洞时，能通过自建 STUN 建立非 relay P2P 通话。
- [ ] AC4：短暂进入 `disconnected` 不会立即结束通话；客户端发起一次 ICE restart，并在 15 秒恢复窗口后才完成失败清理和双方通知。
- [ ] AC5：控制面板能显示 IPv6 P2P、IPv4 P2P、TURN 音频兜底、恢复中或失败，不把长时间选路误报为通话中。
- [ ] AC6：无可用 P2P 路径时自动尝试 TURN 音频兜底；TURN 也失败时明确报告无可用路径，而不是无限停留在“ICE 选路”。
- [ ] AC7：server、web 与 pet 的现有构建和房间/信令测试继续通过，并补充断线状态机与配置解析的验证。
- [ ] AC8：按通用 Ubuntu 24.04 部署文档从任意空白公网实例可完成 coturn STUN/TURN 部署，外部客户端能获得 IPv4 `srflx` candidate，持有效限时凭据时能获得 relay candidate，无效或过期凭据不能分配 relay。
- [ ] AC9：部署文档包含云防火墙与 Linux 主机两层公网/端口检查、可复制命令、预期输出、失败分支、卸载/回滚步骤，以及“STUN 不承载媒体”的带宽说明；腾讯云附录映射到同一通用端口契约。
- [ ] AC10：`.trellis/spec/` 中存在可执行的 WebRTC/STUN/TURN 部署契约并由索引链接；后续修改 ICE server、恢复状态机或部署端口时能据此完成跨层检查。
- [ ] AC11：TURN 路径下屏幕视频不持续经过 relay，双方麦克风可以继续通话；UI 明确提示“TURN 音频兜底/屏幕不可用”，P2P 恢复后可恢复屏幕共享。
- [ ] AC12：屏幕采集失败或 screen track 结束时，音频 peer connection 和麦克风 track 保持可用，只有音频失败、用户挂断或 server 协调结束才清理整场通话。
- [ ] AC13：一个不了解本项目部署历史的 agent 仅阅读部署文档和仓库变量模板，就能收集必要输入、从空白 Ubuntu 24.04 主机完成部署、验证 P2P/STUN/TURN、判断失败点并执行回滚，无需新增技术决策。
- [ ] AC14：agent 填写受限权限的部署配置文件后，可用单条脚本命令完成 coturn 安装与本机配置；重复执行无额外副作用，dry-run 不修改系统，rollback 只撤销脚本记录的改动并保留可恢复备份。

## Out of Scope

- 多人通话、SFU/MCU、云端录制、云端转码或视频持久化。
- 以腾讯云 TURN 承载正常媒体流量；TURN 仅作 P2P 全失败后的兜底。
- 通过 TURN 兜底屏幕视频质量；relay 模式只保证音频。
- IPv6 地址或前缀白名单，以及设备公钥绑定。
- 替换现有 WebRTC 为自研 RTP/QUIC/裸 TCP 视频协议。
