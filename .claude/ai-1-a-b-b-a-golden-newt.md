# AI 桌宠（远程控制 + VRM 电脑狗）项目规划

## Context

这是你做给女朋友的桌宠——**重点是你能远程控制它陪她**，外加一只**3D 电脑狗**（VRM 标准模型）在她桌面待着。

> **同步说明（按当前仓库实现）**：这份文档已经按当前代码状态重写；如果文档和代码再出现偏差，**以代码为准**。

- **B 端**（女朋友的电脑，Windows，**RTX 4060**——独显性能足够）：3D 电脑狗 VRM 模型，常驻桌面右下角，靠 **VRM lookAt 视线跟随鼠标 + 随机表情 + 鼠标点击反应**显得生动。当前本地 AI 兜底是**快捷键唤起文字输入框 → 文字回复气泡**。
- **开发环境**：你在 **Mac 上写代码**，另一台 **Windows 机器**用于周期性验证桌宠"灵魂"行为（点击穿透、透明边缘、托盘）。详见第十节"开发环境"。
- **A 端**（你，网页）：当前已经是**远程控制台**，能远程指挥小狗（让它做表情、触发动作、播预录音频、用你的声音念出来、换角落）。后续目标再补上看她屏幕和双向语音。
- **美术来源**：你已找好的 VRM 老师，做**标准 humanoid 骨骼**的 .vrm 文件（电脑狗设定，没腿在视觉上合理）。
- **渲染方案**：**不用 MateEngine 壳**（它是 Unity 闭包、没有插件 API、加 WebRTC/远程要 fork Unity）。改用 **Electron + Three.js + `@pixiv/three-vrm`**，自己接管渲染，远程控制和 AI 任意加。
- **声音方案**：你录的 30-50 句台词直接播音频；远程"打字念出来"走一次 ElevenLabs（你的声音克隆）。
- **AI 缩到最小**：当前是 **B 端快捷键打开输入框 → 后端 DeepSeek 回复 → 桌宠气泡显示**；远程"打字念出来"单独走 ElevenLabs。**还没有录音 / STT / 本地 TTS 回放**。
- 用户范围：只给你和她。不需要账号体系。

**不做的事**（明确划掉）：
- ❌ 不到处走路（漂浮的电脑狗设定）
- ❌ 不用 MateEngine 壳（功能不够，扩展要 fork Unity）
- ❌ 不做 OLV 那种 AI 陪伴大框架
- ❌ 不做长期记忆、情绪状态机、MCP
- ❌ 不做账号系统

---

## 一、整体架构

```
┌──────────────────────┐   Socket.IO 控制指令    ┌──────────────────────┐
│  A 端（网页 React）   │ ◄──────────────────────► │  B 端（Electron 桌宠） │
│  - 连接服务器         │                         │  - three-vrm 渲染狗    │
│  - 发表情 / 动作      │         ▲               │  - lookAt 鼠标 + 点击  │
│  - 发预录台词         │         │               │  - 本地文字对话气泡    │
│  - 发 TTS 文本        │         │               │  - 响应远程控制指令    │
│  - 改桌宠位置         │         │               │                       │
└──────────────────────┘         ▼               └──────────────────────┘
           │           ┌───────────────────────┐                  │
           └──────────►│ Node + Socket.IO 服务  │◄─────────────────┘
                       │ (单台 $5 VPS)         │
                       │ - 房间鉴权 / 控制转发  │
                       │ - /api/chat           │
                       │ - /api/tts            │  ← API key 不下发到客户端
                       └───────────────────────┘
                                  │
                                  ▼
                         DeepSeek / ElevenLabs
```

**下一阶段（M4b）预留**：
- A 端网页 ↔ B 端桌宠：补一层 **WebRTC**（屏幕共享 + 双向语音）
- 服务端：补 **offer / answer / ICE** 信令转发
- B 端：补 `desktopCapturer` / 麦克风采集
- A 端：补 `<video>` 预览和 push-to-talk

---

## 二、技术栈

| 模块 | 选型 | 说明 |
|---|---|---|
| B 端外壳 | **Electron** + Vite + TypeScript | 透明无边框窗口 + 点击穿透 |
| 桌宠渲染 | **Three.js + `@pixiv/three-vrm`** | 加载 .vrm，标准 lookAt/表情/SpringBone 全部可用 |
| A 端网页 | React + Vite + socket.io-client | 当前是远程控制台 |
| 实时音视频 | **未实现（预留 WebRTC / simple-peer）** | 下一阶段再接 |
| 信令 / 控制 | **Node + Socket.IO + Express** | 同一进程兼任信令、控制转发、AI 代理 |
| LLM | **DeepSeek API**（OpenAI 兼容） | 当前 `/api/chat` 已接 |
| STT | **未接** | 当前没有录音链路 |
| TTS | **ElevenLabs Voice Cloning** = 你的声音 | Starter $5/月 |
| 部署 | $5 海外 VPS | 控制转发 + AI 代理一台搞定 |

