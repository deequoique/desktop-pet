# TRTC 音频分离与 Windows AEC 研究

查询日期：2026-08-15

## Sources

- 项目锁定依赖：`trtc-electron-sdk@13.3.801`（`pet/package.json`、`pet/package-lock.json`）。
- npm 官方注册表包：<https://registry.npmjs.org/trtc-electron-sdk/-/trtc-electron-sdk-13.3.801.tgz>。
- 腾讯官方 Electron API：<https://web.sdk.qcloud.com/trtc/electron/doc/zh-cn/trtc_electron_sdk/TRTCCloud.html>。
- 腾讯官方 Electron 示例仓库：<https://github.com/Tencent-RTC/TRTC_Electron>。
- Microsoft `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS`：<https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_process_loopback_params>。
- Microsoft `PROCESS_LOOPBACK_MODE`：<https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ne-audioclientactivationparams-process_loopback_mode>。
- Microsoft Application Loopback 官方示例：<https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/ApplicationLoopback>。
- Microsoft WASAPI loopback 总览：<https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording>。
- 当前项目实现：`pet/src/main/trtc-preload-bridge.js`、`server/src/index.js`、`web/src/App.tsx`。

## Confirmed SDK Contracts

### 1. 同一用户的麦克风与系统声音在上行前混合

`startSystemAudioLoopback(path)` 的精确版本类型声明和官方 API 都说明：系统声音会混入当前麦克风采集的声音后一起发送。接收端的 `muteRemoteAudio(userId, mute)` 会停止拉取该远端用户的整路音频，没有按“麦克风/系统声音”区分的参数。

结论：只给一个 TRTC 用户维护两个 UI 状态无法实现真正的独立收听；音源必须由不同 `userId` 发布，或进入自定义 PCM 管线。

### 2. SDK 原生支持主实例麦克风 + 子实例系统声音

`TRTCCloud.createSubCloud()` 的官方示例明确使用：

```js
const rtcCloud = TRTCCloud.getTRTCShareInstance();
rtcCloud.startLocalAudio();
const childRtcCloud = rtcCloud.createSubCloud();
childRtcCloud?.startSystemAudioLoopback();
```

这与本任务的分源目标直接一致。主实例可以继续使用 SDK 默认麦克风采集和播放链路；屏幕共享方额外创建子实例，以第二个 call-scoped `userId` 发布系统声音。接收端即可分别对主用户和系统声音用户调用 `muteRemoteAudio`。

### 3. 自定义音频采集不是 AEC 首选

`enableCustomAudioCapture(true)` 会关闭 SDK 默认麦克风采集，要求应用按固定节奏注入 PCM。SDK 明确警告：AEC 依赖严格控制采集与播放时序，启用自定义音频采集后 AEC 可能失效。

结论：麦克风必须优先保留 SDK 默认采集链路。若最终需要自定义 Windows 系统回环，只能放在不采集麦克风的系统声音子实例中，不能替换主实例麦克风链路。

### 4. 全系统回环没有“排除本应用播放”的公开保证

官方只说明：

- `path` 为空：采集整个操作系统的播放声音；
- `path` 非空：启动并只采集指定 exe 的声音。

公开 API 没有排除当前 Electron/TRTC 进程、指定音频 session 或排除目标进程树的参数。当前项目使用空 path，且用户已实际观察到回声，因此设计不能假定 SDK 会自动排除远端播放。

## Recommended Architecture

### Main identity per participant

- 沿用每台设备现有 `c_<hash>` 身份。
- 两端主身份都只用 SDK 默认麦克风链路；用户明确开启时才 `startLocalAudio(TRTCAudioQualityDefault)`，关闭时停止或静音。
- 当前 target 主身份继续发布 720p30/1080p30 屏幕辅流；视频角色不变。
- 主实例负责接收和播放对方麦克风，使 Windows SDK 可以使用同一默认语音链路完成声学 AEC。

### System-audio child identity for the screen publisher

- Server 只为当前屏幕共享方签发第二个 call-scoped `systemUserId` 和短期 UserSig；观看方只拿到 `remoteSystemUserId`。
- 屏幕共享方通过主实例 `createSubCloud()` 创建系统声音子实例，并以第二个身份进入同一房间。
- 子实例在进房前 `muteAllRemoteAudio(true)`，只发布系统声音，不拉取或播放任何远端音频。
- 观看方默认同时静音 `remoteUserId` 和 `remoteSystemUserId`，两个 UI 开关分别解除对应身份的静音。
- 挂断时先停止 system loopback、退出并销毁子实例，再停止主实例音频/视频并退出房间；所有迟到回调受 call ID 和实例 generation 保护。

## Windows Process-Loopback Exclusion Findings

Microsoft 的 `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` 允许通过 `ActivateAudioInterfaceAsync` 激活虚拟 process-loopback 设备；传入：

- `TargetProcessId = Electron 主进程 PID`；
- `ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`；
- 设备名 `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK`。

官方契约明确说明，目标进程及其所有子进程的 render stream 都会从回环流中排除，其他进程的声音仍被捕获，而且该捕获不绑定单个物理输出端点。Microsoft 官方 `ApplicationLoopback` 示例直接提供 `excludetree` 模式，正好对应“无须选择游戏，采集所有声音但排除本应用”的产品要求。

