# 迁移计划：Electron → Mate Engine (Unity C#)

  

## Context

  

当前项目是 Electron + Three.js 的桌宠应用，B 端（宠物窗口）用 TypeScript 实现了 VRM 渲染、AB Socket.IO 通讯、WebRTC 屏幕共享、TTS 播放、AI 聊天等功能。

  

用户决定放弃 Electron B 端，改以 Mate Engine（Unity 6, C#, AGPL v3）为基底重做 B 端，以获得更好的物理表现、互动感和平台整合。已完成的 **服务器和 A 端（web/）代码无需改动**，只需在 Unity 端重新实现 B 端逻辑。

  

---

  

## 架构保留的部分（不动）

  

| 模块 | 文件 | 状态 |

|---|---|---|

| 中继服务器 | `server/src/index.js` | 完全保留 |

| AI 人设 | `server/src/prompts.js` | 完全保留 |

| A 端控制 UI | `web/src/App.tsx` + `api.ts` | 完全保留 |

  

Socket.IO 事件合约、命令 JSON 格式、HTTP API 端点均不变。

  

---

  

## Unity B 端需要实现的功能（按优先级）

  

### 阶段 1：连通性（最小可用版本）

  

**1. Socket.IO 客户端**

- 推荐库：[socket.io-client-csharp](https://github.com/itisnajim/SocketIOUnity)（已有 Unity 包装）

- 实现：连接 `SERVER_URL`，发送 `pet:join { secret, role: 'pet' }`，处理 ack 回调

- 监听事件：`pet:command`, `room:peers`, `room:kicked`

- 响应 ack 查询：`pet:list-voices`（返回语音文件列表），`pet:list-motions`（返回动作清单）

  

**2. 命令分发器（`HandleRemoteCommand`）**

命令格式（与现有 A 端完全相同）：

```json

{ "type": "expression", "name": "joy", "strength": 0.8, "holdMs": 1500 }

{ "type": "animation", "name": "wave" }

{ "type": "say_audio", "url": "http://server/voices/idle_1.wav" }

{ "type": "say_tts", "text": "你好呀" }

{ "type": "relocate", "corner": "bottom-right" }

```

实现方式：JSON 反序列化后 switch-case，调用 Mate Engine 对应的 API。

  

**关键映射：**

- `expression` → Mate Engine 的 BlendShape/表情 API（需要研究 Mate Engine 的 `ExpressionController` 或类似组件）

- `animation` → Mate Engine 的动作播放 API

- `relocate` → Mate Engine 的窗口定位 API（Win32 `SetWindowPos`，源码中已有）

  

### 阶段 2：音频 + 对口型

  

**3. 音频播放 + FFT 对口型**

- 使用 `UnityWebRequest` 下载音频 URL，用 `AudioClip` / `AudioSource` 播放

- 用 `AudioSource.GetSpectrumData()` 采样频谱，驱动 `aa`（嘴型）BlendShape

- 口型权重 = `Mathf.Lerp(current, energy * scale, smoothing)` 每帧更新

  

**4. 语音文件分桶**

- 扫描 StreamingAssets 中的 voices 目录，按前缀 `head_`/`body_`/`tail_`/`idle_` 分组

- 响应 `pet:list-voices` ack 时返回此列表

  

### 阶段 3：交互

  

**5. 点击反应**

- 在 VRM 模型上配置碰撞体（或使用 Mate Engine 现有交互系统）

- 根据命中点 Y 坐标分类：头部 → joy，身体 → surprised，尾部 → angry

- 触发表情 + 随机播放对应分区语音 + 冷却 1.5s

  

**6. AI 聊天气泡**

- `UnityWebRequest.Post(SERVER_URL + "/api/chat", json)` 请求 AI 回复

- 用 Mate Engine 的 UI 或自定义 Canvas 显示文字气泡（淡入淡出）

- 快捷键（`Ctrl+Alt+D` 或类似）切换聊天输入框

  

### 阶段 4：WebRTC（最复杂，可选后做）

  

**7. 屏幕共享 + 麦克风**

- 使用 [com.unity.webrtc](https://docs.unity3d.com/Packages/com.unity.webrtc@latest/) 官方包

- B 端捕获屏幕（`Screen.captures` 或 Windows GDI）+ 麦克风，添加 track

- 处理 `webrtc:signal` 信令（offer/answer/ICE）通过 Socket.IO 中转

- 播放来自 A 端的音频 track（PTT 语音）

  

---

  

## 文件结构（Unity 项目内新增）

  

```

Assets/

PetRemote/

Scripts/

RemoteManager.cs ← Socket.IO 连接 + 事件分发（阶段1）

CommandDispatcher.cs ← HandleRemoteCommand switch-case（阶段1）

VoicePlayer.cs ← 音频下载/播放 + 对口型（阶段2）

VoiceLibrary.cs ← 语音文件扫描分桶（阶段2）

MotionLibrary.cs ← 动作清单读取（阶段1）

ReactionController.cs ← 点击分区 + 表情反应（阶段3）

ChatOverlay.cs ← AI 聊天 HTTP + 气泡 UI（阶段3）

WebRtcBridge.cs ← WebRTC 屏幕共享（阶段4）

Resources/

motions/manifest.json ← 复制自现有 pet/public/motions/manifest.json

StreamingAssets/

voices/ ← 复制自现有 pet/public/voices/

```

  

---

  

## 关键依赖

  

| 功能 | Unity 包 |

|---|---|

| Socket.IO | `io.github.itisnajim.socketiounity` 或 `com.unity.nuget.newtonsoft-json` + `best.http.socketio` |

| WebRTC | `com.unity.webrtc` (Unity 官方包) |

| JSON | `Newtonsoft.Json` for Unity (已被 Socket.IO 客户端依赖) |

| HTTP | `UnityWebRequest` (内置) |

  

---

  

## 服务器/A 端需要的唯一改动

  

**无**。命令 schema 和 socket 协议完全相同。A 端不需要知道 B 端是 Electron 还是 Unity。

  

---

  

## 风险点

  

### 风险 1：AGPL 传染性（高影响，需决策）

Mate Engine 使用 AGPL v3。你的 fork + 修改如果要分发给任何人（包括女友），**必须开源你所有的修改**，包括 AB 通讯代码、角色人设逻辑等。

- **影响：** 私密内容（人设提示词、角色故事）会被迫公开

- **规避：** 完全不分发（只在自己机器运行）则 AGPL 不触发；或把私密数据放服务器端（已经这样做了）
- 解决：不分发

  

### 风险 2：表情/动作 API 不稳定（中等）

Mate Engine 内部的表情系统（`VRMBlendShapeProxy`、`UniversalBlendshapes`、`DummyToUniversalSync`）是非正式 API，随版本迭代可能改名/重构。目前没有正式的公开 API 文档。

- **影响：** 升级 Mate Engine 版本时代码可能失效

- **规避：** 在 fork 时锁定版本，或写一个适配层 (`ExpressionBridge.cs`) 隔离变更


  

### 风险 3：Unity WebRTC 屏幕捕获（高复杂度）

现有 Electron B 端用 `desktopCapturer` 捕获屏幕非常简单。Unity 的 `com.unity.webrtc` 包支持 WebRTC，但屏幕捕获 API (`Screen.captures`) 在 Windows standalone 模式下有已知不稳定性，且每帧捕获屏幕对 GPU 有额外压力。

- **影响：** WebRTC 功能可能需要额外 2-4 天调试

- **规避：** WebRTC 放到最后做（阶段4），先确认其他功能全部正常
- 解决：未知

  

### 风险 4：Socket.IO 客户端 C# 库成熟度（中等）

`SocketIOUnity`（主流 Unity Socket.IO 客户端）支持 Socket.IO v4，但 ack 回调机制在部分版本有 bug。你的服务器用了 ack 回调（`pet:list-voices`、`pet:list-motions`）。

- **影响：** 如果 ack 不工作，A 端的语音列表和动作列表功能失效

- **规避：** 先用 `BestHTTP/2` 的 Socket.IO 模块（商业库，但更稳定），或自己实现一个简单的 ack 计时器

  

### 风险 5：仅支持 Windows（已知限制）

Mate Engine 用 Win32 API 做透明窗口，macOS 支持有限。你的当前 Electron 版本在 macOS 运行（项目路径 `/Users/deequoique/...`）。

- **影响：** 如果你用 macOS，迁移后需要验证 Mate Engine 的 macOS 支持（或用 UniWindowController 的 macOS 路径）

- **规避：** Mate Engine 源码中用的 `UniWindowController` 支持 macOS；核查 Mate Engine 是否关掉了 macOS 构建
- 解决：不需要支持macos

  

### 风险 6：VRM 模型文件路径和加载时机

Mate Engine 有自己的 VRM 加载流程（用户在运行时选择 `.vrm` 文件）。你现有的 `sample.vrm` 和 `/motions/manifest.json` 需要适配 Mate Engine 的加载逻辑。

- **影响：** 不能简单复制文件，需要了解 Mate Engine 的 VRM 加载时机，在加载完成后再初始化 RemoteManager

- **规避：** 监听 Mate Engine 的 VRM 加载事件（`VRMLoader` 组件有回调），在 `OnVRMLoaded` 后初始化

- 解决：直接用它的vrm加载流程

---

  

## 验证方式

  

1. 启动 server：`cd server && npm run dev`

2. 打开 A 端：`cd web && npm run dev`

3. 在 Unity Editor 中运行游戏（Play Mode）

4. A 端显示 `pet: ✓` → Socket.IO 连通

5. 点击表情按钮 → Unity 中角色表情变化

6. 点击动作按钮 → 角色播放 VRMA 动作

7. 输入 TTS 文本 → 角色嘴型同步动，气泡显示文字

8. WebRTC 通话：A 端点击通话 → Unity 端发送屏幕视频流

  

---

  

## 工作量估计

  

| 阶段 | 预估 |

|---|---|

| 阶段1（连通+命令分发） | 1-2 天 |

| 阶段2（音频+对口型） | 1 天 |

| 阶段3（交互+聊天） | 1 天 |

| 阶段4（WebRTC） | 2-3 天 |

  

Mate Engine 源码的表情/动作 API 需要先阅读确认具体调用方式，这是阶段 1 的前置工作。