**为什么是裸搭，不是 fork 谁**：
- MateEngine：Unity 闭包，没有插件 API，扩展要 fork Unity 重编
- Open-LLM-VTuber：AI 陪伴大框架，太重
- chiikawa-pets：Electron + Live2D，路线不对
- Electron + three-vrm：库都是 MIT、文档全、社区例子多，glue 代码 300-600 行就能跑

---

## 三、美术资源（VRM 路线）

### 1. 角色设计 ✅ 你已有，老师风格也已认可

### 2. VRM 模型（你的老师做）
- 输出 **标准 .vrm 文件**（VRM 1.0 优先，0.x 也行）
- **必须明确给老师的需求清单**：
  - 标准 humanoid 骨骼（hips/spine/neck/head 必须有；腿可以是隐藏的虚拟骨骼）
  - 表情 BlendShape：`neutral` / `joy` / `sorrow` / `angry` / `surprised` / `blink` / `aa` / `ih` / `ou` / `ee` / `oh`（VRM 标准命名，后面口型同步要用）
  - 视线骨骼：`leftEye` / `rightEye` 必须存在（视线跟随鼠标的核心）
  - SpringBone：**耳朵 + 尾巴**（设了之后会自然摆动，对"活感"贡献巨大）
  - 着色：MToon（卡通渲染，配合电脑狗的塑料/金属质感）
  - **碰撞器**（点击命中用）：在头/身体/尾巴各放一个碰撞器（VRM 自带 SpringBoneCollider 字段，老师懂的）
  - 模型尺寸控制在 5-15MB（贴图压成 1024 以下），冷启动不黑屏太久

### 3. Motion（动作动画）
- VRM 标准动画格式：**VRMA**（`.vrma` 文件，可以用 VRoid Hub / Webaverse 找现成的，也可以自己用 Mixamo+三方工具导）
- 必要动作：
  - **待机**（轻微上下浮动 + 偶尔眨眼）— 1 个循环
  - **随机反应**（歪头、闭眼睡一下、左右摇晃、兴奋） — 4-6 个
  - **被点击反应**（头/身体/尾巴各一种）
- 老师可能不做 VRMA，但**SpringBone 物理 + 几个简单的 BlendShape 切换其实就能盖住 80% 的活感**——动作可以你自己后期用 Three.js 写 tween 补

### 4. 你录的台词
- 30-50 句日常 .wav：
  - 点击各部位反应（"嘿嘿"、"别揪尾巴啦"、"嗯～"）
  - 待机偶尔嘀咕（"想你了"、"你今天还好吗"）
  - 远程召唤台词
- 录的时候保持自然语气、安静环境、相同距离
- 同时录 1-3 分钟样本喂 ElevenLabs 做声音克隆（用于"打字念出来"）

**美术总工期**：等老师交付节奏（应该 1-3 周）；你录音 + 自己跑通技术线可以并行。

---

## 四、程序模块

### 模块 1：B 端 Electron 外壳
- `BrowserWindow({ transparent: true, frame: false, alwaysOnTop: true, hasShadow: false })`
- 默认贴右下角，记住上次位置
- 点击穿透：默认整个窗口穿透；每帧 raycast 鼠标位置 → 命中模型时切换为可点击
- 系统托盘 + 全局快捷键（当前用于打开本地聊天输入框）
- ~100 行

### 模块 2：VRM 渲染层（Three.js + three-vrm）
- `GLTFLoader` + `VRMLoaderPlugin` 加载 .vrm
- `WebGLRenderer({ alpha: true, antialias: false })`（透明背景；MSAA 关，用 postprocessing FXAA 替代以避免边缘黑边）
- 每帧调用：
  - `vrm.update(deltaTime)` —— 驱动 SpringBone 物理（耳朵/尾巴自然摆动）
  - `vrm.lookAt.target = mouseTarget` —— 视线跟头鼠标 ⭐ 这是 VRM 的核心福利
- 表情切换：`vrm.expressionManager.setValue('joy', 1.0)`
- 口型同步：分析 TTS 音频 RMS → 写 `aa`/`ih`/`ou` 三个 BlendShape

