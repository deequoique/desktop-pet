# 实施计划

## 1. Server RTC 配置与凭据

- 解析并校验 `RTC_STUN_URLS`、`RTC_TURN_URLS`、`RTC_TURN_SHARED_SECRET`、`RTC_TURN_REALM`、TTL 和测试用 transport policy；启动日志只报告启用状态和 URL 数量，不记录 secret/credential。
- 实现 TURN REST 临时用户名和 HMAC-SHA1/Base64 credential helper，以及仅限已入房 pet/controller 的 `webrtc:get-config` acknowledgement。
- 实现 `webrtc:media-status` 的 call ID、role、枚举和远端归属校验，只转发到对方 controller。
- 扩展 `server/test/rooms.test.js`：未入房拒绝、host/STUN-only、有效临时凭据的结构/到期时间、secret 不泄露、过期 call/media 状态不转发、跨房间隔离。

## 2. Electron controller/pet WebRTC 状态机

- 在 `web/src/api.ts` 增加 RTC config Promise wrapper 与 typed media-status listener；移除运行时对 Google STUN 的硬依赖。
- controller/pet 在每次 call创建 peer connection 前获取 server RTC config；失败时 host-only 继续并显示诊断。
- 统一 selected candidate pair 分类：`relay`、IPv6 P2P、IPv4 P2P、unknown/failed；控制面板显示 route、恢复状态与 TURN 音频兜底。
- pet 将 screen track 初始禁用，只有确认非 relay 后启用；relay 时保持禁用。为麦克风/系统音频设置保守 Opus 发送上限。
- 将屏幕采集失败和 screen track ended 改为非致命媒体状态，释放/禁用视频但保留音频 peer connection。
- controller 独占 ICE restart offerer：首次 disconnected/failed 触发一次 restart 和15秒 timer；恢复则清 timer并重新判定 route，超时才结束 room call。pet 不再因短暂 disconnected 主动 `call:end`。
- 保持 call ID 过滤、candidate 暂存、集中 teardown 与重复 hangup 幂等。

## 3. Agent 可执行的通用 Ubuntu 24.04 部署文档

- 新增 `docs/ubuntu-coturn-deployment.md`，以任意空白 Ubuntu Server 24.04 LTS 64-bit 公网实例为起点；正文不依赖腾讯云专有命令或控制台。
- 在文档顶部定义 agent 输入契约和 preflight：OS/架构、sudo、systemd、时间同步、公私网 IPv4、NAT 映射、DNS/TLS 选择、现有 UFW/服务/端口冲突、应用 server `.env` 路径。无法安全推导时必须停止并询问用户。
- 给出 apt 安装、密钥生成、配置备份、`/etc/turnserver.conf`、coturn systemd、日志和配置校验的幂等命令、预期退出码/输出及失败分支。
- 给出云防火墙通用规则和 UFW 最小规则表：UDP/TCP 3478、UDP 49160-49200；可选 TURN/TLS TCP 5349；明确不要开放完整 49152-65535。
- 解释 `external-ip=<public>/<private>`、TURN REST shared secret 与 server 环境变量的对应关系，以及 secret 轮换顺序。
- 覆盖 STUN、正确/错误 TURN credential、强制 relay Electron、P2P 不耗 relay、主机带宽监控、日志定位、升级、secret 轮换、回滚、卸载和关闭端口的完整流程。
- 增加腾讯云附录：把通用公网/安全组/带宽监控要求映射到腾讯云控制台，并记录当前3 Mbps实例的建议容量限制；其他云厂商无需另写分支。
- 从 `docs/deployment.md` 和 `docs/troubleshooting.md` 链接该文档并补充 route/credential/带宽排障入口；文档末尾提供 agent 可直接报告的验收结果模板。

## 4. 幂等一键部署脚本

- 新增 `server/deploy/coturn.env.example`，列出公私网地址、realm、shared secret、listener/relay端口、带宽/配额、应用 `.env` 路径和 TLS 开关；示例不包含真实 secret。
- 新增 `server/deploy/install-coturn-ubuntu.sh`，实现互斥的 `--preflight`、`--dry-run`、`--install`、`--verify`、`--rollback` 与必需的 `--config`；拒绝未知参数、宽松配置权限、非 Ubuntu 24.04、非 root 执行和端口冲突。
- 安装模式通过 apt 幂等安装 coturn，备份并原子替换配置，仅管理带 `desktop-pet-coturn` 注释的 UFW 规则，安全更新应用 RTC env，校验成功后才启动服务。
- 将安装状态、校验后的脱敏配置摘要和备份放入 `/var/lib/desktop-pet-coturn/`；失败 trap 在尚未完成提交时恢复原配置/service，显式 rollback 可恢复最近一次成功安装前状态。
- verify 模式覆盖 `systemctl`、`ss`、UFW、文件权限、配置/env一致性与本机 STUN；runbook另行执行云防火墙和外部 allocation 验证。
- 更新 Linux server release workflow，把 `server/deploy/` 包含进发布压缩包；运行 `bash -n`、dry-run/preflight负例以及重复执行检查，不在 CI 主机上修改真实防火墙。

## 5. Trellis code-spec

- 新增 `.trellis/spec/desktop-pet/shared/webrtc-networking-and-deployment.md`，按 infra/cross-layer 七段结构记录事件签名、环境变量、选路与音视频行为、验证/错误矩阵、案例、测试和错误/正确示例。
- 更新 shared spec index；在跨层思考指南中加入“RTC config/临时凭据/relay 视频禁用/部署端口同时核对”的短 checklist，并指向详细 spec。
- 不把云厂商控制台逐步操作重复进 code-spec；运维步骤留在 `docs/ubuntu-coturn-deployment.md`，spec 只保存实现契约和必须验证的不变量。

## 6. 验证与发布门禁

- 自动检查：
  - `npm test --prefix server`
  - `npm run build:web`
  - `npm run build:pet`
  - `bash -n server/deploy/install-coturn-ubuntu.sh`
- 脚本检查：错误 OS/权限/缺失变量/端口冲突必须失败；dry-run 不产生系统变更；受控 Ubuntu 测试实例上连续执行两次 install 结果一致，rollback 恢复脚本管理的配置与规则。
- 部署检查：`turnutils_stunclient` 获得 srflx；正确临时凭据可 allocation；错误/过期凭据失败；`ss`/`systemctl`/`journalctl` 与主机及云厂商监控结果符合文档。
- 手动网络矩阵：同 LAN、双 IPv6、无 IPv6但 IPv4可打洞、强制 relay、短暂断网小于15秒、恢复超时、屏幕权限拒绝、screen track ended、用户挂断。
- 每个场景断言 route UI、视频启停、双方音频、server call ID、track/stream/peer connection 清理和 relay 主机出网；强制 relay 时屏幕不得持续传输。
- 发布前确认 coturn和 server先于 Electron上线；回滚演练确认关闭 TURN 配置后仍可 host/STUN P2P。

## 风险与回滚点

- 风险：selected-pair stats 在不同 Chromium 报告结构略有差异。实现兼容 transport `selectedCandidatePairId` 与 nominated/succeeded pair两种读取方式，unknown 不启用视频。
- 风险：TURN REST TTL 过短导致长通话 refresh 失败。默认12小时并在文档中限制为10分钟至24小时。
- 风险：视频在 route 确认前泄漏到 relay。screen track 必须默认 disabled，只有确认非 relay 后启用。
- 回滚点：server RTC config功能可独立禁用；Electron 失败时 host-only；coturn 可在清除 server URL 后安全停用。
