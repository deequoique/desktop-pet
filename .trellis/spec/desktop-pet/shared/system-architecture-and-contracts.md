# 系统架构与契约

## 当前产品边界

当前产品是一个小型根目录 monorepo：

| 运行时 | 职责 | 主要源码依据 |
| --- | --- | --- |
| `server/` | Express health/TTS HTTP endpoint、Socket.IO 房间、鉴权、信令、命令转发和内存 TTS job | `server/src/index.js`、`server/test/rooms.test.js` |
| `web/` | React 控制面板、controller 侧 Socket.IO adapter 和 WebRTC peer | `web/src/App.tsx`、`web/src/api.ts` |
| `pet/` | Electron main/preload process，以及命令式 Three.js/DOM pet renderer | `pet/src/main/index.js`、`pet/src/main/preload.js`、`pet/src/main/control-preload.js`、`pet/src/renderer/main.ts` |
| `Mate-Engine/` | 可选 Unity submodule | 根目录 `README.md` 明确说明它不属于当前 v1 工作流 |

除非任务明确针对 Unity 方向，否则不要把普通产品功能写入 `Mate-Engine/`。

## 参与者与房间模型

每个已安装客户端使用同一个稳定 `participantId` 提供两个 Socket.IO endpoint：`pet/src/renderer/main.ts` 建立 `pet` endpoint，`web/src/api.ts` 建立 `controller` endpoint。Electron main process 把稳定 ID 写入 `userData` 下的 pairing 文件；独立浏览器模式则写入 `localStorage`。

server 对配置的房间密钥做 hash，并且只保存 hash。每个房间最多两个参与者，每个参与者的每种角色最多一个 socket。同一角色重连时，只替换该参与者之前的 socket。命令和查询通过 `otherParticipant(...)` 路由，不能回发给发送者。这些不变量实现在 `server/src/index.js`，并由 `server/test/rooms.test.js` 覆盖。

修改 pairing 或 presence 时：

- pet 和内置 controller 必须使用同一个稳定 `participantId`。
- `room:peers` 始终从当前参与者视角返回；兼容字段 `pet` 和 `controller` 表示远端 endpoint。
- 完全断线的参与者仍应保留 grace period 后再释放位置。
- 除非任务明确移除兼容性，否则保留未发送 `participantId` 的旧客户端行为。

## 通信数据流

### 命令与 request/reply

控制面板调用 `web/src/api.ts` 中的 typed 函数。fire-and-forget 命令使用 `pet:command`；`pet:list-motions`、`pet:list-voices` 等查询使用带明确超时的 acknowledgement callback。`server/src/index.js` 校验发送方角色，只转发给另一个参与者的 pet。`pet/src/renderer/main.ts` 把 discriminated `RemoteCommand` union 映射到现有 renderer action。

需要成功或错误结果的操作使用 acknowledgement。payload 中保留稳定字符串错误码，由 UI 转换为面向用户的文本。

### WebRTC

Socket.IO 负责传递 `call:start`、`call:end`、`webrtc:signal`、`webrtc:hangup` 和 `webrtc:error`。server 协调 call ID，只在正确的远端角色之间转发 SDP/ICE。屏幕、麦克风和系统声音 track 通过 `RTCPeerConnection` 传输，不能通过 Express 或 Socket.IO 传输。

`web/src/App.tsx` 和 `pet/src/renderer/main.ts` 都会在 `remoteDescription` 存在前暂存 ICE candidate，忽略过期 `callId`，并集中 teardown track、stream、peer connection 和待处理 candidate。任何通话变更都要保留这些行为。

### TTS

TTS 把控制通道与音频数据分开。controller 通过 Socket.IO 请求 job；server 校验文本、voice 授权、queue 深度、限流和目标在线状态，然后向远端 pet 发送一次性 `/api/tts/jobs/:jobId` URL。pet 使用 `HTMLAudioElement` 流式播放，并通过 Socket.IO 回报 `playing`、`completed` 或 `error`。

当前 server 只在内存保存 room、credential、queue、rate window 和 job。音频与文本不落盘。BYOK credential 在 server 端只存在于 controller socket，在本机由 Electron `safeStorage` 加密保存。普通功能变更不得顺带记录或持久化 secret、request body、TTS 文本或音频。

### Electron IPC

OS 级能力留在 `pet/src/main/index.js`。两个 preload 文件通过 `contextBridge` 暴露窄 API；两个 BrowserWindow 都保持 `contextIsolation: true` 和 `nodeIntegration: false`。renderer 在 TypeScript 中声明 bridge shape，并通过 bridge 调用能力，不能直接导入 Node 或 Electron。

