# 部署

## Linux server

服务器需要 Node.js 20。Release 中的 Linux 压缩包已包含生产依赖；解压、复制 `.env.example` 为 `.env`、填写配置后运行 `./start-linux.sh`。源码部署也可以执行：

```bash
npm ci --prefix server --omit=dev
npm start --prefix server
```

建议用 systemd 守护进程，并在 Caddy 或 Nginx 后提供 HTTPS。普通 HTTP 会导致浏览器麦克风权限和 WebRTC 受限。

公网两端无法稳定 P2P 时，按 [Ubuntu 24.04 coturn 部署手册](./ubuntu-coturn-deployment.md) 配置自建 STUN 与 TURN 音频兜底。Release 的 `server/deploy/` 已包含幂等部署脚本和配置模板。

## 房间配置

`ROOM_SECRETS` 使用英文逗号配置多个允许的密钥；未设置时使用 `ROOM_SECRET`。房间密钥只用于入房，不会以明文广播。每个密钥对应一个严格双人房间。

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
