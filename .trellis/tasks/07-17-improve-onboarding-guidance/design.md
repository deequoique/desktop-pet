# 技术设计：首次配置引导与身份切换

## 1. 范围与边界

本任务跨越四个现有边界：

- Electron main：判断 pairing 是否完整、可靠显示控制面板、持久化 pairing。
- React 控制面板：首次两步引导、设置页导航、身份切换确认与反馈。
- `web/src/api.ts`：临时配置发现连接、已认证设备身份迁移请求。
- server：验证房间密钥、返回成员显示名称、原子迁移设备成员归属。

不引入路由库、全局状态库或共享 schema package。独立浏览器入口仍只作为开发 fallback，不是产品验收目标。成员身份继续使用 `a | b`，稳定设备 ID、成员私有音频和现有路由规则保持不变。

## 2. 完整 pairing 与首次窗口显示

新增可独立测试的纯函数，统一判断有效 pairing 快照至少包含：

```text
serverUrl + roomSecret + memberId(a|b) + deviceId + deviceName
```

Electron main 与 React 不再分别用不同的字段集合推断“已配置”。`ensureDeviceId()` 和默认主机名仍可补全安装级设备信息，但缺少服务器、密钥或成员身份都属于首次配置未完成。

启动时若 pairing 不完整：

1. 创建桌宠窗口与控制面板窗口。
2. 记录“首次配置需要显示”的 pending 状态。
3. 等控制面板 `ready-to-show` / 页面加载完成后再 `show()` 与 `focus()`，避免在隐藏窗口尚未就绪时丢失显示意图。
4. React 以 `settings` 作为固定初始视图；pairing 不完整时进入服务器验证步骤。

已有完整配置时，控制面板不被强制显示，controller 与 pet 自动连接；用户手动打开后同样从“设置”开始。运行中 `disconnected` / `rejected` 只更新状态和错误提示，不修改 `activeView`。

## 3. 首次两步配置

### 3.1 第一步：验证服务器与密钥

设置页首次引导只显示服务器地址和房间密钥，以及“验证并继续”。`web/src/api.ts` 创建一个与全局 controller socket 分离的临时 Socket.IO 连接：

```text
pairing:discover({ protocolVersion: 2, secret })
  -> { ok: true, members: [{ id: "a", displayName }, { id: "b", displayName }] }
  -> { ok: false, code: "bad_secret" | "upgrade_required" }
```

- server 只对 hash 后命中已配置房间密钥的请求返回数据。
- 返回值只包含两个成员 ID 与显示名称，不暴露设备、在线状态、音频或其他房间数据。
- 临时 socket 在成功、拒绝、连接错误或超时后都移除 listener 并断开。
- React 把不可达、超时、错误密钥和服务端版本不支持映射成可操作中文文案。
- 用户修改已验证的服务器或密钥字段时，立即丢弃验证结果并回到第一步。

该事件只验证连接上下文，不创建 room runtime participant，不登记设备，也不修改 pairing 文件。

### 3.2 第二步：选择身份并连接

验证成功后显示服务端返回的真实成员名称、设备名称和“保存并连接”。身份状态允许空值，进入第二步时不默认选择 `a`；用户必须明确选择。

保存继续经过 Electron preload 的 pairing IPC。Electron main 先构造完整新对象并成功写盘，再替换内存配置与广播 `pet:pairing-changed`；禁止像当前实现一样先修改内存对象再尝试写盘。广播后 controller 与 pet 使用相同 `memberId + deviceId` 自动连接。

## 4. 已连接身份切换

设置页已连接状态显示当前身份和独立“更改身份”入口。用户选择另一成员后，确认层明确说明桌宠与控制端会短暂重连。确认后执行：

```text
React controller
  -> device:change-member({ targetMemberId })
server
  -> 原子移动 persistent device 记录
  -> 更新当前 participant.memberId
  -> 更新该 participant 的 pet/controller socket.data.memberId
  -> 如有通话则结束
  -> 广播新的 room:peers
  -> ack success
React
  -> Electron savePairingConfig(new memberId)
Electron main
  -> 写盘成功后广播 pairing changed
pet + controller
  -> 清理旧连接并用新成员身份重连
```

