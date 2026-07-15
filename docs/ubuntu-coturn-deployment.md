# Ubuntu 24.04 coturn 部署手册

本手册面向执行部署的 agent：从一台具有公网 IPv4 的 Ubuntu Server 24.04 LTS 64-bit 开始，为 desktop-pet 部署自建 STUN/TURN。媒体仍优先 P2P；只有打洞失败才走 TURN，且应用在 relay 路径上只保留音频。

## 输入契约与停止条件

开始前必须取得：公网 IPv4、实例私网 IPv4、指向公网 IP 的 TURN 域名、应用 server `.env` 绝对路径，以及云防火墙管理权限。TLS 是可选项；若启用，还必须有可读的证书和私钥文件。

先确认：

```bash
cat /etc/os-release
uname -m
sudo -v
timedatectl status
ip -4 address
ip route
sudo ss -lnutp
sudo ufw status verbose
```

预期为 Ubuntu 24.04、`x86_64` 或 `aarch64`、systemd 可用且时间同步。用云控制台核对公网 IP 是否直接绑定网卡；若是 NAT 映射，配置必须使用 `external-ip=公网/私网`。如果 IP、NAT 关系、端口占用或现有防火墙规则无法安全推断，停止并询问用户，不得猜测。

## 网络条件

云防火墙/安全组和 UFW 均应允许下表入站；源地址可在两台电脑公网地址长期固定时进一步收窄。

| 协议 | 端口 | 用途 |
|---|---:|---|
| UDP | 3478 | STUN 与首选 TURN |
| TCP | 3478 | UDP 受限时的 TURN |
| UDP | 49160-49200 | TURN relay allocation |
| TCP | 5349 | 可选 TURN/TLS |

不要开放完整的 `49152-65535`。出站需允许回应客户端和 relay 目标。脚本只管理主机 UFW，不会也不应自动修改云防火墙。

## 一键部署

从 release 包或仓库取得 `server/deploy/`，然后：

```bash
sudo install -m 600 server/deploy/coturn.env.example /root/desktop-pet-coturn.env
sudo editor /root/desktop-pet-coturn.env
sudo server/deploy/install-coturn-ubuntu.sh --preflight --config /root/desktop-pet-coturn.env
sudo server/deploy/install-coturn-ubuntu.sh --dry-run --config /root/desktop-pet-coturn.env
sudo server/deploy/install-coturn-ubuntu.sh --install --config /root/desktop-pet-coturn.env
sudo server/deploy/install-coturn-ubuntu.sh --verify --config /root/desktop-pet-coturn.env
```

生成 secret 可用 `openssl rand -base64 48`，只写入 mode 600 的配置文件，不能作为命令行参数、聊天内容或日志输出。脚本将安装 coturn、备份原配置到 `/var/lib/desktop-pet-coturn/backup/`、写入 `/etc/turnserver.conf`、按需增加带 `desktop-pet-coturn` 注释的 UFW 规则，并更新应用 `.env`。重启应用 server 后，新通话才会取得配置。

默认限制 `max-bps=64000` bytes/s、`bps-capacity=250000` bytes/s、每用户4个 allocation、总计8个；应用同时把每条音频 sender 限到约64 kbit/s，适合3 Mbps小实例上的两人音频兜底。视频在 TURN 上会被应用禁用；这些限制不是多人容量承诺。

## 配置映射

coturn 的 `static-auth-secret` 必须等于 server 的 `RTC_TURN_SHARED_SECRET`，`realm` 等于 `RTC_TURN_REALM`。Server 用该 secret 生成 `<过期Unix秒>:<participantId>` 和 HMAC-SHA1/Base64 临时凭据，客户端永远拿不到 shared secret。

若公网与私网不同，脚本写入 `external-ip=<PUBLIC_IP>/<PRIVATE_IP>`；相同则省略。DNS A 记录必须解析到公网 IPv4。`RTC_ICE_TRANSPORT_POLICY=all` 用于生产；临时改为 `relay` 并重启 server，可做强制中继验收，完成后必须改回 `all`。

## 验收与诊断

主机内检查：

```bash
sudo systemctl status coturn --no-pager
sudo ss -lnutp | grep 3478
sudo journalctl -u coturn -n 100 --no-pager
turnutils_stunclient -p 3478 127.0.0.1
```

必须再从云外网络测试 `turn.example.com:3478`，因为本机测试无法证明云防火墙和公网 NAT 正确。验收矩阵：

- STUN 能返回 srflx 地址。
- 用 server 签发的正确临时凭据可 allocation；错误或过期凭据必须失败。
- `all` 下可直连时 UI 显示 host/srflx，TURN 出网不增长。
- `relay` 下双方音频可用、屏幕显示“仅音频”且不持续发送视频。
- 断网少于15秒可经一次 ICE restart 恢复；超时才挂断。
- 用 `nload`、`iftop` 或云监控观察出网，确认未突破实例带宽。

常见原因：`401 Unauthorized` 多为 realm/secret/时钟不一致；有 allocation 但无媒体多为 relay UDP 范围未开或 `external-ip` 错；TCP 可用而 UDP 不通通常是安全组/UFW；一直只有 host candidate 则客户端没有取得 RTC 配置或 STUN 不可达。

## 轮换、升级与回滚

轮换 secret：先更新 coturn 与 server 环境为新 secret，重启 coturn/server，再发起新通话；已有会话不应被当作可靠续期路径，安排短暂通话中断。升级前复制 `/etc/turnserver.conf` 和应用 `.env`，执行 `apt-get update && apt-get install --only-upgrade coturn` 后重新 `--verify`。

回滚最近一次安装：

```bash
sudo server/deploy/install-coturn-ubuntu.sh --rollback --config /root/desktop-pet-coturn.env
```

完全停用时，先从 server `.env` 清除 TURN URL/secret并重启 server，再停用 coturn，最后删除云防火墙端口。不要先关闭 TURN 而让客户端继续收到失效配置。

## 腾讯云附录

在腾讯云 CVM 的实例详情核对公网 IPv4、内网 IPv4和带宽上限；在关联安全组增加上述四组入站规则，并在云监控观察公网出带宽。当前3 Mbps实例应保持默认音频限速，TURN只作最终兜底。腾讯云按带宽购买且上限不高于10 Mbps的常见实例，公网入带宽通常高于购买的出带宽，但必须以实例控制台显示的实际策略为准；容量判断以出方向3 Mbps为硬约束。

## Agent 验收报告模板

```text
主机/系统：
公网/私网/NAT关系：
DNS与TLS：
云防火墙规则：
UFW规则：
coturn active/listening：
本机STUN：
外部STUN与TURN allocation：
错误/过期credential拒绝：
Electron强制relay音频/视频结果：
带宽峰值：
回滚验证：
未完成项或风险：
```
