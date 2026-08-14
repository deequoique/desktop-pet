# TRTC Electron POC 入口核验（2026-08-12）

## 官方能力结论

- `trtc-electron-sdk` 提供 `getScreenCaptureSources` 枚举屏幕和应用窗口，并通过 `selectScreenCaptureTarget` 选择游戏窗口。
- `startScreenCapture(view, TRTCVideoStreamTypeSub, params)` 接受 `TRTCVideoEncParam`，可明确设置 1280×720/30fps 或 1920×1080/30fps，而不是沿用官方示例中的 15fps。
- `startSystemAudioLoopback(path?)` 可单独采集系统声音；空 path 采集整个系统，失败通过 `onSystemAudioLoopbackError` 回调观测。
- 远端订阅屏幕使用 sub stream；POC 不需要摄像头、录制、混流、CDN 或 UI Kit。
- UserSig 调试阶段可由控制台临时生成；正式接入必须由 server 使用 HMAC-SHA256 签发，SDKSecretKey 不能进入客户端。

## 官方来源

- Electron SDK API：https://web.sdk.qcloud.com/trtc/electron/doc/zh-cn/trtc_electron_sdk/TRTCCloud.html
- Electron SDK API 索引：https://web.sdk.qcloud.com/trtc/electron/doc/zh-cn/trtc_electron_sdk/index.html
- Electron 接入文档：https://cloud.tencent.com/document/product/647/116549
- UserSig：https://intl.cloud.tencent.com/document/product/647/35166
- Electron 发布日志：https://cloud.tencent.com/document/product/647/43117

## Phase 1 凭据边界

当前 POC 应用：

- 中国站 `SDKAppID`: `1600157176`（2026-08-14 已由用户开通并确认；该 ID 不是密钥）。
- Electron SDK 固定验证版本：`trtc-electron-sdk@13.3.801`。
- 官方隔离入口：`Tencent-RTC/TRTC_Electron` 的 `TRTC-API-Example`；未通过双端实测前不接入现有业务通话。

需要用户在中国站 TRTC 控制台完成：

1. 创建独立 POC 应用并取得 SDKAppID。
2. 保持入门版按量，不启用尊享版弱网增值能力。
3. 禁用录制、混流、CDN 旁路、审核和 AI 功能，并设置费用预警。
4. 创建两个有辨识度的测试 UserID，例如 `poc_cn_sender` 与 `poc_sg_viewer`，分别生成短期 UserSig。

`poc_cn_sender`、`poc_sg_viewer` 的临时 UserSig 已由用户在控制台生成。签名不得粘贴到聊天或提交到 Git；测试应用只在进入房间时通过弹窗接收，并仅保留在当前页面内存。

隔离的官方 Demo 已完成构建和 Windows 打包，使用 `trtc-electron-sdk@13.3.801`。安装包位于 `D:\desktop-pet\tmp\trtc-electron-demo\TRTC-API-Example\release\TRTC-Electron-API-Examples Setup 1.0.5.exe`，SHA-256 为 `6425A46691C9DB49CBFB2CC9C110AB11CDC5328195CCE327357254B63DFFFD1F`。当前机器是新加坡接收端，中国机器是游戏画面发送端；房间、身份、档位和计费操作见 `trtc-poc-runbook.md`。

允许向开发流程提供 SDKAppID；SDKSecretKey 不得通过聊天传递。临时 UserSig 只放在本机未跟踪配置中，不写入 task、日志或 Git。

## 首轮测试矩阵

| 发送档位 | 目标码率 | 时长 | 必测媒体 |
| --- | ---: | ---: | --- |
| 1280×720 / 30fps | ≤1.8Mbps | 30 分钟 | 游戏窗口 + 系统声音 |
| 1920×1080 / 30fps | ≤4Mbps | 30 分钟 | 游戏窗口 + 系统声音 |

每轮记录进房、首帧、实际收发 fps/分辨率/码率、RTT、上/下行丢包、系统声音中断、断线恢复、CPU/GPU 和控制台计费分钟。标准入门版不达标前，不开启 7 天增值体验。
