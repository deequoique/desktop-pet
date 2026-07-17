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

## 成员、设备与房间模型

每个安装使用稳定 `deviceId`，并由用户选择固定 `memberId: 'a' | 'b'`。同一设备的 pet renderer 和 Electron 内置 controller 分别建立 `pet` / `controller` endpoint，server 按 member→device→endpoint 组织在线状态。Electron main 将身份写入 `userData/pairing.json`，首次升级把旧 `participantId` 原值迁移为 `deviceId`。

server 对房间密钥做 hash，只保留 hash。一个房间固定两名成员，每名成员可以登记多台设备；同设备同 role 重连只替换自己的旧 socket。控制、TTS、个人音频和通话必须携带选定的 `targetDeviceId`，server 再从已认证 member 推导另一成员目标，不能广播或回发给自己。

修改 pairing 或 presence 时：

- pet 和内置 controller 必须使用相同 `memberId + deviceId`。
- `room:peers` 返回 self、A/B member displayName、持久设备列表以及各设备 pet/controller 在线状态。
- `peerOnline` 只表示另一成员至少一个 controller 在线；pet-only 不代表用户在线。
- 目标设备选择保留并持久化；已有目标离线时保持选择并禁用发送，不静默切换。只有尚无选择且恰好一个目标 pet 在线时才自动选择。
- v2 不兼容旧协议；缺少 v2 identity 的客户端必须收到 `upgrade_required`。

## 通信数据流

### 命令与 request/reply

控制面板调用 `web/src/api.ts` 中的 typed 函数。fire-and-forget 命令使用 `pet:command`；`pet:list-motions` 等查询使用带明确超时的 acknowledgement callback。`server/src/index.js` 校验发送方角色和目标设备，只转发给另一成员选定设备的 pet。`pet/src/renderer/main.ts` 把 discriminated `RemoteCommand` union 映射到现有 renderer action。

需要成功或错误结果的操作使用 acknowledgement。payload 中保留稳定字符串错误码，由 UI 转换为面向用户的文本。

### WebRTC

Socket.IO 负责传递 `call:start`、`call:end`、`webrtc:signal`、`webrtc:hangup` 和 `webrtc:error`。server 协调 call ID，只在正确的远端角色之间转发 SDP/ICE。屏幕、麦克风和系统声音 track 通过 `RTCPeerConnection` 传输，不能通过 Express 或 Socket.IO 传输。

`web/src/App.tsx` 和 `pet/src/renderer/main.ts` 都会在 `remoteDescription` 存在前暂存 ICE candidate，忽略过期 `callId`，并集中 teardown track、stream、peer connection 和待处理 candidate。任何通话变更都要保留这些行为。

### TTS

TTS 把控制通道与音频数据分开。controller 通过 Socket.IO 请求 job；server 校验文本、voice 授权、queue 深度、限流和目标在线状态，然后向远端 pet 发送一次性 `/api/tts/jobs/:jobId` URL。pet 使用 `HTMLAudioElement` 流式播放，并通过 Socket.IO 回报 `playing`、`completed` 或 `error`。

当前 server 只在内存保存 room、credential、queue、rate window 和 job。音频与文本不落盘。BYOK credential 在 server 端只存在于 controller socket，在本机由 Electron `safeStorage` 加密保存。普通功能变更不得顺带记录或持久化 secret、request body、TTS 文本或音频。

### Electron IPC

OS 级能力留在 `pet/src/main/index.js`。两个 preload 文件通过 `contextBridge` 暴露窄 API；两个 BrowserWindow 都保持 `contextIsolation: true` 和 `nodeIntegration: false`。renderer 在 TypeScript 中声明 bridge shape，并通过 bridge 调用能力，不能直接导入 Node 或 Electron。

`pet/src/renderer/main.ts` 还保留 `browserPetBridge` 开发 fallback，但独立浏览器已不是产品或验收入口。新增 bridge 必须同步更新 main-process handler、对应 preload 暴露和 renderer `Window` type；只需保证 fallback 安全降级，不为其新增产品能力。

## 场景：首次配对与设备身份变更

### 1. 适用范围与触发条件

