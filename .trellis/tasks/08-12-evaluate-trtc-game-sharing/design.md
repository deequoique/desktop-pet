# TRTC 游戏共享迁移设计（草案）

## 1. 决策原则

本次问题只出现在承载游戏画面与系统声音的主媒体链路；同一通话的摄像头 P2P 链路已有稳定约 140ms 的证据。因此最小方案不是一次性替换全部 WebRTC，而是先把不稳定的主媒体链路迁到 TRTC，摄像头暂时保留现状。

游戏发送帧率下限为 30fps。弱网调控只能降低码率/分辨率、改变传输路径或做丢包恢复，不能把帧率降到 30fps 以下。

## 2. POC 边界

2026-08-14 用户确认 POC 必须结合进现有项目。隔离 Demo 只保留为 SDK API 与打包验证依据；产品 POC 采用下述混合架构。

### 保留

- Socket.IO：登录、房间、设备在线、呼叫/接听/挂断、业务媒体控制、状态通知。
- 当前 WebRTC camera PC：POC 阶段继续承载双向摄像头。
- 当前 coturn/WebRTC main PC：作为灰度回退，不立即删除。

### 迁移

- Electron 内置 control window：通过 `control-preload.js` 的窄桥接使用 `trtc-electron-sdk`，目标设备以 30fps 发布屏幕辅流与系统声音，发起设备订阅远端辅流；renderer 保持 `contextIsolation: true`、`nodeIntegration: false`。
- pet renderer：最小 TRTC POC 不加载 native SDK。现有 WebRTC main PC 仅在 server 选择 `webrtc` 模式时使用。
- server：签发短期 UserSig 和不可猜测的 TRTC room/user 映射；SDKAppSecret 只保存在 server。

### 不启用

- IM、TUICallKit/TUIRoomKit、云端录制、云端混流、CDN 旁路、审核、AI 功能。

## 3. 运行时与身份

POC 每台参与设备使用一个 call-scoped controller 身份。TRTC roomId 与 userId 均由 server 从当前 call 和设备身份单向派生，不直接暴露稳定原始标识。一次通话由发起设备订阅目标设备的屏幕辅流；目标设备发布屏幕与系统声音。这样避免同机 pet 与 control 同时进房造成重复身份、重复计费和音频回路。

若后续迁移双向摄像头，再评估两个方案：

1. 复用两个 TRTC 身份并发布主路 camera + 辅路 game screen，费用较低但需要跨 renderer 共享 SDK 生命周期。
2. 为 control camera 创建第三个 TRTC 身份，生命周期清晰但会增加一路在房/订阅用量。

## 4. 信令与生命周期

1. 当前 Socket.IO `call:start` 后，两端 controller 请求 `trtc:get-config`。
2. Server 校验当前 call、角色和设备归属，返回 `sdkAppId`、短期 `userSig`、`roomId`、`userId`、`expiresAt` 和媒体权限。
3. 目标设备的 control preload 进入房间，选择主屏幕、启动系统声音并以 30fps 发布辅流。
4. 发起设备的 control preload 进入房间并只渲染 server 指定的远端 userId 辅流；远端音频由同一 TRTC 身份接收。
5. `TRTC_MEDIA_MODE` 是 server 权威开关：`webrtc` 原样走旧主媒体，`trtc` 走云端主媒体。首个集成版本不做单端静默自动回退，避免两端选择不同媒体层；失败时结束本次主媒体并提示，运维可关闭 flag 回滚。
6. call end、窗口关闭和 socket 断线都通过集中 teardown 退出 TRTC、停止系统声音并释放 native SDK。

## 5. 质量档位

POC 同时测试：

- 1280x720 / 30fps，目标不高于 1.8Mbps；若画质不合格，不伪装成低成本 HD。
- 1920x1080 / 30fps，目标不高于 4Mbps。

帧率始终不低于 30fps。弱网时允许降低分辨率或码率，但必须记录实际接收分辨率、码率、帧率、RTT、丢包、抖动和系统声音卡顿。

## 6. 安全、灰度与回滚

- UserSig 仅由 server 签发，短 TTL，绑定当前 call 和允许角色。
- 使用 feature flag 选择 `webrtc`、`trtc` 或 `trtc-with-webrtc-fallback`。
- TRTC 故障只回退媒体，不改变 Socket.IO 房间和业务状态。
- 现有 WebRTC 实现至少保留一个发布周期；POC 失败可关闭 flag，无数据迁移。

## 7. POC 成功门槛

在与现诊断相同的中国大陆↔新加坡真实双端场景，各完成 720p30 与 1080p30 连续 30 分钟：

- 实际接收帧率 P95 不低于 30fps；统计语义需在实现前固定。
- 系统声音无可感知连续中断，补充客观丢包/卡顿统计。
- 无整条媒体连接失败或人工重连。
- 相比当前 WebRTC，冻结时长、丢包、抖动和恢复次数显著下降。
- 记录真实计费分钟与预估误差，确认没有意外录制、混流或多身份用量。

若无法同时满足 30fps 和系统声音稳定，停止迁移，不因已投入 SDK 集成而扩大范围。

## 8. 套餐决策

生产默认候选为入门版按量付费。当前证据显示本地网络与摄像头直连稳定，主要问题是主媒体在 P2P、单节点 TURN/UDP 与 TURN/TCP 之间选路和恢复不稳；标准 TRTC 的云端接入与转发本身就可能解决主要矛盾，不能在验证前把额外“弱网通话卡顿优化”视为必需。

测试顺序固定为：

1. 入门版标准 TRTC，同条件完成 720p30 / 1080p30。
2. 只有标准版仍不达标时，开启限时增值体验并重复完全相同测试。
3. 只有增值版相对标准版在系统声音中断、冻结、丢包、抖动或恢复时间上有稳定且有意义的改善，才考虑尊享版月费。

## 9. 摄像头空闲连接

修复前的实现会在主 PC connected 且 selected route 明确后调用 `beginCameraCall()`，双方摄像头关闭时也会建立 camera PeerConnection。关闭动作本身会 `replaceTrack(null)` 并停止硬件 track，因此空闲 camera PC 不发送摄像头 RTP；诊断中 camera 的视频包和码率为 0，只有少量 ICE/STUN keepalive 与候选探测。

这不是本次主链路拥塞的主要来源，但会产生不必要的 socket/NAT/ICE 状态、TURN allocation 概率和诊断噪声。若未来为 camera 建独立 TRTC 身份，还可能产生额外在房音频时长。

已实现取消 camera 自动预热：首次任一方明确开启 camera 时才创建 camera transport；在此之前不创建 camera PeerConnection、不做 camera ICE/TURN 探测。代价是首次开启摄像头需要等待 ICE/TRTC 首帧，不能再做到预热后的近即时出画。

双方摄像头再次关闭时，立即停止 capture、移除 sender track，并销毁 camera transport，不保留快速重开的宽限期。再次开启时重新创建 transport 并协商；用户接受每次重开都会重新等待 ICE/TRTC 首帧，以换取关闭状态下不保留 camera 网络与 NAT/TURN 资源。