### 模块 3：行为层（极简）
- **鼠标跟随**：`screen.getCursorScreenPoint()` → 转换为 Three.js 世界坐标 → `vrm.lookAt.target` 指过去
- **随机 motion 定时器**（每 8-20 秒挑一个表情切换 / 浮动动画）
- **点击命中**：
  - 鼠标 → Three.js Raycaster → 按命中点高度近似区分 head/body/tail
  - 对应播放 BlendShape 表情 + 随机播一句你录的 .wav
- **冷却**：每种交互加 1-2 秒，防止狂点抽搐

### 模块 4：B 端本地文字对话（当前实现）
- 全局快捷键（`Ctrl+Alt+D`）打开聊天输入框
- 输入一句话 → `POST /api/chat`
- 后端调用 DeepSeek，带桌宠人设 prompt
- 桌宠端只显示**回复气泡**
- **当前不做**：录音、STT、本地 TTS 回放

### 模块 5：远程实时音视频（下一阶段 / 未实现）
- 计划库：`simple-peer`
- B 端：`desktopCapturer.getSources()` 抓主屏 + `getUserMedia` 麦克风
- A 端：浏览器 `<video>` 显示 + 麦克风
- 信令仍走 Socket.IO，沿用固定房间

### 模块 6：远程控制指令（A → B）⭐ 项目重点
WebSocket 协议：
```json
{ "type": "expression", "name": "joy" }
{ "type": "animation",  "name": "wag_tail" }
{ "type": "say_audio",  "url": "想你了.wav" }
{ "type": "say_tts",    "text": "我刚开完会，想你了" }
{ "type": "relocate",   "corner": "top-right" }
```

### 模块 7：A 端网页
- React + Vite，当前已经有四块：
  - 连接区：服务器地址 + 房间密钥 + 在线状态
  - 控制区：表情 / 动作按钮
  - 台词区：预录台词列表
  - TTS 区：**"打字念出来"输入框**
  - 位置区：把桌宠贴到四个角

### 模块 8：信令 / 中转服务器
- Node + Express + Socket.IO
- 已有路由：`GET /api/health`、`POST /api/chat`、`POST/GET /api/tts`
- 已有 Socket 能力：房间鉴权、controller/pet 单实例、控制指令转发、台词列表转发
- 预留：WebRTC 信令
- 部署：DigitalOcean / Vultr / Hetzner $5/月

---

## 五、推荐实施顺序

### M1 · B 端骨架（已完成）
- Electron 透明窗口 + Three.js 加载一个**示例 VRM**（VRoid 官方免费模型）
- 默认贴右下角 + 可拖动
- 鼠标移到模型上 → 切换点击穿透
- ✅ 验证：右下角看到 VRM 模型，可拖动，鼠标到模型上能点击，到外面穿透

### M2 · 鼠标跟随 + 点击反应（已完成）
- 用示例模型先打通：`vrm.lookAt` 跟鼠标 / Raycaster 命中 head/body/tail / SpringBone 物理摆动
- 表情 BlendShape 切换 demo
- ✅ 验证：示例模型眼睛/头跟着鼠标看；点三个部位有三种表情反应；耳朵尾巴自然摆动

### M3 · 预录台词 + 本地文字对话（已部分完成）
- 已完成：
  - 后端最小 AI 路由：文字 → DeepSeek → 文字回复
  - 桌宠快捷键打开输入框，本地显示回复气泡
  - ElevenLabs TTS 代理已经接好，供远程 `say_tts` 使用
- 未完成：
  - 本地录音 / Whisper STT
  - 本地 AI 回复语音回放
  - 真实预录台词素材仍待补齐
- ✅ 当前验收：按快捷键能弹输入框并收到桌宠风格的文字回复；点模型时会优先尝试播预录音频

### M4a · 远程控制台（已完成）⭐ 当前里程碑
- 服务端：Socket.IO 房间鉴权 + controller/pet 角色管理 + 指令转发
- A 端网页：连接状态、表情/动作、预录台词、TTS 输入框、位置控制
- B 端：响应所有现有 WS 控制指令
- ✅ 当前验收：你在网页上能连到桌宠，点按钮触发表情/动作/台词/换角落，打字能让她桌面上的狗用你的声音念出来

### M4b · 远程屏幕 + 双向语音（下一阶段）
- 补 WebRTC 信令：offer / answer / ICE
- B 端采集：`desktopCapturer` + 麦克风
- A 端网页：屏幕预览 + 双向语音 + push-to-talk
- ✅ 目标验收：你在外面用浏览器看她屏幕、双向通话、必要时实时讲话

