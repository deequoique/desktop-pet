# TRTC 双向独立音频与 Windows 回环排除设计

## 1. Architecture

每次通话最多使用三个 call-scoped TRTC identity：双方各一个 main identity，屏幕共享方再使用一个 system identity。

| Identity | 创建方 | 发布 | 播放远端 | 实现 |
| --- | --- | --- | --- | --- |
| initiator main | 发起方 | 本机麦克风（默认关） | target main 麦克风；target system 声音，分别默认关 | TRTC 主实例 |
| target main | 当前屏幕共享方 | 屏幕辅流、本机麦克风（默认关） | initiator main 麦克风，默认关 | TRTC 主实例 |
| target system | 当前屏幕共享方 | 单向系统声音 | 永不订阅/播放 | `createSubCloud()` child |

屏幕视频角色不变。系统 identity 的唯一作用是把系统声音从 main 用户的麦克风流中拆出，使接收端能真正独立静音两个远端 userId。

## 2. Server and Signing Contract

`server/src/index.js` 增加稳定、不可逆的 `trtcSystemUserId(callId, targetDeviceId)` 派生，建议使用 `s_<24 hex>`，继续满足 TRTC 32 字符限制。

`trtc:get-config` 返回：

- 双方共有：现有 main `userId/userSig`、`remoteUserId`、`roomId`、`publishScreen`、`videoProfile`。
- target 额外获得 `localSystemAudio: { userId, userSig }`，只有当前 call target 能拿到该发布凭据。
- initiator 额外获得 `remoteSystemUserId`，只用于接收/静音，不包含对应 UserSig。
- target 的 `remoteSystemUserId` 为 null/省略；initiator 的 `localSystemAudio` 为 null/省略。

所有身份继续使用同一短 TTL、call membership/role 校验；SecretKey 永不进入客户端。系统身份只在系统声音 capture 实际启动期间进房，避免空闲身份计费。

## 3. Main Audio Path

- 进房前 `setDefaultStreamRecvMode(true, true)` 并立即对允许的 remote identities 设置本地静音，确保所有远端播放默认关闭。
- main identity 不随屏幕共享自动启动音频。用户打开本机麦克风时调用 `startLocalAudio(TRTCAudioQualityDefault)`，关闭时 `stopLocalAudio()`；不再用 Music quality + capture volume 伪静音。
- 两端 main instance 负责远端 main 麦克风 playout，使 TRTC 能在同一默认音频模块中做采集/播放时序控制和声学 AEC。
- 接收 UI 对 remote main 和 remote system 分别调用 `muteRemoteAudio()`；页面状态按 call ID 初始化，不能持久化到下一通话。

## 4. System Audio Path

### macOS

target 创建 child cloud，以 system identity 进入同一房间，进房前 `muteAllRemoteAudio(true)`；调用 SDK 原生 `startSystemAudioLoopback()` 发布系统声音。child 不启动麦克风、不渲染远端音频，挂断时先停止 loopback，再退出和销毁 child。

### Windows 11

Windows child cloud 同样只发布、不播放，但启用 `enableCustomAudioCapture(true)`。它接收 Win32 helper 产生的 48 kHz、双声道、16-bit little-endian PCM，以 20 ms/3840-byte 帧构造 `TRTCAudioFrame`，使用 `generateCustomPTS()` 生成/校准时间戳并调用 `sendCustomAudioData()`。

helper 使用：

- `ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, IID_IAudioClient, ...)`；
- `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`；
- `TargetProcessId = Electron browser/main process PID`；
- `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`；
- shared/event-driven/auto-convert PCM capture。

因此 Electron renderer、TRTC addon 和其正常子进程产生的 render stream 不进入 system uplink；独立启动的游戏/播放器仍进入。

### Windows 10

不启动 Win32 helper，也不调用 process-loopback exclusion API。system child 继续使用 TRTC 原生空-path `startSystemAudioLoopback()` 发布整机声音，保持现有无需选择游戏的兼容行为。UI/诊断标记 `echoExclusion: unsupported`；数字回环可能存在且按产品决定不作为 Windows 10 的失败条件。主 identity 仍使用 SDK 默认麦克风链路，因此可用的声学 AEC 不因该降级而关闭。

## 5. Native Helper Boundary