首次配置、修改 `pairing.json`、成员身份切换，或新增配对 Socket.IO/IPC 事件时适用。控制面板每次启动都以“设置”为首页；未完成配对时在设置内执行两步流程，而不是预设 A/B 身份或把瞬时断线当作重新配置。

### 2. 签名

```ts
// 未加入房间的临时 probe；不得创建房间或设备记录。
socket.emit('pairing:discover', { protocolVersion: 2, secret }, ack);

// 已加入的 controller 改变其稳定 deviceId 所属成员。
socket.emit('device:change-member', { targetMemberId: 'a' | 'b' }, ack);

// Electron control preload（已有 bridge）保存完整 snapshot，并广播更新。
window.desktopPetControl.savePairingConfig(config);
window.desktopPetControl.onPairingChanged(callback);
```

### 3. 契约

- `pairing:discover` 成功返回 `{ ok:true, members:[{ id:'a'|'b', displayName:string }, ...] }`；只在 `protocolVersion === 2` 且 secret 在 allowlist 中时成功，不 join、不持久化。
- 设置流程先验证服务器地址和密钥，再使用 discovery 返回的真实成员名称显式选择 `memberId`；完整 pairing 必须包含 `serverUrl`、`roomSecret`、`memberId`、稳定 `deviceId` 与 `deviceName`。
- `device:change-member` 只能由已加入的 controller 调用。server 以同一 `deviceId` 原子地从原成员移至目标成员，保留设备名称与 `firstSeenAt`，更新在线 runtime/socket `memberId` 并发送 `room:peers`。当前通话若包含该设备，结束原通话。
- 设备迁移不迁移个人音频：音频 metadata/file 仍属于原成员。Electron 本地配置只在 server 迁移成功后保存；保存失败要尝试恢复 server 身份，避免本地和服务端长期分叉。

### 4. 校验与错误矩阵

| 条件 | 行为 |
| --- | --- |
| discovery 协议不是 v2 | `{ ok:false, code:'upgrade_required' }` |
| discovery 密钥无效 | `{ ok:false, code:'bad_secret' }` |
| 临时 probe 无法连接或超时 | client 返回 `unreachable` 或 `timeout`，不改变现有连接/UI 身份 |
| 身份变更来自 pet、未 join 或没有 participant | `{ ok:false, code:'not_joined' }` |
| `targetMemberId` 不是 `a` / `b` | `{ ok:false, code:'invalid_member' }` |
| 目标成员已拥有同一 `deviceId` | `{ ok:false, code:'device_identity_conflict' }` |
| 持久化写入失败 | `{ ok:false, code:'device_move_failed' }`，内存 registry 回滚 |

### 5. 正常、基准与错误案例

- 正常：新安装先验证密钥，看到“小明/小红”后选择小明；保存成功才以 A 身份连接。
- 基准：已完整配对的安装重启后仍打开设置首页并显示当前身份；运行中网络断线只显示连接状态，不能清空配对或强制回到首配步骤。
- 错误：A 的 controller 迁到 B 后仍能 `audio:list` 读取 A 的个人音频，或 UI 先写本地 B 再发现 server 拒绝迁移。

### 6. 必需测试

- store unit：迁移移除原成员设备、保留设备历史，并断言原成员音频仍在原处。
- Socket.IO integration：正确密钥 discovery 返回成员名称；错误密钥被拒绝；controller 可迁移，pet 调用与非法成员均被拒绝。
- Electron unit：缺少任一 pairing 字段时启动控制面板；完整 pairing 不被误判为未配置。
- build/manual：运行两个前端构建；全新 Electron profile 打开设置首页且显示“第 1 步，共 2 步”。

### 7. 错误与正确写法

```ts
// 错误：先假定 A，再让用户补填密钥；或在 server 拒绝前写入本地 B。
setMemberId('a');
await savePairingConfig({ ...config, memberId: 'b' });

// 正确：先 discovery，再由用户选择；身份迁移成功后才持久化本地 snapshot。
const discovered = await discoverPairing(serverUrl, secret);
if (discovered.ok) setVerifiedMembers(discovered.members);
const moved = await changeMember(targetMemberId);
if (moved.ok) await savePairingConfig({ ...config, memberId: targetMemberId });
```

