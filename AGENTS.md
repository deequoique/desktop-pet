# Codex 项目便签

这个仓库是桌宠 monorepo。后续 Codex 会话应优先阅读本文件，再根据需要查看 `README.md`。

## 默认范围

- v1 当前目标是 `server/` + `web/` + Electron `pet/` 的最简可运行系统。
- 默认不要进入 `Mate-Engine/`。它是后续/可选 Unity 方向，包含大量生成资产、包、shader、prefab 和 vendor 文件；只有用户明确要求 Unity 工作时才检查。
- Web、server、权限、WebRTC、Socket.IO、远程控制、Windows 打包、自动更新、生产配置问题，都从 `web/`、`server/`、`pet/` 开始。
- 搜索时优先排除 Unity 资产，例如：
  `rg -n "webrtc|permission|getUserMedia|pet:join" --glob '!Mate-Engine/**'`

## 当前 v1 架构

- `server/`：Node + Express + Socket.IO 中继，默认端口 `3030`。负责 `ROOM_SECRET` 校验、角色注册、控制指令转发、WebRTC 信令转发、聊天和 TTS 代理。
- `web/`：React + Vite 控制台，默认端口 `5174`。作为 `controller` 连接 server，发送桌宠指令，请求浏览器麦克风权限，并接收 pet 推来的屏幕/音频。
- `pet/`：v1 桌宠本体，Electron + Vite。作为 `pet` 连接 server，渲染 VRM，执行远程指令，采集屏幕/麦克风并通过 WebRTC 发布；目标是打包成女朋友电脑上一键运行的 Windows 安装包。
- `Mate-Engine/`：Unity 方向暂不纳入 v1 默认工作流。

## 消息流与 Socket.IO 事件

1. `web/src/api.ts` 连接 server。
2. web 作为 controller 发送 `pet:join`，payload 为 `{ role: "controller", secret }`。
3. `pet/src/renderer/main.ts` 作为 pet 发送 `pet:join`，payload 为 `{ role: "pet", secret }`。
4. `server/src/index.js` 校验 `ROOM_SECRET`，每个角色只保留一个 socket id，并广播 `room:peers`。
5. controller 发出的 `pet:command` 只转发给当前在线 pet。

重要 Socket.IO 事件：

- `pet:join`：共享密钥入房和角色注册。
- `pet:command`：controller 到 pet 的动作、表情、位置、TTS 指令转发。
- `pet:list-voices`：controller 请求 pet 的预录台词列表，server 做 ack 链式转发。
- `pet:list-motions`：controller 请求 pet 的动作列表，server 做 ack 链式转发。
- `webrtc:signal`：双向 WebRTC SDP/ICE 信令转发，server 不解析媒体内容。
- `webrtc:hangup`：双向通话结束。
- `webrtc:error`：双向通话错误。

## 生产部署与配置

- server 生产环境推荐放在 Caddy 或 Nginx 后面，用 HTTPS 域名访问；Let’s Encrypt 免费证书优先。
- 如果暂时只有 HTTP，动作/表情/房间连接可先跑；浏览器麦克风和 WebRTC 通话可能因非安全上下文失败。
- `server/.env` 保存 server 侧真实密钥，参考 `server/.env.example`，不要提交真实 `.env`。
- `pet/config/production.json` 是 Electron pet 的生产配置，包含 server URL 和房间密钥，已被 `.gitignore` 忽略；模板是 `pet/config/production.example.json`。
- `web/.env.example` 提供 `VITE_PET_SERVER_URL` 和 `VITE_PET_ROOM_SECRET` 示例；web 仍允许手动输入并写入 localStorage。
- 打包后的 Electron pet 优先读取 `resources/config/production.json`；开发时可读取 `pet/config/production.json`；没有配置时回退到 `PET_SERVER_URL`、`PET_ROOM_SECRET` 或本地默认值。

## Windows 打包与更新

- `pet/package.json` 使用 `electron-builder` 生成 Windows NSIS 安装包。
- `electron-updater` 使用 GitHub Releases 作为 v1 自动更新源。
- `.github/workflows/pet-release.yml` 在 `v*` tag 或手动触发时构建安装包，并从 GitHub Secrets 生成 `pet/config/production.json`。
- 需要的 GitHub Secrets：
  - `PET_SERVER_URL`
  - `PET_ROOM_SECRET`
- 如果仓库是 private，不要把 GitHub token 打进客户端；v1 最省心是让 release 资产可公开访问，或后续改成自有服务器的 generic 更新源。

发布流程：

1. 保持 `master` 为稳定可运行分支。
2. 功能开发使用独立分支，例如 `codex/v1-runtime`、`codex/pet-packaging`、`codex/webrtc-diagnostics`。
3. 发布前更新 `pet/package.json` 版本号。
4. 创建 `v1.0.0` 这类 tag。
5. GitHub Actions 构建 Windows NSIS 安装包并上传 GitHub Releases。
6. 已安装的 Electron app 通过 `electron-updater` 检查 GitHub Releases 更新。

## WebRTC 与带宽判断

- 当前方案是 server 只做信令，不主动承载视频/音频媒体流。
- WebRTC 优先点对点：IPv6 直连、IPv4 NAT 打洞、局域网/公网 host candidate。
- v1 默认不自建 TURN；只有真实网络测试经常失败时，再在 v1.1 考虑 coturn、第三方 TURN 或更高带宽服务器。
- controller 侧通话逻辑主要在 `web/src/App.tsx`：
  - `ensureLocalAudio()` 请求浏览器麦克风权限。
  - `ensurePeerConnection()` 创建 `RTCPeerConnection`，添加本地音频，并创建 recvonly 视频 transceiver。
  - `sendSignal()` 在 `web/src/api.ts` 中发送 SDP/ICE payload 到 server。
  - `syncRemoteMediaState()` 把远端轨道挂到 `<video>`。
  - `readRtcRoute()` 通过 `RTCPeerConnection.getStats()` 读取当前选中的 ICE candidate 类型。
- `web/src/App.tsx` 里有 ICE candidate 诊断：
  - `host`：局域网或公网地址直连。
  - `srflx` / `prflx`：STUN 打洞成功。
  - `relay`：走 TURN 中继，会吃 TURN 带宽。
  - `failed`：点对点连接失败。

## 权限与通话排查

当 UI 提示通话没权限或无法接通，优先检查：

- 浏览器麦克风权限：`web/src/App.tsx` 的 `ensureLocalAudio()` 和 `navigator.mediaDevices.getUserMedia(...)`。
- 浏览器安全上下文：`getUserMedia` 通常允许 `localhost` 和 HTTPS；普通 HTTP 域名或 LAN HTTP 地址可能失败。
- server 房间鉴权：`server/src/index.js` 的 `ROOM_SECRET`、`pet:join` 和角色转发逻辑。
- pet 侧屏幕/音频采集：`pet/src/renderer/main.ts` 的 WebRTC 媒体采集路径。
- 如果 web 能连上但没有画面，先看 web 控制台的 ICE 类型和 pet 端屏幕采集日志。

## 编辑准则

- TypeScript 是源头：优先改 `web/src/*.tsx`、`web/src/*.ts` 和 `pet/src/renderer/*.ts`。
- `web/src/*.js` 是已有生成/兼容文件；只有项目当前确实依赖时才同步更新。
- 不要运行全仓库大范围搜索扫 `Mate-Engine/`，输出噪声大且慢。
- 文档更新保持短、准、可操作，方便后续会话快速恢复上下文。
- 真实密钥、生产 `production.json`、`.env`、打包产物和 release 目录不要提交。

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