服务端约束：

- 只接受已加入房间且 role 为 `controller` 的发送方。
- 只能迁移发送方当前 `deviceId`，客户端不能指定其他设备。
- 目标必须是另一合法成员；目标成员下存在同 ID 记录时拒绝，避免覆盖。
- persistent store 的移动保留设备名称与 `firstSeenAt`，更新 `lastSeenAt`，从旧成员删除设备；不移动旧成员音频、显示名称或其他设备。
- store 写入失败时恢复内存中的旧成员/新成员设备映射并返回稳定错误，不改变 runtime 身份。
- 当前设备涉及的活动通话在成员变化前结束；TTS/BYOK 等连接级资源随后沿用现有断线清理路径。

## 5. 失败与补偿

- `device:change-member` 被拒绝或超时：不调用 Electron 保存，保持旧身份与旧连接。
- server 迁移成功但 Electron pairing 写盘失败：controller 在旧 socket 尚可用时调用同一事件迁回旧成员；UI 报告“保存失败，身份未更改”。反向迁移也失败时报告需要重试/重启的恢复错误，不伪报成功。
- Electron 写盘成功后广播触发重连；短暂 `disconnected` 不导航离开当前设置页。
- 重复选择当前成员按幂等成功处理或在 UI 中禁用，不执行迁移。

为让补偿路径可靠，server 在迁移成功后更新现有 participant 和两个 socket 的认证成员，但不主动踢掉连接；真正断开由 pairing 广播后的现有客户端重连路径完成。

## 6. 持久化与兼容

`PersistentStore` 增加 `moveDevice(roomHash, sourceMemberId, targetMemberId, deviceId)`：

- 成功后同一设备只存在于目标成员。
- 保留 `name` 与 `firstSeenAt`，刷新 `lastSeenAt`。
- member audio map 完全不参与移动。
- 保存采用现有临时文件 + rename；写入异常时恢复内存变更后再抛出/返回失败。

新增 Socket.IO 事件要求先部署 server，再发布 Electron 客户端。已有完整 pairing 的旧客户端继续使用现有 `pet:join`，不受新事件影响；新客户端对旧 server 的首次验证会显示“服务器版本不支持新的配置引导”，而不是把超时误报为密钥错误。

回滚客户端不会破坏新 server；回滚 server 前应确保没有仍依赖两步配置/身份迁移的新客户端，或接受这些新入口暂时不可用。registry schema 不升级，只改变已有成员设备映射的位置。

## 7. UI 状态与呈现

React 使用局部状态表达配置阶段，不引入新路由：

```text
setupStage: "server" | "identity" | "complete"
verifiedPairing: null | { serverUrl, secret, members }
identityChange: closed | choosing | submitting | error
```

- 首次设置卡片提供清晰步骤标题和主按钮，不同时展示所有技术设置。
- 未完成首次 pairing 时，成员名称、设备历史、语音服务等依赖连接的设置区不伪装成可用内容。
- 普通已连接设置仍显示连接状态；当前身份以只读摘要呈现，“更改身份”进入确认流程。
- 连接失败、迁移失败和写盘失败分别显示具体反馈，不共用含糊的“加入失败”。

## 8. 验证策略

- Electron/pure helper：完整与缺字段 pairing 判定、首次启动应显示控制面板的决策。
- Persistent store：设备跨成员移动、字段保留、旧成员删除、成员音频不移动、目标冲突和保存失败回滚。
- Server 集成：正确/错误密钥发现；发现不登记设备；只有本机 controller 能迁移；迁移后两个 endpoint 认证成员一致；非法目标/覆盖拒绝；原成员音频仍隔离。
- 构建与回归：`npm test --prefix server`、`npm test --prefix pet`、`npm run build:web`、`npm run build:pet`。
- Electron 手工烟雾：清空测试用 pairing 数据后启动，控制面板自动出现并进入设置；两步连接；身份切换自动重连；临时断线不切页；完整配置重启不强制打开控制面板。
