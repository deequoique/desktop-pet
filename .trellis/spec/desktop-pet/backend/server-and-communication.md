# 服务端与通信模式

## 结构与代码风格

后端使用 ESM 入口 `server/src/index.js`，持久化 helper 位于 `server/src/persistent-store.js`。它围绕明确的 `Map`、版本化 JSON registry、原子文件写入、timer、Express、Socket.IO 和上游 stream 状态组织小型 helper；当前没有数据库、ORM、依赖注入框架或通用 REST 资源层。

扩展时遵循现有顺序：

1. 在文件顶部附近规范化环境变量配置。
2. 纯查询和 snapshot helper 放在其操作的状态附近。
3. provider stream 和 TTS queue helper 与 Socket.IO 事件注册分开。
4. HTTP endpoint 注册在 `io.on('connection', ...)` 之前。
5. socket 鉴权和路由决定留在事件边界内。

源码依据：`server/src/index.js` 中的 `loadAllowedVoices`、`peerSnapshot`、TTS queue helper、`/api/tts/jobs/:jobId` 和 socket handler。

## 状态归属

按现有代码选择状态作用域：

- `rooms`：从 room hash 映射到在线 device runtime 和当前设备对 call。
- `socket.data`：已加入的 endpoint role、固定 memberId、稳定 deviceId、房间，以及临时 BYOK 凭据和声音列表。
- `PersistentStore`：持久化 A/B 成员显示名、设备历史和成员私有音频 metadata/file；通过 `PET_DATA_DIR` 指定目录。
- `ttsJobs`：一次性 job 记录。
- `ttsQueues`：按目标 pet 建立的 FIFO queue，包括 active 项。
- `ttsRateWindows`：请求方的限流时间戳窗口。
- 短期 timer：参与者释放和 TTS job 过期。

在线 endpoint、call、TTS job 和 BYOK 凭据不会持久化；成员名称、设备历史和个人音频会跨 server 重启恢复。

## Scenario: v2 双成员、多设备和个人音频契约

### 1. Scope / Trigger

- 修改 join、presence、目标路由、设备历史、成员名称或个人音频时适用。v2 与旧客户端强制不兼容。

### 2. Signatures

- `pet:join({ protocolVersion: 2, secret, role, memberId, deviceId, deviceName }, ack)`。
- 定向事件携带 `targetDeviceId`：`pet:command`、`pet:list-motions`、`tts:create`、`call:start`、`webrtc:signal`、`audio:play`。
- 音频事件：`audio:list/add/get/rename/delete/play`；成员改名：`room:rename-member`；重装恢复：`device:reclaim`。

### 3. Contracts

- `memberId` 只能为 `a|b`；`deviceId` 是本机随机 UUID，旧 `participantId` 只在 Electron 本地迁移时读取一次。
- `room:peers` 包含 `self`、两个 members 及 devices 的 `petOnline/controllerOnline/lastSeenAt`。`peerOnline` 只表示另一成员至少一个 controller 在线。
- `PET_DATA_DIR` 必须是生产环境可写持久目录。每成员最多 100 条音频；单条不超过 10 MiB/60 秒，允许 MP3/WAV/OGG/M4A/WebM。
- 音频 list/get/rename/delete 只能访问发送 socket 所属 member；发送时仍需明确选择另一 member 的在线 pet device。

### 4. Validation & Error Matrix

- 非 v2 或缺 identity → `upgrade_required`；deviceId 跨 member 冲突 → `device_identity_conflict`。
- 未选择或目标 pet 离线 → `peer_pet_offline`；通话设备两端未齐 → `peer_not_ready`。
- 非法格式、空数据、超时长或超大小 → `invalid_audio`；达到 100 条 → `audio_limit_reached`；越权 ID 与不存在 ID统一返回 `audio_not_found`。
- 认领在线旧设备 → `device_online`；不存在或非本成员设备 → `device_not_found`。

### 5. Good/Base/Bad Cases

- Good：A 的 controller 选择 B-phone，命令只到 B-phone pet，B-PC 不收到。
- Base：B 只有 pet 在线时设备显示 pet 在线，但 A 的“对方在线”仍为 false。
- Bad：按 room 广播命令、用 IP 当设备身份、向 A 返回 B 的音频 metadata。

### 6. Tests Required

- store unit：重启恢复、成员音频隔离、30 天离线设备清理。
- Socket.IO integration：旧版拒绝、每成员多设备、显示名 last-write-wins、单目标不广播、音频 list 隔离和定向播放。
- client build/typecheck：pairing schema 从 participantId 迁移、targetDeviceId 跨 command/TTS/RTC/audio 完整传递。

### 7. Wrong vs Correct

#### Wrong

```js
io.to(roomChannel(room.hash)).emit('pet:command', command);
```

#### Correct

```js
const target = otherParticipant(room, socket.data.participantId, payload.targetDeviceId);
if (target?.pet) io.to(target.pet).emit('pet:command', command);
```

## Socket.IO handler 模式

适用时按以下顺序校验：

1. 发送方角色和已加入的房间。
2. payload 规范化和输入边界。
3. 当前 room/call/job 的归属。
4. 远端参与者和 endpoint 是否在线。
5. 容量、授权和限流。
6. 执行副作用、转发，然后 acknowledgement。

可预期失败使用 `{ ok: false, code: '<stable_code>' }`，现有例子包括 `pet:join`、`tts:set-credentials`、`tts:list-voices`、`tts:create` 和 `call:start`。只有不存在 acknowledgement 通道的 fire-and-forget 事件才静默返回，例如非法 `pet:command` 或过期 `webrtc:signal`。

转发目标必须从已认证 socket 对应的远端参与者和角色推导。不要把控制命令广播到整个 room，也不要信任客户端传入的目标 socket ID。

server 中转的查询必须有超时。`pet:list-voices` 和 `pet:list-motions` 向 pet 转发时使用三秒超时；目标不存在或超时时返回空数组。

## HTTP 与流式响应

HTTP surface 有意保持很小：

- `/api/health` 返回就绪元数据。
- `/api/tts/jobs/:jobId` 消费一个已授权、一次性且会过期的 job，并流式返回音频。

流式响应必须设置内容类型和 `Cache-Control: no-store, private`，传播上游取消，并确保对应 TTS job 只结束一次。若 header 已发送，失败时销毁 stream，不再尝试返回 JSON。

CosyVoice 使用 duplex WebSocket，ElevenLabs 使用 `fetch` stream，但两者最终都落到同一个 TTS job HTTP 契约。新增 provider 时必须复用现有 queue、status、expiry 和 playback 路径。

## 错误与日志

客户端可见的运行失败使用稳定的小写错误码，例如 `room_full`、`peer_not_ready`、`tts_queue_full` 和 `tts_upstream_rate_limited`。provider 细节只写 server warning，客户端只接收受控错误码。

日志使用简短 subsystem 前缀，如 `[socket]`、`[tts]`、`[webrtc]`，并使用 `console.log`、`console.warn` 或 `console.error`。禁止记录房间密钥、API key、包含凭据的 Socket.IO payload、完整 TTS 文本或音频。房间日志只使用 hash 的短前缀。

## 测试

`server/test/rooms.test.js` 是 Node 集成测试：在随机端口启动真实 server，连接真实 Socket.IO client，断言事件和 ack，并清理 socket 与子进程。room、路由、重连和信令变更继续沿用此模式，同时覆盖允许路径与隔离/拒绝不变量。

运行：

```bash
npm test --prefix server
```

当前 backend package 没有 lint script，不要声称已经获得仓库并不存在的 lint 覆盖。