新增 `pet/native/windows-process-loopback/` 的最小 x64 Win32 console helper。它只做音频 capture 和 framed PCM 输出，不接触网络、UserSig 或 TRTC。

- 启动参数固定由 preload 组装：排除根 PID、48 kHz、2 channels、20 ms；不接受任意输出路径或 shell 参数。
- stdout 只输出版本化二进制 frame（magic/version/type/sequence/PTS/payload length + PCM）；stderr 只输出长度受限的结构化状态/错误，不含原始音频或设备名。
- helper 将任意 WASAPI packet 累积并切成 20 ms 帧；使用有界 ring buffer。消费者落后时丢弃最旧帧并报告计数，不能无限占用内存。
- preload 从 Electron main 的窄 IPC 获取可信 root PID，以固定 `resourcesPath` 查找 helper，使用 `spawn(exe, args, { windowsHide: true, stdio: [...] })`，绝不通过 shell。
- helper 监视 Electron main process handle/输入管道；父进程退出、stdin 关闭、capture stop 或协议错误时自停。preload 也必须在 call generation 变化、挂断和 renderer unload 时终止 helper。
- Electron control window通话期间需避免 renderer timer 被后台节流；实现应验证稳定 20 ms 投送。若 JS timer 不满足抖动门槛，helper framing需改为消费事件驱动并在 preload 保持小型有界 jitter buffer。

## 6. Packaging and Platform Compatibility

- helper 仅构建/打包为 Windows x64，与现有 NSIS x64 target 一致；macOS 包不包含或加载它。
- `electron-builder` 通过 `extraResources` 放入固定位置。Windows release workflow 在 `dist:win` 前使用 Visual Studio/CMake 构建 Release helper，并在打包前执行 presence/architecture smoke check。
- 源码保留在仓库；不把本机生成的 exe 当作跨平台源文件提交。
- 启动 system capture 前检测 Windows 产品版本：Windows 11 才启用 native process-loopback；Windows 10 明确使用 TRTC 空-path system loopback。Windows 11 的 helper 失败不得静默回退，避免本应满足的回声消除验收被掩盖。
- macOS 继续发布核心双向麦克风、单向系统声音和独立控制；只有 Windows native helper/AEC 矩阵不在 macOS 验收范围。

## 7. Lifecycle and Failure Isolation

每个通话维护 `{ callId, generation, mainCloud, systemCloud, helper, sourceStates }`。任何异步回调先比较 call ID + generation；旧回调只能清理自己的资源，不能修改新通话。

启动顺序：main 进房并默认静音远端 → target system child 禁止远端播放并进房 → system capture 就绪 → 开启 custom/native system publish → 独立暴露 source available 状态。

停止顺序：停止接收 helper frame → custom capture off/loopback stop → system child exit/destroy → main remote view/audio stop → local mic/screen stop → main exit → 移除 listeners/timers。所有 stop 必须幂等。

Windows 11 上 system helper/child 失败只把系统声音标成 unavailable，屏幕、main 麦克风和通话继续；Windows 10 则明确启动原生 system loopback。main cloud 失败按现有 TRTC failure 路径处理。任何失败都不得自动打开其他音源。

## 8. UI and Diagnostics

- 两端“本机麦克风”默认关闭。
- initiator 显示“对方麦克风”“对方系统声音”，两项默认关闭且真实映射两个 userId。
- target 只显示“对方麦克风”，不渲染不存在的 remote system 控件。
- Windows 10 提示“系统声音可共享，但当前系统不支持回声排除”；Windows 11 helper 失败显示系统声音不可用。两种情况都不要求用户选择游戏/exe。
- 诊断仅记录 call-scoped source、platform/build、helper protocol version、start/stop/error/drop counters 和 TRTC error code；不记录 PID、完整路径、设备名或 PCM。

## 9. Security, Cost, and Rollback

- system identity 增加一个并发房间用户和一路纯音频上行/订阅时长；实际费用按腾讯云当前音频时长/套餐结算，实施前用测试房计量一次，避免把“第二 userId 免费”写成假设。
- helper 没有网络访问，路径固定，参数验证严格，原始 PCM 仅在内存/pipe 中短暂存在，不落盘。
- `TRTC_MEDIA_MODE` 继续是整套 TRTC→WebRTC 回滚开关。系统音频 native 路径还应有独立 kill switch，使 helper 问题能只关闭系统声音而不关闭屏幕和双向麦克风。

