# Desktop Pet

一个双人远程桌宠：双方安装同一个 Electron 客户端，即可控制对方桌宠、互相查看屏幕和通话，并让对方桌宠用自己的克隆声音播放文字消息。

## 当前能力

- Electron 同时包含透明桌宠窗口与内置 Web 控制面板。
- 一个房间严格容纳两名参与者；第三人会收到“房间已满”。
- 控制命令只发给对方桌宠。
- WebRTC 传输屏幕和通话媒体；server 只负责鉴权、状态、信令与命令转发。
- 语音消息支持 ElevenLabs 或 CosyVoice 服务端白名单；ElevenLabs 另支持用户自带 API Key（BYOK）。
- 控制面板仍可作为独立浏览器页面运行。

## 快速开始

需要 Node.js 20。复制 `server/.env.example` 为 `server/.env`，至少修改 `ROOM_SECRET`，然后分别启动：

```bash
npm install --prefix server
npm install --prefix web
npm install --prefix pet
npm run dev:server
npm run dev:pet:local
```

生产环境应给 server 配置 HTTPS。两台客户端填写相同服务器地址和房间密钥后，会以各自稳定的 `participantId` 加入同一房间。

## 克隆语音

托管模式由部署者配置 `ELEVENLABS_API_KEY` 和 `ELEVENLABS_VOICES_JSON`。BYOK 模式允许使用者输入自己的 ElevenLabs API Key，并从该账号可访问的声音中选择。Electron 把密钥加密保存在系统安全存储；独立浏览器不会持久化密钥。无论哪种模式，服务端都不会将音频写入磁盘。

中文声音也可将 server 的 `TTS_PROVIDER` 设为 `cosyvoice`，并配置北京地域的 DashScope API Key、Workspace ID 和 `COSYVOICE_VOICES_JSON`。CosyVoice 通过 WebSocket 流式生成 MP3，再由 server 转为桌宠现有的一次性 HTTP 音频流；当前仅支持服务端托管白名单。

请只使用本人声音或已获得明确授权的声音。使用第三方部署的 server 时，BYOK 密钥会在生成语音期间经过该 server，因此必须信任其运营者。

## 仓库结构

- `server/`：Express + Socket.IO 房间服务、WebRTC 信令和多供应商 TTS 流式代理。
- `web/`：React + Vite 控制面板，可独立运行或内置进 Electron。
- `pet/`：Electron 桌宠、控制面板宿主和跨平台打包配置。
- `Mate-Engine/`：可选 Unity 方向，不属于当前 v1 工作流。

## 文档

- [架构](docs/architecture.md)
- [部署](docs/deployment.md)
- [发布与打包](docs/releases.md)
- [故障排查](docs/troubleshooting.md)
- [版本路线](docs/roadmap.md)
