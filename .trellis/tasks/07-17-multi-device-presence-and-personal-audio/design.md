# 技术设计：双用户多设备与个人音频库

## 1. 身份与协议

新版 `pet:join` 使用不兼容的 v2 payload：

```text
{ protocolVersion: 2, secret, memberId: "a" | "b", deviceId, deviceName, role: "pet" | "controller" }
```

- `memberId` 是用户手动选择的固定成员槽位；`deviceId` 是安装实例的稳定随机 UUID。
- 每个 member 另有可变 displayName，默认“用户 A / 用户 B”。任意已加入 controller 可通过带 ack 的 `room:rename-member` 修改 a 或 b；server trim 并限制为 1–32 个 Unicode 字符，最后一次成功写入生效。
- 现有 Electron `participantId` 原值迁移为 `deviceId`；浏览器沿用 localStorage 中的原值。
- 缺少 v2 字段时返回 `upgrade_required`；非法成员、设备、名称或角色使用稳定错误码拒绝。
- 同一 member/device/role 的新 socket 替换旧 socket；不同设备互不替换。
- `socket.data` 保存服务端验证后的 room hash、memberId、deviceId 和 role，后续目标绝不使用客户端 socket ID。

首次配置在控制面板完成。Electron main 保存 `{ serverUrl, roomSecret, memberId, deviceId, deviceName }` 并广播给 pet/controller。默认设备名来自 `os.hostname()`，浏览器使用可编辑通用名称。缺少 memberId 时两个端点均不加入房间。

本地数据丢失后的恢复通过未入房 socket 的 `device:list-claimable` 查询完成：请求只带 secret 与 memberId，响应只含该成员的离线设备。用户选择后把旧 ID 写回本地；在线设备不出现在可认领集合。该流程是可信部署下的产品防误操作，不是强鉴权。

## 2. 运行时房间与持久登记

运行时状态改为：

```text
room
  members.a.devices[deviceId].{ petSocketId, controllerSocketId }
  members.b.devices[deviceId].{ petSocketId, controllerSocketId }
  call: null | { callId, aDeviceId, bDeviceId }
```

持久状态位于 `PET_DATA_DIR`（默认 server 工作目录下 `data/`）：

```text
registry.json
  rooms[roomHash].members[a|b]
    { displayName, devices[deviceId]: { name, firstSeenAt, lastSeenAt } }
audio/<roomHash>/<memberId>/<audioId>.<ext>
```

- 不落盘明文密钥、socket ID 或在线布尔值。
- metadata 先写同目录临时文件再 rename，避免半写文件；音频同样先写临时文件再原子替换。
- 启动、设备状态变更和周期清理时移除连续 30 天离线的设备记录；在线状态始终由运行时 socket 推导。
- server 重启后所有端点先显示离线，设备重连后恢复实时状态。

`room:state` 取代参与者视角不足的 `room:peers`，向已入房端点发送两名成员的设备快照。每台设备包含 ID、名称、pet/controller 在线状态、lastSeenAt，以及接收方可用于标记本机的 member/device 身份。顶部对方在线由对方任一 controller 在线推导；pet 在线只进入设备行和操作可用性。

快照同时包含 a/b 的 displayName。重命名成功后先原子保存 registry，再广播新快照；displayName 仅用于展示，所有权限和路由继续使用 memberId，避免改名破坏引用。

## 3. 单目标路由

控制面板保存 `targetDeviceId`（按 room/member 记忆）。快照变化时：

- 对方仅一台 pet 在线时自动选择。
- 多台时优先保留上次选择；不因当前目标离线而静默切到另一台。
- 所有命令、动作查询、TTS、个人音频和通话请求显式携带 targetDeviceId。

server 从发送 socket 的 memberId 推导另一成员，再在其设备表中查找 targetDeviceId。不存在、归属错误或目标端点离线时返回稳定错误，不广播。

房间仍最多同时存在一通通话，但 call 绑定一对设备。`call:start` 记录发起设备和目标设备，仅通知这两台设备的 controller；信令严格在配对设备的 controller↔对方 pet 间转发。任一相关端点断开结束通话，其他设备断开不影响通话。WebRTC 媒体仍保持点对点或 TURN 音频兜底，不经过应用 server。

## 4. 成员私有音频库

控制面板“我的音频”支持 MediaRecorder 录音和文件导入。客户端读取媒体 metadata，在上传前校验：60 秒、10 MB、支持格式。server 根据 `socket.data.memberId` 决定库归属，独立校验 MIME/扩展名、10 MB 和 100 条配额；不信任 payload 中的成员字段。

Socket.IO 上传事件携带二进制数据，server 的 `maxHttpBufferSize` 设置为略高于 10 MB 的固定值。元数据只包含随机 audioId、用户可编辑名称、MIME、大小、durationMs 和 createdAt。

列表、重命名和删除只操作请求 socket 所属成员。试听或发送播放时，server 创建短期不可猜测的一次性 audio job：

- 自己试听：返回当前 controller 可消费的私有 HTTP URL。
- 发送播放：验证所选对方 pet 在线，向它发送一次性 URL，不发送库列表或文件名。
- HTTP 响应使用 `Cache-Control: no-store, private`；job 过期或消费后删除。

接收方必然能听到并可在技术上捕获播放内容，因此“不可看到别人音频”定义为不能通过正常 UI/API 列出对方库或元数据，而不是 DRM。

桌宠 renderer 复用现有 HTMLAudioElement/Web Audio 播放与清理路径。仓库自带的情境音效扫描可以保留为桌宠本地资源，但不再作为控制面板远程列表来源。

## 5. 兼容、发布与回滚

- 新服务端与新客户端协调发布；不维护旧 participant 兼容分支。
- `upgrade_required` 让旧客户端明确失败，不误入新模型。
- 持久 schema 带 version；未知新版本拒绝覆盖，避免降级 server 损坏数据。
- 回滚应用代码前保留 `PET_DATA_DIR` 备份。旧 server 不读取新 registry/audio，但不会自动删除它们。

## 6. 验证重点

- 两成员各多设备、同端点替换、换网络重连、claimable 只含离线同成员设备。
- 任一 controller 可修改 a/b 显示名称，输入边界、last-write-wins、持久化和广播一致。
- 快照不会把仅 pet 在线算作用户在线。
- 命令、查询、TTS、个人音频、WebRTC 信令均只命中选择设备，不串成员、设备或房间。
- registry 原子写入、重启恢复、30 天清理与音频配额/隔离。
- Electron 内置控制面板与独立浏览器的配置、设备名和 target selection 降级行为。