## 场景：扩展 Socket.IO 契约

### 1. 适用范围与触发条件

新增事件或修改 `server/`、`web/`、`pet/` 共享字段时使用本节。当前仓库没有生成式 schema package，因此任务必须同步维护各处本地契约副本。

### 2. 签名

以下现有签名展示了项目模式：

```ts
// controller -> server，返回 acknowledgement 结果
socket.emit('pet:join', { protocolVersion: 2, secret, role: 'controller', memberId, deviceId, deviceName }, ack);

// controller -> 另一参与者的 pet
socket.emit('pet:command', { ...command, targetDeviceId });

// 任一 WebRTC peer -> server -> 远端相反角色
socket.emit('webrtc:signal', { callId, targetDeviceId, description?, candidate? });
```

request/reply 事件的 server handler 接收 `(payload, ack)`；fire-and-forget 转发接收 `(payload)`。UI 需要结果时，`web/src/api.ts` 中的 client wrapper 把 acknowledgement 事件转换为 typed Promise。

### 3. 契约

- `pet:join` request：`protocolVersion: 2`、`secret: string`、`role: 'controller' | 'pet'`、`memberId: 'a' | 'b'`、稳定 `deviceId` 和可编辑 `deviceName`。
- `pet:join` acknowledgement：`{ ok: true, peers }` 或 `{ ok: false, code, error }`。
- `pet:command`：`expression | animation | say_audio | relocate` discriminated union，controller payload 还必须携带 `targetDeviceId`；server 转发前移除目标字段。
- `webrtc:signal`：可选 `callId`、`targetDeviceId`、`description`、`candidate`；call 存在时只能在绑定的两台设备间转发。
- 房间环境变量：`ROOM_SECRETS` 是逗号分隔 allowlist；`ROOM_SECRET` 是单房间兼容 fallback；`ROOM_GRACE_MS` 控制参与者释放延迟。

### 4. 校验与错误矩阵

| 条件 | 行为 |
| --- | --- |
| secret hash 未配置 | `pet:join` ack 返回 `bad_secret` |
| role 不是 `controller` 或 `pet` | `pet:join` ack 返回 `bad_role` |
| 非 v2、缺 member/device identity | `pet:join` ack 返回 `upgrade_required` |
| memberId 不是 `a` / `b` | `pet:join` ack 返回 `upgrade_required` |
| 同一设备以相同 role 重连 | 新 socket 成功；旧 socket 收到带 `replaced` 的 `room:kicked` |
| controller 发命令时远端 pet 不在线 | 不转发，fire-and-forget handler 直接返回 |
| WebRTC signal 带过期 `callId` | 不转发 |
| request/reply 目标不存在或超时 | caller 收到该事件的中性结果，例如 `[]` |

### 5. 正常、基准与错误案例

- 正常：同设备两个 endpoint 复用 `memberId + deviceId`，命令只到达所选另一成员设备的 pet。
- 基准：当前没有目标且恰好一个对方 pet 在线时自动选择；已有离线目标不会切换。
- 错误：客户端自行传入目标 socket 或 room 名，server 未从 `socket.data` 推导归属就直接转发。

### 6. 必需测试

server 可见的契约发生变化时扩展 `server/test/rooms.test.js`。断言 acknowledgement payload、正确远端事件、不向自己或其他房间投递、适用时的替换行为，以及过期标识符被拒绝。运行两个 TypeScript 构建，确认 typed client 的每个副本仍能编译。

### 7. 错误与正确写法

```js
// 错误：信任客户端目标，会破坏房间隔离。
io.to(payload.targetSocketId).emit('pet:command', payload.command);

// 正确：从已认证的 socket 成员身份推导目标。
const room = roomForSocket(socket);
const petId = room && otherParticipant(room, socket.data.participantId, payload.targetDeviceId)?.pet;
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

涉及 bridge 或持久化时，手工验证 Electron 内置 controller 与 pet renderer；独立浏览器不纳入发布验收。