## 10. POC Gates

在大规模改 UI 前先完成 Windows 11 POC：

1. 外部播放器 + TRTC 远端语音同时播放，helper PCM 只包含外部播放器。
2. Process Explorer/诊断确认 TRTC render stream 所属进程位于被排除树；若不在，记录真实 PID 归属并停止实现，不得假通过。
3. 连续 30 分钟 capture/send 无 frame 堆积、明显卡顿或残留 helper。
4. 双机外放确认数字回环被切断；再验证 main SDK AEC 处理扬声器→麦克风的声学路径。

POC 任一项失败时，保留 main 双向麦克风和分源设计；Windows 11 的 system uplink fail closed 并另开 native 音频方案决策，不能把 Windows 11 伪装成 Windows 10 降级。Windows 10 仍按已确认的产品策略使用旧 loopback。

## 11. Explicit Device Handoff

设备接管复用用户在新设备上明确触发的 `call:start { targetDeviceId }`，设备上线、Socket 重连和 peer snapshot 更新不触发接管。server 对请求按以下顺序分类：

1. 房间无通话：按现有路径创建通话。
2. 请求方和目标已经是当前两个端点：幂等返回当前 call ID。
3. 目标是当前通话一端，当前另一端与请求方属于同一 member，但设备 ID 不同：执行 handoff。
4. 其他已有通话：返回 `call_busy`，不得改变现有通话。

handoff 提交前必须验证新设备和当前对端都同时具有 pet/controller socket，并确认新设备替换的旧端点与它属于同一 member。服务端保留原 initiator/target 角色：旧 initiator 被替换时新设备成为 initiator；旧 target 被替换时新设备成为 target，因此屏幕和系统声音发布角色随成员端点正确迁移。

handoff 总是创建新 call ID。事件顺序为：

1. 对旧两个端点发送 `call:end { oldCallId, reason:'transferred', transferredMemberId }`，旧设备立即释放全部媒体；未被替换的对端显示切换状态。
2. 原子更新 `room.callId/room.call` 为新 call generation。
3. 只向新设备与当前对端发送新 `call:start`，二者按现有流程重新获取 call-scoped TRTC config/UserSig 并进房。
4. `call:start` acknowledgement 返回 `{ ok:true, callId:newCallId, transferred:true }`。

Socket.IO 对同一连接保持事件顺序；对端会先同步 teardown 旧 call，再执行新 `beginMediaCall()`。所有 `call:end`、hangup、WebRTC/TRTC control/status/signal 必须同时校验当前 call ID 与端点 membership，保证旧设备或旧异步回调不能终止/污染新 call。前端显示：旧设备“通话已切换到你的另一台设备”，未替换对端“对方正在切换通话设备”，真实冲突显示“已有其他通话正在进行”；`call_busy`、`timeout`、`disconnected` 和 `peer_not_ready` 不再折叠为“无法创建通话”。

预检失败不修改旧通话。新 call 已提交后如果 TRTC/WebRTC 初始化失败，按现有 call error/teardown 处理；首版不跨新旧 call 自动回滚，因为旧实例已经释放且凭据、远端 identity 与屏幕发布角色均已换代。

## 12. Follow the System Default Audio Output

当前锁定的 `trtc-electron-sdk@13.3.801` 提供：

```ts
enableFollowingDefaultAudioDevice(
  TRTCDeviceType.TRTCDeviceTypeSpeaker,
  true,
): void;
```

TRTC main shared instance 在每次 `enterRoom()` 前启用该设置；Windows 和 macOS 使用同一路径。SDK 文档契约为：系统默认扬声器改变时立即切换播放设备。system child 是 publish-only，不调用该接口；它不应产生任何远端 playout。WebRTC fallback 继续使用 Chromium 对系统默认输出的原生跟随，不增加 `setSinkId()` 或设备 ID 持久化。

启用失败只上报 call-scoped、无设备名称的诊断事件并继续进房；不得因此停止屏幕、麦克风、系统声音或主通话。连接恢复时对当前 main generation 重新启用一次，旧 generation 回调不得触碰新实例。测试 fake cloud 必须证明 speaker 类型与 `true` 参数正确，且调用发生在 `enterRoom` 之前、重连后重套、失败不阻断进房。