`pet/src/renderer/main.ts` 还提供 `browserPetBridge` fallback。新增 bridge 时必须同步更新 main-process handler、对应 preload 暴露、renderer `Window` type；若独立浏览器运行仍有意义，还要更新 fallback。

## 场景：扩展 Socket.IO 契约

### 1. 适用范围与触发条件

新增事件或修改 `server/`、`web/`、`pet/` 共享字段时使用本节。当前仓库没有生成式 schema package，因此任务必须同步维护各处本地契约副本。

### 2. 签名

以下现有签名展示了项目模式：

```ts
// controller -> server，返回 acknowledgement 结果
socket.emit('pet:join', { secret, role: 'controller', participantId }, ack);

// controller -> 另一参与者的 pet
socket.emit('pet:command', command);

// 任一 WebRTC peer -> server -> 远端相反角色
socket.emit('webrtc:signal', { callId, description?, candidate? });
```

request/reply 事件的 server handler 接收 `(payload, ack)`；fire-and-forget 转发接收 `(payload)`。UI 需要结果时，`web/src/api.ts` 中的 client wrapper 把 acknowledgement 事件转换为 typed Promise。

### 3. 契约

- `pet:join` request：`secret: string`、`role: 'controller' | 'pet'`，以及可选且兼容旧客户端的 `participantId: string`；后者最多 128 个字符。
- `pet:join` acknowledgement：`{ ok: true, peers }` 或 `{ ok: false, code, error }`。
- `pet:command`：`expression | animation | say_audio | relocate` discriminated union；定义在 `web/src/api.ts`，并在 `pet/src/renderer/main.ts` 镜像为 `RemoteCommand`。
- `webrtc:signal`：可选 `callId`、`description`、`candidate`；只要提供 `callId`，就必须等于房间当前 call。
- 房间环境变量：`ROOM_SECRETS` 是逗号分隔 allowlist；`ROOM_SECRET` 是单房间兼容 fallback；`ROOM_GRACE_MS` 控制参与者释放延迟。

### 4. 校验与错误矩阵

| 条件 | 行为 |
| --- | --- |
| secret hash 未配置 | `pet:join` ack 返回 `bad_secret` |
| role 不是 `controller` 或 `pet` | `pet:join` ack 返回 `bad_role` |
| 第三个参与者加入 | ack 返回 `room_full`，已有参与者保持连接 |
| 同一参与者以相同 role 重连 | 新 socket 成功；旧 socket 收到带 `replaced` 的 `room:kicked` |
| controller 发命令时远端 pet 不在线 | 不转发，fire-and-forget handler 直接返回 |
| WebRTC signal 带过期 `callId` | 不转发 |
| request/reply 目标不存在或超时 | caller 收到该事件的中性结果，例如 `[]` |

### 5. 正常、基准与错误案例

- 正常：两个 endpoint 复用同一个稳定参与者 ID，命令只到达另一参与者的 pet。
- 基准：旧 controller 和 pet 不发送 `participantId`，仍通过兼容 role ID 配对。
- 错误：客户端自行传入目标 socket 或 room 名，server 未从 `socket.data` 推导归属就直接转发。

### 6. 必需测试

server 可见的契约发生变化时扩展 `server/test/rooms.test.js`。断言 acknowledgement payload、正确远端事件、不向自己或其他房间投递、适用时的替换行为，以及过期标识符被拒绝。运行两个 TypeScript 构建，确认 typed client 的每个副本仍能编译。

### 7. 错误与正确写法

```js
// 错误：信任客户端目标，会破坏房间隔离。
io.to(payload.targetSocketId).emit('pet:command', payload.command);

// 正确：从已认证的 socket 成员身份推导目标。
const room = roomForSocket(socket);
const petId = room && otherParticipant(room, socket.data.participantId)?.pet;
if (petId) io.to(petId).emit('pet:command', command);
```

## 跨层契约规则

当前没有共享 schema package。契约 shape 保持本地定义，部分会重复，例如 `Command`/`RemoteCommand`、`WebRtcSignal`、pairing snapshot 和 preload bridge 声明。修改其中一个之前，先搜索三个运行时目录，并在同一任务中更新全部生产者和消费者。

至少执行：

```bash
rg "<event-name>|<payload-field>" server/src web/src pet/src
```

普通功能任务不要顺带引入新的契约 library、event bus、数据库、REST 资源层或 Unity 集成；这些属于独立架构变更。

## 跨层验证

```bash
npm test --prefix server
npm run build:web
npm run build:pet
```

如果 bridge 或持久化路径在 Electron 内置 controller 与独立浏览器中行为不同，还要手动验证两种运行方式。
