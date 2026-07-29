# 部署

## Linux server

服务器需要 Node.js 20。推荐使用同一个 Git checkout 部署，后续更新只需 fast-forward pull，不替换整个应用目录。以下示例假设 server 由当前登录用户运行；若 PM2 使用其他用户，先把 `DESKTOP_PET_APP_USER` 和 `DESKTOP_PET_APP_GROUP` 改成真实值。

```bash
DESKTOP_PET_APP_USER="$(id -un)"
DESKTOP_PET_APP_GROUP="$(id -gn)"
sudo install -d -m 0755 -o "$DESKTOP_PET_APP_USER" -g "$DESKTOP_PET_APP_GROUP" /opt/desktop-pet
git clone https://github.com/deequoique/desktop-pet.git /opt/desktop-pet
cd /opt/desktop-pet
cp server/.env.example server/.env
chmod 600 server/.env
editor server/.env
sudo install -d -m 0750 -o "$DESKTOP_PET_APP_USER" -g "$DESKTOP_PET_APP_GROUP" /var/lib/desktop-pet
npm ci --prefix server --omit=dev
cd server
pm2 startOrReload ecosystem.config.cjs --update-env
bash deploy/configure-pm2-logs.sh
pm2 save
curl --fail http://127.0.0.1:3030/api/health
```

`server/.env` 默认包含 `NODE_ENV=production` 和 `PET_DATA_DIR=/var/lib/desktop-pet`。代码在生产模式未显式配置 `PET_DATA_DIR` 时也使用该目录；本地非生产开发才回退到 `server/data`。首次启动若目录不存在或运行用户不可读写，server 会直接拒绝启动，不会等到用户写入名称或便签时才失败。

Release 中的 Linux 压缩包仍可用于无 Git 部署：解压后复制 `.env.example` 为 `.env`、先创建 `/var/lib/desktop-pet`，再运行 `./start-linux.sh`。该脚本默认设置 `NODE_ENV=production`。生产环境建议用 PM2 或 systemd 守护进程，并在 Caddy 或 Nginx 后提供 HTTPS；普通 HTTP 会导致浏览器麦克风权限和 WebRTC 受限。

公网两端无法稳定 P2P 时，按 [Ubuntu 24.04 coturn 部署手册](./ubuntu-coturn-deployment.md) 配置自建 STUN 与 TURN 低清视频兜底。Release 的 `server/deploy/` 已包含幂等部署脚本和配置模板。

## 日常更新

更新前先确认 checkout 干净并备份持久目录。备份名称请替换为当前日期时间，且不要覆盖已有备份。

```bash
cd /opt/desktop-pet
git status --short
sudo cp -a /var/lib/desktop-pet /var/backups/desktop-pet-data-YYYYMMDD-HHMMSS
git pull --ff-only
npm ci --prefix server --omit=dev
cd server
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
curl --fail http://127.0.0.1:3030/api/health
```

不要在部署 checkout 中运行 `git clean -fdx`，也不要通过删除目录再 clone 的方式更新。`git pull --ff-only` 不会删除 `.env` 或未跟踪文件；不过权威数据仍必须放在 `/var/lib/desktop-pet`，不能依赖这一行为保护包内数据。

## 从旧版 `server/data` 迁移

升级前检查旧目录。只要存在 `server/data/registry.json`，就必须迁移整个 `server/data`，包括 `audio/` 和 `notes/`。新 server 检测到 legacy registry、但 `/var/lib/desktop-pet/registry.json` 不存在时会拒绝启动并显示两个目录，防止误建空 registry。

先确认 PM2 的实际工作目录和运行用户：

```bash
pm2 describe desktop-pet-server
ps -o user= -p "$(pm2 pid desktop-pet-server)"
```

然后停服、备份并迁移。以下命令假设实际 checkout 是 `/opt/desktop-pet`，且目标 registry 尚不存在：