当前 Electron 应用不会启动游戏或目标应用（`pet/src/`、`web/src/`、`server/src/` 中没有游戏进程 spawn/exec 路径），因此独立启动的游戏不属于 Electron 子树，不会被误排除。实现仍需在 POC 中检查 TRTC 实际 render stream 的所属 PID；若 SDK 把播放交给不属于 Electron 子树的外部常驻服务，单纯排除 Electron 根 PID 不足以完成验收，不能静默放行。

官方接口和示例的最低技术门槛为 Windows build 20348。常见 Windows 10 22H2 build 19045 低于该门槛，Windows 11 build 22000+ 满足。产品范围进一步简化为只在 Windows 11 启用该能力，不为 Windows Server 或特殊 Insider build 建立额外分支。普通 endpoint loopback 的 event-driven 支持门槛（Windows 10 1703）不等于 process-tree exclusion 的门槛，不能混用。

官方示例的音频边界：

- 异步激活完成后取得 `IAudioClient`；
- shared mode + `AUDCLNT_STREAMFLAGS_LOOPBACK | EVENTCALLBACK | AUTOCONVERTPCM`；
- 示例固定为 44.1 kHz、双声道、16-bit PCM，也说明可用 `GetMixFormat`；
- event 驱动后必须循环 `GetNextPacketSize`，一次唤醒读取全部 packet，并逐个 `GetBuffer` / `ReleaseBuffer`；
- stop 时先取消等待 work item，再 `IAudioClient::Stop()`，等异步收尾完成后释放资源。

TRTC 13.3.801 的 `sendCustomAudioData()` 支持 16/24/32/44.1/48 kHz、单/双声道 PCM，帧长 5–100 ms，推荐 20 ms，并要求按帧长稳定投送。设计因此统一为 48 kHz、双声道、16-bit、20 ms（每帧 3840 bytes），helper 负责采集和有界分帧，preload 负责按 PTS 投给 system child identity；不得把 PCM 注入主麦克风 identity。

## Chosen Windows Echo Strategy

1. 主麦克风实例使用 `TRTCAudioQualityDefault` 和 SDK 默认采集/播放链路，保留 TRTC 的声学 AEC；不使用自定义麦克风 PCM。
2. 系统声音由 target-only child identity 发布；该 child 在进房前 `muteAllRemoteAudio(true)`，从不播放远端声音。
3. Windows 不再调用 TRTC 的空-path `startSystemAudioLoopback()`。小型 Win32 helper 以 Electron 主进程为排除根，采集其余系统声音并输出 PCM；system child 使用 `enableCustomAudioCapture(true)` / `sendCustomAudioData()` 上行。
4. 不提供游戏/exe 选择器。Windows 10 按产品决定继续使用 TRTC 未排除的整机 loopback，允许数字回声；Windows 11 的 helper 或排除验证失败时，系统声音源 fail closed，不能静默伪装成 Windows 10 降级，屏幕和双方麦克风继续工作。
5. macOS system child 继续用 TRTC 原生 `startSystemAudioLoopback()`；核心分源和控制保持一致，但 macOS 免提回声消除不作为首版门槛。
6. 耳机只作为异常设备配置的提示，不能替代 Windows 外放验收。

## Cost and Security Impact

- 屏幕共享方在系统声音发布期间多一个 TRTC 房间身份和一路纯音频流；设计和实测必须核对额外音频时长/订阅计费。
- 第二身份仍由 server 从 call 和设备派生，短 TTL 签名；SecretKey 不进入客户端。
- system identity 只授权当前 target，不能由 initiator 或非 call controller 请求。
- 系统声音子实例按屏幕/系统声生命周期按需进房，挂断和 capture failure 必须立即退出，避免空闲计费。

## Validation Implications

- Server：两个主身份互指，只有 target 获得本地 system config，只有 initiator 获得对应 remote system ID；错误 role、过期 call 和非 target 请求均拒绝。
- Preload：主/子实例事件和资源分开；默认静音在进房前设置；teardown 幂等且先子后主。
- UI：非共享端显示独立系统声/麦克风开关，共享端只显示远端麦克风；新通话全部默认关闭。
- Windows POC：必须用外放扬声器验证系统回环和麦克风两条回声路径，不能只用耳机通过。
- macOS：核心双向麦克风与独立控制仍需通过；免提 AEC 不作为本任务门槛。

## Default Audio Output Following Evidence

锁定包 `trtc-electron-sdk@13.3.801` 的类型声明同时在 `TRTCCloud` 与 `TRTCDeviceManager` 暴露默认设备跟随能力：

```ts
enableFollowingDefaultAudioDevice(
  deviceType: TRTCDeviceType,
  enable: boolean,
): void;
```

声明说明该接口只支持麦克风和扬声器；传入 `TRTCDeviceTypeSpeaker` 与 `true` 后，系统默认音频输出改变时 SDK 立即切换播放设备。SDK 还提供 `TRTCDeviceState.TRTCDefaultDeviceChanged`、`getCurrentSpeakerDevice()` 和 `setCurrentSpeakerDevice()`，但本产品不需要维护手动设备列表或固定设备 ID。

结论：主 TRTC playout 应直接启用 SDK 跟随，不通过 Chromium `enumerateDevices()` 轮询，也不把设备名称/ID送入 renderer 状态。publish-only system child 不播放远端音频，不需要设备跟随。该调用失败时保留主通话并记录无设备名称的可恢复诊断。
