# Desktop Pet

v1 目标是先做一个可运行、可远程控制、可给女朋友一键安装的最简桌宠系统。

当前 v1 由三部分组成：

- `server/`：部署到服务器的轻量中继，负责房间密钥校验、Socket.IO 转发、WebRTC 信令、聊天和 TTS 代理。
- `web/`：你自己使用的浏览器控制台，负责发送表情、动作、位置、语音和通话请求。
- `pet/`：给女朋友电脑安装的 Electron Windows 桌宠，v1 的桌宠本体。

`Mate-Engine/` 是后续 Unity 方向，v1 默认不走它。除非明确做 Unity 工作，否则优先在 `server/`、`web/`、`pet/` 内解决问题。

## 项目结构

```text
desktop-pet/
├── server/        # Node + Express + Socket.IO relay
├── web/           # React + Vite controller
├── pet/           # Electron desktop pet for v1
├── Mate-Engine/   # Unity track, future/optional
└── AGENTS.md      # Codex session notes and architecture map
```

## v1 运行方式

推荐生产拓扑：

```text
你的浏览器 web  ─┐
                 ├─ HTTPS domain / Socket.IO signaling ─ server
她的 Windows pet ┘

WebRTC 媒体流优先点对点，不主动走 server 中继。
```

server 只承担信令和控制消息。视频/音频通话优先通过 WebRTC ICE 直连，包括 IPv6 直连、IPv4 NAT 打洞和局域网 host candidate。只有后续引入 TURN 时，视频流才会经过中继并消耗中继服务器带宽。

web 控制台会显示当前 ICE candidate 类型：

- `host`：局域网或公网地址直连。
- `srflx` / `prflx`：STUN 打洞成功。
- `relay`：走 TURN 中继，会吃 TURN 带宽。
- `failed`：点对点连接失败。

## server

端口默认 `3030`。

主要接口：

| 接口 | 说明 |
| --- | --- |
| `GET /api/health` | 健康检查 |
| `POST /api/chat` | DeepSeek 文字对话 |
| `GET/POST /api/tts` | ElevenLabs TTS 代理 |

主要 Socket.IO 事件：

| 事件 | 说明 |
| --- | --- |
| `pet:join` | 通过 `ROOM_SECRET` 加入房间，角色为 `controller` 或 `pet` |
| `pet:command` | web 发给 pet 的动作/表情/位置/TTS 指令 |
| `pet:list-voices` | web 请求 pet 当前可用预录台词 |
| `pet:list-motions` | web 请求 pet 当前可用动作 |
| `webrtc:signal` | 双向 WebRTC SDP/ICE 信令转发 |
| `webrtc:hangup` | 双向通话结束 |
| `webrtc:error` | 双向通话错误 |

生产环境变量参考 `server/.env.example`：

```env
ROOM_SECRET=change-me
PORT=3030

# 可选：AI 对话
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=https://api.deepseek.com/chat/completions

# 可选：TTS
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
ELEVENLABS_MODEL=eleven_multilingual_v2

PET_PERSONA=self_oc
```

启动：

```bash
cd server
npm install
npm start
```

建议生产环境在 server 前面放 Caddy 或 Nginx，并用 Let’s Encrypt 免费证书。Caddy 配置可以很小：

```caddyfile
pet.example.com {
  reverse_proxy localhost:3030
}
```

如果暂时只有 HTTP，表情、动作、房间连接通常可以先跑；浏览器麦克风和 WebRTC 通话可能因为非安全上下文受限。

## web

web 是你的控制台，开发端口默认 `5174`。

```bash
cd web
npm install
npm run dev
```

默认会读取：

- `VITE_PET_SERVER_URL`
- `VITE_PET_ROOM_SECRET`

如果没有配置，会使用 `http://localhost:3030` 和 `change-me`。控制台里仍然可以手动填写 server URL 和密钥，并保存到 `localStorage`。

## pet

`pet/` 是 v1 的 Electron 桌宠本体。开发启动：

```bash
cd pet
npm install
npm run dev
```

本地联调 server + pet：

```bash
npm run dev:pet:local
```

生产包配置来自 `pet/config/production.json`，真实文件不会提交进 Git。模板见：

```bash
pet/config/production.example.json
```

格式：

```json
{
  "serverUrl": "https://pet.example.com",
  "roomSecret": "change-me"
}
```

Windows 安装包：

```bash
cd pet
npm run dist:win
```

正式发布推荐使用 GitHub Actions：创建 `v*` tag 后，`.github/workflows/pet-release.yml` 会在 Windows runner 上构建 NSIS 安装包并上传到 GitHub Releases。自动更新使用 GitHub Releases 作为更新源。

注意：如果仓库是 private，已安装的客户端通常无法匿名读取 GitHub Releases 更新信息。不要把 GitHub token 打进客户端；v1 最省心是让 release 可公开访问，或后续改成自有服务器的 generic 更新源。

## HTTPS 与证书

v1 推荐 Let’s Encrypt 免费证书，不建议为普通 DV SSL 单独花钱。免费证书对这个项目足够：

- 浏览器信任。
- 支持 WebRTC 所需安全上下文。
- Caddy / Certbot 可自动续期。

如果以后要提升 Windows 安装包可信度，优先考虑代码签名证书，而不是付费网站 SSL。

## Git 与版本控制

建议约定：

- `master` 保持稳定可运行。
- 功能开发使用独立分支，例如 `codex/v1-runtime`、`codex/pet-packaging`、`codex/webrtc-diagnostics`。
- commit 按功能点拆分：文档、pet 配置、打包、自动更新、WebRTC 诊断。
- 正式版本用 tag 标记：
  - `v1.0.0`：第一个可安装、可远程控制版本。
  - `v1.0.1`：bugfix。
  - `v1.1.0`：新增 TURN 或更完整通话能力。
- GitHub Releases 存放 Windows 安装包和自动更新文件。

## 常用命令

```bash
npm run dev:server
npm run dev:web
npm run dev:pet
npm run dev:pet:local
npm run build:web
npm run build:pet
npm run dist:pet:win
```

排查 web/server/pet 时，默认避开 Unity 资产：

```bash
rg -n "getUserMedia|webrtc|pet:join|ROOM_SECRET" --glob '!Mate-Engine/**'
```
