# 项目内 TRTC POC 配置与运行

## 已接入边界

- Server：按当前 call 为 controller 签发短期 UserSig，SecretKey 只从 server 环境变量读取。
- Electron control preload：加载 `trtc-electron-sdk@13.3.801`，通过窄桥接发布/订阅，不向 renderer 暴露 Node 或 SDK 对象。
- 主媒体：目标设备发布主屏幕辅流与系统声音；发起设备订阅。
- 摄像头：继续使用现有 controller↔controller 按需 WebRTC。
- 回滚：Server 把 `TRTC_MEDIA_MODE` 改回 `webrtc` 并重启；客户端收到模式后立即使用原主媒体链路。

## Server 配置

在服务器的私有 `.env` 中设置，不能把 `TRTC_SECRET_KEY` 发到聊天或提交 Git：

```dotenv
TRTC_MEDIA_MODE=trtc
TRTC_SDK_APP_ID=1600157176
TRTC_SECRET_KEY=<腾讯云控制台中的SDKSecretKey>
TRTC_USER_SIG_TTL_SEC=900
TRTC_VIDEO_PROFILE=720p30
```

首轮完成后，将 `TRTC_VIDEO_PROFILE` 改为 `1080p30` 并重启 server，再重复测试。`720p30` 固定30fps/1800kbps；`1080p30` 固定30fps/4000kbps。

两端客户端必须都升级后才能把 Server 切到 `trtc`。旧 Server 没有 `call:start.mediaMode` 时，新客户端会立即使用 WebRTC，不额外等待 TRTC 超时。

## 双机角色

- 新加坡当前机器：发起通话的一方，只订阅中国目标设备的屏幕与声音。
- 中国机器：被选中的目标设备，自动发布本机主屏幕和系统声音。

因此测试时必须从新加坡控制端选择中国设备并点击“开始通话”。如果由中国端发起，发布方向会反过来。

## 观察项

通话侧栏会显示 `TRTC 云端`、延迟、屏幕档位、接收/发送码率与帧率。目标端显示“正在通过 TRTC 分享本机主屏幕和系统声音”；新加坡端显示远端辅流。麦克风默认关闭，开启后才把 TRTC microphone capture volume 从0设为100。

每个档位连续运行30分钟，记录首帧、实际FPS、码率、RTT、丢包、系统声音中断、连接恢复、CPU和控制台计费分钟。首轮标准TRTC不达标后，才考虑弱网增值能力。

## 2026-08-14 构建产物

- Windows 安装器：`D:\desktop-pet\pet\release\Desktop Pet Setup 1.6.2-beta.1.exe`
- 文件大小：93,578,982 bytes
- SHA-256：`A1D046BE201B144D3231066C5506EC357537E1014A352D943E5CD59F9DF1E529`
- 已核对安装包解包目录包含 `trtc_electron_sdk.node`、`liteav.dll`、`liteav_screen.dll`、`live_kit_engine.dll`、`txffmpeg.dll`、`txsoundtouch.dll` 和 `liteav_media_server.exe`。
- 此结论只证明项目集成、原生加载与 Windows 打包通过；跨境链路质量仍须按上述双机流程实测，不能由本机构建结果代替。
- 因真实中新双机验收尚未完成，本次 GitHub 发布采用预发布版本 `v1.6.2-beta.1`。
