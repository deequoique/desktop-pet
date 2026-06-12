# Desktop Pet

基于 Unity + Socket.IO 的 Windows 桌面宠物，支持 VRM 模型、远程动作/表情控制、语音合成和 AI 对话。

## 项目结构

```
desktop-pet/
├── Mate-Engine/   # Unity 主程序（桌面宠物本体）
├── server/        # Socket.IO 中继服务器
├── web/           # 远程控制网页
└── pet/           # 旧版 Electron 实现（已废弃）
```

## 各模块说明

### Mate-Engine（Unity）

桌面宠物的渲染和逻辑核心，使用 Unity 6000.2.6f2 开发。

**主要功能：**
- 运行时加载 VRM / `.me` 格式模型
- VRMA 动画播放系统
- 窗口透明、置顶、吸附其他 Windows 应用窗口
- 表情混合控制（UniversalBlendshapes）
- 通过 Socket.IO 接收远程指令（PetRemote 模块）
- Steam Workshop 支持
- 本地 LLM 对话（LLMUnity + Qwen）

**主场景：** `Assets/MATE ENGINE - Scenes/Mate Engine Main.unity`

**注意：** 此项目深度依赖 Win32 API，透明窗口、窗口吸附等核心功能仅在 Windows 上生效。Mac 可以编辑代码，但无法预览完整效果。

**打开项目：**
1. 安装 Unity 6000.2.6f2
2. 用 Unity Hub 打开 `Mate-Engine/` 目录
3. 第一次打开时选择 `Enter Safe Mode`，然后 `Exit Safe Mode`
4. 在 `File → Build Profiles` 中将平台切换为 Windows

---

### server（Node.js）

Socket.IO 中继服务器，负责转发控制端和宠物端之间的消息，同时提供 AI 对话和 TTS 接口。

**端口：** `3030`

**主要接口：**

| 接口 | 说明 |
|------|------|
| `GET /api/health` | 服务健康检查 |
| `POST /api/chat` | 文字对话（DeepSeek） |

**Socket.IO 事件：**

| 事件 | 方向 | 说明 |
|------|------|------|
| `pet:join` | 客户端 → 服务器 | 加入房间（需要 roomSecret） |
| `pet:command` | 控制端 → 宠物端 | 发送动作/表情指令 |
| `pet:list-voices` | 控制端 → 宠物端 | 获取可用语音列表 |
| `pet:list-motions` | 控制端 → 宠物端 | 获取可用动作列表 |
| `webrtc:signal` | 双向 | WebRTC 信令转发（语音通话） |

**环境变量（`server/.env`）：**

```env
DEEPSEEK_API_KEY=      # DeepSeek 对话 API Key
DEEPSEEK_MODEL=        # 默认 deepseek-chat
ELEVENLABS_API_KEY=    # ElevenLabs TTS Key
ELEVENLABS_VOICE_ID=   # 语音 ID
ROOM_SECRET=           # 房间密钥，默认 change-me
PET_PERSONA=           # 宠物人设名称
PORT=3030
```

**启动：**
```bash
cd server
npm start
# 开发模式（热重载）
npm run dev
```

---

### web（React）

手机或浏览器端的远程控制界面，运行在 `5174` 端口。

**功能：**
- 发送表情指令（开心 / 吃惊 / 委屈 / 生气 / 眨眼 / 平静）
- 触发动作（从宠物端获取动作列表）
- 文字对话（通过 server 转发给 DeepSeek）
- WebRTC 语音通话

**启动：**
```bash
cd web
npm run dev
```

---

## 完整启动流程（Windows）

```bash
# 1. 启动服务器
cd server && npm start

# 2. 启动远程控制网页（可选）
cd web && npm run dev

# 3. 在 Unity Editor 中打开 Mate-Engine 并 Play
#    或运行打包好的 .exe
```

Unity 启动后会自动连接 `localhost:3030`，控制端打开 `http://localhost:5174` 即可操作。

---

## 开发说明

### 同步上游 Mate-Engine 更新

```bash
cd Mate-Engine
git fetch upstream
git merge upstream/main
```

### 新增动作

将 `.vrma` 文件放入 `Assets/MATE ENGINE - Animations/`，重启 Unity 后会自动扫描入库。

### 修改宠物人设

编辑 `server/src/prompts.js`，新增 persona 对象，通过环境变量 `PET_PERSONA` 切换。

---

## 依赖环境

| 工具 | 版本 |
|------|------|
| Unity | 6000.2.6f2 |
| Node.js | 18+ |
| 操作系统 | Windows（运行）/ 任意（开发） |