### M5 · 接入你老师的真模型（老师交付后 0.5-1 天）
- 替换示例 VRM 为真模型
- 校准 lookAt 偏移、SpringBone 参数、点击碰撞器位置
- ✅ 验证：M2/M3/M4a/M4b 全部功能在真模型上跑通

### M6（可选）· 长期养护
- 定时任务：每天早晨/睡前自动播一句预录台词
- 模型 LOD / 失焦降帧到 5fps（4060 上其实不需要，但养成习惯）

**当前状态**：项目已完成 **M1 / M2 / M4a**，`M3` 做成了更轻量的文字版；下一步主线是 **M4b（WebRTC）** 与 **补音频素材**。

> **关键解耦**：M1-M4b 全部用 VRoid 官方免费示例模型推进，**完全不用等老师**。等模型到了 M5 一晚上换皮。

---

## 六、预算

| 项 | 估算 |
|---|---|
| VRM 模型外包（你老师） | 已锁定，按你预算 |
| VPS（信令 + AI 代理） | $5/月 |
| DeepSeek API（轻使用） | $1-5/月 |
| ElevenLabs（你的声音克隆） | $5/月（Starter） |
| Whisper STT | 当前未启用；启用后 <$3/月 |

**当前月运营 ≈ $10-15**（不含未来 STT）

---

## 七、关键风险与对策

| 风险 | 对策 |
|---|---|
| **透明边缘锯齿**（WebGL `alpha:true` + MSAA 冲突） | 关 MSAA，用 postprocessing FXAA。可接受不完美的边缘 |
| **没有地面阴影，小狗"飘"** | 电脑狗设定本身就漂浮，不是问题；可以加一个柔和小圆 ContactShadow |
| **点击穿透要自己实现** | 每帧 Raycaster 判断鼠标命中模型 → `setIgnoreMouseEvents` 切换。~150 行 |
| **VRM 冷启动黑屏（加载几百毫秒）** | 显示一个 fade-in loading 占位（一张 PNG），加载完淡入 |
| **API key 不能打进 Electron 包** | 全部走后端代理 |
| **本地预录台词还没放进仓库** | `pet/public/voices/` 先补一批最小可用素材（head/body/tail/idle 各几条） |
| **当前 Node 版本过旧会让 Vite 构建失败** | 开发机统一升到 **Node 20+**；当前 Node 16 会报 `crypto.getRandomValues is not a function` |
| **`desktopCapturer` 在 Win11 权限** | 进入 M4b 时第一次启动要授权，文档里写清楚 |
| **WebRTC NAT 穿透** | 进入 M4b 后大部分家用网络 P2P 能连；连不上再加 TURN（COTURN 自建或 $5/月） |
| **声音克隆效果单调** | 录样本时多种情绪（开心/温柔/平静），各来一段 |
| **老师交付的 VRM 不符合预期**（比如缺 lookAt 骨骼/碰撞器） | M1-M4 用示例模型并行做，先验证管线；M5 验收时拿真模型测 lookAt + raycast，发现问题让老师调整。**这是 M1-M4 不等模型的根本理由** |
| **Mac 上 DevTools 一开透明窗口就破**（Windows 没事） | 调 UI 时切到不透明开发模式开关；或用远程 DevTools |
| **Windows 点击穿透有光标闪烁 bug**（Electron 已知问题，Mac 看不到） | M2 在 Windows 上验收时验证；如果严重就用社区 workaround（监听特定事件抑制） |
| **透明窗口边缘在 Windows 上可能有 1-2 像素 halo**（DWM 异步渲染所致，Mac 看不到） | 把窗口尺寸设大一圈，模型周围留 padding；M2 在 Windows 上首次见到时调 |
| **从 Mac 出 .exe 安装包** | electron-builder + Wine 可以本地出；正式 release 用 GitHub Actions `windows-latest` runner 出（免费、稳） |
| **未签名的 .exe 在 Windows 上会触发 SmartScreen 警告** | 你女朋友第一次安装点"仍要运行"就好，不买证书 |

---

## 十、开发环境

**主开发机：Mac**
**验证机：另一台 Windows**（你已经有）

### 哪些可以在 Mac 上完成（80%）
- Three.js + three-vrm 渲染逻辑（纯 WebGL，跨平台一致）
- 当前 Socket.IO 网络层
- LLM / TTS 后端
- A 端网页（浏览器跑）
- Electron 透明窗口、`globalShortcut`、`Tray` API 看效果
- 当前 M3 文字对话闭环
- 当前 M4a 的全部 A 端功能
- 后续 M4b 的大部分代码也能先在 Mac 上写完

