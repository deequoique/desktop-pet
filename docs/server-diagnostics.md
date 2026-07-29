# 服务端诊断日志

服务端向 stdout/stderr 输出逐行 JSON。每条事件包含时间、级别、域、事件名、运行会话和关联 ID；HTTP 使用 `requestId`，通话与 WebRTC 信令使用 `callId`。WebRTC 日志只记录 offer/answer/candidate 的计数和 candidate 类型，不记录 SDP、原始 candidate、房间密钥或 TURN 凭据。

部署与重启：

```bash
cd /opt/desktop-pet/server
sudo install -d -m 0750 -o ubuntu -g ubuntu /var/log/desktop-pet
pm2 startOrReload ecosystem.config.cjs --update-env
bash deploy/configure-pm2-logs.sh
pm2 save
```

轮转基线为每文件 20 MB、保留 7 份并压缩。若运行用户不是 `ubuntu`，执行脚本前设置 `DESKTOP_PET_APP_USER`。

常用检查：

```bash
pm2 logs desktop-pet-server --lines 200
tail -f /var/log/desktop-pet/server.log
jq 'select(.correlation.callId == "要检查的 callId")' /var/log/desktop-pet/server.log
```

启动后应同时看到 `server.started` JSON 事件和兼容旧运维检查的 `pet server listening` 文本。`server.started.context.dataDir` 显示本次进程实际使用的持久目录；生产环境默认应为 `/var/lib/desktop-pet`。`server.started.context.rtc` 会显示 STUN/TURN 数量和 ICE policy，但不会输出 shared secret。
