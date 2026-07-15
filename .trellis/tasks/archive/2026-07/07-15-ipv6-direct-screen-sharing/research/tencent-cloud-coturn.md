# Ubuntu/coturn 通用部署与腾讯云 3 Mbps 调研

## 一手资料

- 腾讯云《云服务器公网带宽上限》：购买的公网带宽默认约束 CVM 出网；购买带宽不超过 10 Mbps 时，普通公网 IP 入网带宽为 10 Mbps。3 Mbps TURN 的主要瓶颈因此是 relay 后从 CVM 发往两端的总出网流量。  
  https://cloud.tencent.com/document/product/213/12523
- 腾讯云《添加安全组规则》：安全组入站规则支持 TCP、UDP、IPv4 和 IPv6，默认模板不包含 coturn 端口，必须显式添加最小端口规则。  
  https://cloud.tencent.com/document/product/213/112614
- coturn 官方配置：默认 listener 为 3478；TLS listener 为 5349；未指定 listener IP 时监听系统 IPv4/IPv6；云主机公网 IP 不直接绑定在网卡时需配置 `external-ip=<public>/<private>`；默认 relay 范围为 49152-65535，可收窄。  
  https://github.com/coturn/coturn/blob/master/docker/coturn/turnserver.conf
- coturn 官方 turnserver 文档：`max-bps` 限制单会话字节/秒，`bps-capacity` 限制服务器总容量；`user-quota` 和 `total-quota` 限制 allocation；`static-auth-secret`/TURN REST API 支持限时凭据。  
  https://github.com/coturn/coturn/wiki/turnserver
- coturn `README.turnserver`：TURN REST 用户名使用到期时间戳，密码为共享密钥对临时用户名的 HMAC-SHA1 后 Base64；共享密钥只由应用 server 与 coturn 持有。  
  https://github.com/coturn/coturn/blob/master/README.turnserver
- W3C WebRTC：ICE candidate 支持 IPv4、IPv6、FQDN，`restartIce()` 触发新的 ICE generation；selected candidate pair 可通过 stats 判断 host/srflx/relay。  
  https://www.w3.org/TR/webrtc/

## 方案推导

- 3 Mbps 等于约 375,000 bytes/s 出网理论上限；不能把它全部分配给 coturn，还需给 Socket.IO、TTS、重传和协议开销留余量。
- TURN 仅保证音频：应用全局限制语音音轨码率，并在 route 未确定前禁用 screen video；selected pair 为非 relay 后才启用视频。
- coturn 建议默认 `max-bps=64000` bytes/s/会话、`bps-capacity=250000` bytes/s、`user-quota=4`、`total-quota=8`；最终值必须通过双端 relay 实测和腾讯云监控校验。
- listener 最小集合为 UDP/TCP 3478；relay UDP 范围收窄为 49160-49200。TURN/TLS 5349 作为有域名和证书时的可选增强，不是首版接通 IPv4 P2P/UDP TURN 的前置条件。
- TURN 必须认证。匿名 relay 即使项目知名度低，也可能被自动扫描滥用并耗尽 3 Mbps 带宽。

## 实现与文档目标

- 应用 server 动态签发限时 TURN 凭据，不向客户端返回共享密钥。
- 部署文档以任意 Ubuntu Server 24.04 LTS 64-bit 公网主机为主线，覆盖云防火墙、UFW、systemd、验证、监控、升级和回滚；腾讯云3 Mbps仅作为附录和容量基线。
- 文档以自动化 agent 为主要读者，必须显式定义输入、幂等步骤、断言、停止条件和回滚，避免依赖执行者的隐含运维知识。
- 同时提供配置文件驱动的一键部署脚本；云厂商防火墙保留为 runbook 外部步骤，脚本只安全管理 Ubuntu 主机内状态。
- `.trellis/spec/desktop-pet/shared/` 新增 WebRTC 网络与部署 code-spec，使用 infra/cross-layer 七段模板并由索引引用。