### 必须在 Windows 上验证的（20%——但都是桌宠灵魂）
- 点击穿透：`setIgnoreMouseEvents(true, {forward:true})` 的实际表现（Windows 有光标闪烁 bug）
- 透明窗口边缘像素质量（Windows DWM vs Mac Core Animation 差异）
- `desktopCapturer` 屏幕捕获（**进入 M4b 后再测**；Windows 直接 work，Mac 还要授屏幕录制权限）
- 系统托盘图标
- 全局快捷键在 Windows 上的实际占用情况
- 端到端 .exe 安装包烟雾测试

### 验证节奏
| 频率 | 做什么 |
|---|---|
| 每天 Mac | 写代码、调渲染、网络层、A 端 |
| 每周 1-2 次 Windows | 同步代码到 Windows 机器跑一次，验证桌宠行为 |
| 每个里程碑收尾 | M1/M2/M3/M4a/M4b 完成时都要在 Windows 上完整跑一遍验证清单 |
| 发布前 2-3 天 | 纯 Windows 打磨（光标闪烁/边缘 halo/托盘 UX） |

### .exe 构建
- 日常 dev .exe：Mac 上 `npm install -g electron-builder` + Wine（`brew install --cask wine-stable`），`electron-builder --win` 出 NSIS 安装包
- 正式发布：GitHub Actions `windows-latest` runner（免费、稳、不用本地折腾签名）

### Mac 特有的开发小坑
1. **DevTools 一开，透明窗口变黑** → 开发期加一个 `--dev` flag，开发模式不开 transparent
2. **Node 版本别太老** → 当前 Vite 在 Node 16 上构建会报 `crypto.getRandomValues is not a function`，统一用 **Node 20+**
3. **托盘图标要做两套**：Mac 用 template `.png`（单色，系统自动反色），Windows 用多尺寸 `.ico`

---

## 八、端到端验证清单

- **M1**：右下角出现示例 VRM 模型 → 可拖动 → 鼠标到模型上可点击，到外面不挡其他窗口
- **M2**：鼠标在屏幕动 → 模型头/眼跟着看 → 戳头/身体/尾巴有三种表情 → 耳朵尾巴自然摆动
- **M3（当前）**：按快捷键弹输入框 → 输入一句话 → 桌宠弹出一条符合人设的文字回复气泡
- **M4a（当前）**：
  - 网页输服务器地址和密钥 → 成功连上桌宠
  - 点表情 / 动作按钮 → B 端模型立刻响应
  - 网页打"想你了" → 她桌面小狗用你声音念出来 → 嘴同步
  - 点位置按钮 → 桌宠贴到对应角
- **M4b（目标）**：
  - 打开网页 → 看到她屏幕 → 双向通话清晰
  - Push-to-talk → 实时人声能从对端正常传过去
- **M5**：以上全部在你老师的真模型上跑通

---

## 九、当前可以立刻开始做的事

按"最值得继续推进"的顺序：

1. **给老师确认 VRM 交付规范清单**（避免做完发现缺关键功能）
   - 标准 humanoid 骨骼
   - 表情 BlendShape 命名（neutral/joy/sorrow/angry/surprised/blink/aa/ih/ou/ee/oh）
   - 视线骨骼 leftEye/rightEye
   - SpringBone：耳朵 + 尾巴
   - 头/身体/尾巴各放一个碰撞器（点击命中用）
   - MToon 着色
   - 模型 < 15MB，贴图 ≤ 1024
2. **补最小可用的预录音频素材**
   - `head_*.wav` / `body_*.wav` / `tail_*.wav` / `idle_*.wav`
   - 先每类 2-3 条，够把点击反馈和远程台词真正跑起来
3. **统一开发环境到 Node 20+**
   - 当前 Node 16 会让 `web` / `pet` 的 Vite 构建失败
4. **继续做 M4b（WebRTC）**
   - 先补服务端 offer / answer / ICE 转发
   - 再补 B 端 `desktopCapturer` + 麦克风
   - 最后补 A 端 `<video>` 和通话 UI
5. **补 Windows 实机验证**
   - 点击穿透
   - 边缘 halo
   - 托盘 / 快捷键
6. **等老师交模后做 M5 换皮**
   - 替换 `sample.vrm`
   - 校准 lookAt / SpringBone / 点击区

---

> 这份计划只覆盖到"你和她能用"。如果以后想发给朋友用，再加邀请码/多房间即可，不必动主架构。