```bash
DESKTOP_PET_APP_USER="$(ps -o user= -p "$(pm2 pid desktop-pet-server)" | xargs)"
DESKTOP_PET_APP_GROUP="$(id -gn "$DESKTOP_PET_APP_USER")"
cd /opt/desktop-pet
pm2 stop desktop-pet-server
sudo test -f server/data/registry.json
sudo test ! -e /var/lib/desktop-pet/registry.json
sudo cp -a server/data /var/backups/desktop-pet-data-legacy-YYYYMMDD-HHMMSS
sudo install -d -m 0750 -o "$DESKTOP_PET_APP_USER" -g "$DESKTOP_PET_APP_GROUP" /var/lib/desktop-pet
sudo cp -a server/data/. /var/lib/desktop-pet/
sudo chown -R "$DESKTOP_PET_APP_USER:$DESKTOP_PET_APP_GROUP" /var/lib/desktop-pet
sudo -u "$DESKTOP_PET_APP_USER" test -r /var/lib/desktop-pet/registry.json
sudo -u "$DESKTOP_PET_APP_USER" test -w /var/lib/desktop-pet
cd server
pm2 startOrReload ecosystem.config.cjs --update-env
curl --fail http://127.0.0.1:3030/api/health
```

启动后从双方控制面板核对成员名称、待处理便签、历史/收藏和个人音频。确认稳定前保留 legacy 目录与备份；不要让旧目录和 `/var/lib/desktop-pet` 同时接受写入。回滚应用代码时保留 `/var/lib/desktop-pet`，不得删除或降级 registry。

## 房间配置

`ROOM_SECRETS` 使用英文逗号配置多个允许的密钥；未设置时使用 `ROOM_SECRET`。房间密钥只用于入房，不会以明文广播。每个密钥对应固定的 A/B 两名成员，但每名成员可连接多台设备。新版协议与旧客户端不兼容，部署时必须同时升级所有客户端。

生产持久目录保存成员名称、设备历史、“我的音频”、便签、回复、收藏和图片附件；设备离线超过 30 天后自动清理，音频不会随设备清理而删除。

registry 以房间密钥的 SHA-256 hash 作为房间 key。更新后若 `/var/lib/desktop-pet/registry.json` 存在且非空，但界面同时恢复成“用户 A/用户 B”且便签为空，先对比更新前后的 `.env` 和备份，确认 `ROOM_SECRET(S)` 没有被替换、删除或切换。不要通过反复改名或新建便签“修复”，否则会在错误的房间 key 下产生第二组数据。

## ElevenLabs 托管模式

```dotenv
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICES_JSON=[{"id":"...","label":"Alice"},{"id":"...","label":"Bob"}]
ELEVENLABS_MODEL=eleven_flash_v2_5
```

`ELEVENLABS_VOICES_JSON` 是客户端唯一可选的服务端声音白名单。旧的 `ELEVENLABS_VOICE_ID` 仍可作为单一 Default voice。不要把 API Key 放进 web、Electron 生产配置或 Git。

## CosyVoice 托管模式

CosyVoice 3.5 Plus 需使用华北 2（北京）的 API Key、Workspace 和该模型创建的音色 ID：

```dotenv
TTS_PROVIDER=cosyvoice
DASHSCOPE_API_KEY=sk-...
DASHSCOPE_WORKSPACE_ID=ws-...
COSYVOICE_MODEL=cosyvoice-v3.5-plus
COSYVOICE_VOICES_JSON=[{"id":"cosyvoice-v3.5-plus-...","label":"我的中文声音"}]
```

重启 server 后访问 `/api/health`，应看到 `tts: "ready"`、`ttsProvider: "cosyvoice"` 和正确的 `ttsVoices` 数量。CosyVoice 3.5 Plus 没有系统音色，白名单 ID 必须先通过声音复刻或声音设计创建，并且与模型匹配。当前 CosyVoice 只支持服务端托管白名单，不支持控制面板 BYOK。

## 可选 BYOK

仅 ElevenLabs 支持此模式，无需额外环境开关。用户在控制面板选择“使用自己的 API Key”后，server 会向 ElevenLabs 查询该账号可访问的声音，并仅允许从结果中选择。Electron 使用 macOS Keychain / Windows DPAPI 对密钥落盘加密；独立浏览器只保留当前运行内存。

BYOK 并非端到端秘密：生成请求必须经过当前 server。只应在可信、自建的 server 上使用，并只使用本人或已获授权的克隆声音。生产日志和反向代理访问日志不得记录请求体或 Socket.IO payload。

## 反向代理

代理必须支持 WebSocket upgrade，并给 `/api/tts/jobs/` 保持流式响应，关闭响应缓冲。上传请求很小；不要为了 TTS 开启磁盘缓存。
