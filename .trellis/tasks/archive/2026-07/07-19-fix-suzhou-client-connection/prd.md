# 排查并修复苏州客户端连接失败

## Goal

定位并消除苏州 Windows 客户端无法连接桌面宠物 Socket.IO 服务的问题，确保 v1.4.1 客户端在目标网络环境中能够稳定建立连接，并在受限网络下得到可操作的诊断信息或兼容入口。

## Background

- 实际生产入口为 `ws://175.24.197.99:3030/socket.io/?EIO=4&transport=websocket`，不是 `wss://www.deequoique.tech/socket.io/`。
- 2026-07-19 从当前网络对 `175.24.197.99:3030` 实测：
  - `GET /api/health` 返回 HTTP 200，服务状态为 `socket: ready`。
  - Socket.IO polling 握手返回 HTTP 200 和有效 `sid`。
  - 携带 `Origin: file://` 的 WebSocket Upgrade 返回 HTTP 101，并收到 Engine.IO open packet。
- 服务端 Socket.IO 配置允许 `Origin: *`，同时支持 `websocket` 与 `polling`；客户端也按该顺序配置两种 transport。
- 苏州客户端执行 `Test-NetConnection 175.24.197.99 -Port 3030` 返回 `TcpTestSucceeded: True`，并且 `GET /api/health` 返回 HTTP 200；目标机器到应用服务的 TCP 和普通 HTTP 路径可用。
- 苏州客户端测试流量使用名为 `Meta` 的网络接口，源地址为 `198.18.0.1`，表明连接经过 TUN/虚拟网络栈；该层可能对 Electron 或 WebSocket Upgrade 采用不同代理策略。
- 苏州客户端使用与 Electron 请求等价的 Upgrade 请求获得 HTTP 101、正确的 `Sec-WebSocket-Accept` 和 Engine.IO `sid`；目标机器的 WebSocket 网络路径也已确认可用，测试末尾 5 秒超时只是长连接保持的预期结果。
- 客户端代码没有显式配置 Electron/Chromium 代理，Socket.IO 将使用运行环境提供的网络与代理行为。
- 现有证据已排除端口封锁、普通 HTTP 服务故障、Origin 拒绝和网络侧 WebSocket Upgrade 失败；剩余范围是 Electron 运行时差异、Socket.IO namespace 建连和 `pairing:discover` / `pet:join` 应用层响应。
- 使用项目锁定的 `socket.io-client 4.8.3` 对生产入口复测时，Socket.IO 能连接，`pet:join` 会立即返回 `bad_secret` ACK，但 `pairing:discover` 始终没有 ACK；这与苏州 v1.4.1 客户端的固定 5 秒超时完全一致。
- `pairing:discover` 由提交 `c0ae3c1`（`feat: improve pairing onboarding`）加入，并已包含在 `v1.4.1` 标签 `1928b52` 中。该事件加入前的服务端恰好支持 `pet:join`、但不会处理 `pairing:discover`，与生产行为一致。因此根因是生产 3030 进程仍运行旧服务端代码，造成 v1.4.1 客户端与服务端版本不一致。
- 用户报告大庆客户端可以连接。代码确认已有完整 `pairing.json` 的设备启动时会绕过“验证并继续”，直接执行旧服务端已支持的 `pet:join`；首次配置的苏州设备必须先调用 `pairing:discover`。因此“大庆已配对设备可连接”与“苏州新设备验证超时”可以同时成立，并不推翻服务端版本不一致的诊断。
- 服务器近期的 `EPIPE` / `ECONNRESET` 表示客户端提前断开；诊断使用的 `curl --max-time 5` 会主动关闭已升级的长连接并产生此类日志。`config-helpers` 的 DeepSeek 未知配置键警告不属于桌宠 Socket.IO 服务。

## Requirements

- 获取并保留苏州客户端的具体网络错误信息，包括错误码、失败阶段和是否使用系统代理。
- 区分公网 `3030` 端口不可达、HTTP/WebSocket 被代理拦截、客户端配置错误和 Socket.IO 入房拒绝。
- 将生产服务器升级为与 v1.4.1 标签一致、包含 `pairing:discover` 处理器的服务端构建，并确认实际监听 3030 的进程已重启到该版本。
- 修复方案必须兼容已发布的 Windows v1.4.1 客户端，或明确说明需要发布新版客户端的原因。
- 若确认目标网络限制非标准端口，优先提供标准 HTTPS/WSS 443 入口，避免要求用户关闭安全软件或修改企业网络策略。
- 连接失败时不得记录或暴露房间密钥等敏感配置。

## Acceptance Criteria

- [x] 在苏州目标网络上能够访问服务健康检查，确认 TCP 3030 与普通 HTTP 可达。
- [x] 在苏州目标网络上完成 WebSocket Upgrade 并收到 Engine.IO open packet。
- [x] 以可复现证据确认 Socket.IO 可连接、`pet:join` 有 ACK，而生产进程不响应 `pairing:discover`。
- [x] 确认大庆旧设备因已有完整配对配置而绕过 `pairing:discover`，解释地区表现差异。
- [ ] 若采用 443/WSS 入口，WebSocket Upgrade 返回 101，Socket.IO polling 仍可作为回退路径。
- [ ] 当前可用的 `175.24.197.99:3030` 入口不因修复而回归。
- [ ] 客户端错误提示或诊断日志能够区分网络不可达与服务端拒绝。

## Out of Scope

- 与连接建立无关的 WebRTC 媒体质量、TTS 或动画问题。
- 绕过目标组织明确禁止的网络访问策略。

## Resolution

- 根因是生产 3030 进程的服务端版本落后于 v1.4.1 客户端，缺少提交 `c0ae3c1` 引入的 `pairing:discover` 处理器。
- 大庆设备已有完整配对配置，启动时直接使用旧服务端支持的 `pet:join`；苏州新设备必须先执行 `pairing:discover`，因此只有苏州表现为验证超时。
- 用户确认问题已经解决并要求结束任务；本次没有修改业务代码。

## Notes

- 根因已定位为客户端/服务端版本不一致，不需要修改苏州侧网络或 Meta 配置。
