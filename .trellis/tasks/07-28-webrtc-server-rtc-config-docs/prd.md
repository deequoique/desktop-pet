# 补全服务器 RTC 配置操作文档

## Goal

让部署或维护 desktop-pet server 的操作者明确完成 coturn 与应用 server 两侧的 RTC 配置闭环，避免 coturn 正常运行但应用 `.env` 未配置、Electron 静默退回 host-only 并导致跨 NAT 通话失败。

## Background

- 2026-07-28 首轮诊断检查了一个非运行实例使用的 `.env` 路径，因此错误得出“应用未配置 RTC”的结论。随后通过 PM2 进程信息确认了真实工作目录；该实例实际读取的 `.env` 已有全部六个 `RTC_*` 变量，启动日志为 `stun=1 turn=2 policy=all`，并且 shared secret 与 coturn 匹配。
- 应用 server 由 PM2 运行 `node src/index.js`。未加载 RTC 配置时，`webrtc:get-config` 确实会返回空 `iceServers` 并使 Electron 回退为 host-only，但这不是本次通话失败的事实根因。
- 复测时 ICE 最终选择 TURN。选中 relay 证明客户端已取得 RTC 配置并至少成功建立某种 TURN 路径；它不能证明 STUN binding 失败，只能证明没有选中可用的 host/srflx/prflx 直连 pair。
- VPS 从自身公网地址取得 STUN Binding Success 只能证明本机/coturn/NAT 回环路径，不能单独证明云外客户端可达。反过来，真实客户端已经选中 TURN，也使“云安全组完全阻断 3478”不足以解释现象；仍需知道 TURN 使用 UDP 还是 TCP，并检查双方实际收集和交换的 candidate。
- 当前服务端与 coturn 日志没有双方完整 candidate 或 selected pair，无法区分“未产生 srflx”“产生但未交换”“双方有 srflx 但 NAT 打洞失败”。在补齐客户端 ICE 证据前不归因于防火墙或 NAT。
- relay 复测最终确认双方音频均可听见。通话期间服务器 30 秒抓到 545 个 RTC 相关数据包，且内核无丢包，因此 TURN 音频兜底已按设计工作；此前“双向无声”不是稳定复现，不能据此归因于 relay 端口、`external-ip` 或防火墙。当前仍未解决的是为什么没有选中 IPv4 P2P，以及现有客户端缺少完整 candidate/selected-pair 诊断。
- A 成员同时有 Windows 和 macOS 两台设备，B 端一直有公网 IPv6。Windows 切换到有线网络并取得 IPv6 后，与 B 端可走 IPv6 P2P 并显示画面；macOS 仍没有可用 IPv6，与 B 端未建立 IPv4 P2P，因而选择 TURN 音频兜底。这说明差异来自设备级网络 candidates，而不是同一条连接在 Windows/macOS 上单向失效。
- `server/.env.example` 已列出六个 `RTC_*` 变量；`server/deploy/install-coturn-ubuntu.sh` 也会把它们写入 `APP_ENV_FILE`。现有文档只在“一键部署”段落中一句带过，没有把应用 `.env`、进程重启、启动日志和 host-only 症状组成独立、可验收的操作步骤。
- 历史部署记录、服务器上的非运行目录和 PM2 实际工作目录曾对应不同 `.env` 路径。文档不能硬编码部署路径，必须要求操作者从进程管理器确认真实应用目录与 `.env`。

## Requirements

### 1. 应用 server RTC 配置

- 在 `docs/deployment.md` 增加独立的 WebRTC/STUN/TURN 应用配置章节，明确 coturn 安装成功并不代表应用已启用 RTC 服务。
- 列出 `RTC_STUN_URLS`、`RTC_TURN_URLS`、`RTC_TURN_SHARED_SECRET`、`RTC_TURN_REALM`、`RTC_TURN_CREDENTIAL_TTL_SEC` 和 `RTC_ICE_TRANSPORT_POLICY` 的可复制 `.env` 模板。
- 说明 `RTC_TURN_SHARED_SECRET` 必须与 `/etc/turnserver.conf` 的 `static-auth-secret` 完全相同，生产 policy 必须为 `all`；文档和诊断命令不得输出真实 secret。
- 明确应用 server 未配置 RTC 时会返回空 `iceServers`，Electron 只产生 host candidates，而不是自动使用 coturn。

### 2. 既有 coturn 的补配路径

- 在 `docs/ubuntu-coturn-deployment.md` 增加“coturn 已运行、应用未配置”的恢复步骤，不要求为了补 `.env` 重新安装或重写 coturn。
- 操作者必须先确定实际应用 `.env` 路径，备份文件，再补齐六个变量；不能沿用示例或历史路径而不检查。
- 给出不打印密钥的存在性检查、coturn/application secret 一致性检查，以及 PM2、systemd、手动运行三种重启提示。
- PM2 示例不得假定固定应用名；先用 `pm2 list` 确认名称，再重启对应进程。

### 3. 闭环验收与故障定位

- 应用重启后必须检查启动日志包含 `rtc: stun=<正数> turn=<正数> policy=all`；只有 coturn `active` 或 3478 监听不能算完成。
- 保留并强调云安全组的 UDP 3478、TCP 3478、UDP 49160-49200；未启用 TLS 时不要求 5349。
- 在 `docs/troubleshooting.md` 的通话排障中把“始终只有 host candidate”首先指向应用 RTC 配置/进程未重启，再检查 STUN 公网可达性。
- 验收步骤必须区分：配置已写入磁盘、应用进程已重新加载、coturn 本机可用、云外网络可达、Electron 实际出现 `srflx`/`relay`。

## Acceptance Criteria

- [ ] 一个只看到 server 部署文档的操作者能找到真实 `.env`、补齐六个 `RTC_*` 变量，并知道 coturn secret 与应用 secret 必须一致。
- [ ] 文档明确指出“coturn 正常但应用未配置”会造成 host-only，且提供无需重装 coturn 的恢复路径。
- [ ] PM2、systemd 和手动启动场景都有重启/查日志说明；PM2 不硬编码进程名。
- [ ] 所有示例和检查命令均不显示真实 shared secret，且提醒不得把 secret 提交 Git 或粘贴到诊断结果。
- [ ] 应用启动日志验收要求 `stun`、`turn` 为正数且 `policy=all`；仅检查 coturn 状态不算通过。
- [ ] 云安全组与 UFW/监听端口检查仍覆盖 UDP/TCP 3478、UDP 49160-49200，可选 TLS 5349。
- [ ] 故障排查能够把“只有 host candidate”区分为应用配置缺失/未重启、STUN 不可达和云端口未开放。
- [ ] 文档链接与 Markdown 结构有效，`server/.env.example` 中的变量名与文档完全一致。

## Out of Scope

- 修改远端服务器 `.env`、coturn 配置、PM2 进程或云安全组。
- 修改 WebRTC 信令、ICE 状态机、candidate 日志或客户端界面。
- 重新安装 coturn、启用 TURN/TLS，或改变现有端口和带宽配额。
- 在仓库中保存当前服务器的公网地址或真实 shared secret。
