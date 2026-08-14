# TRTC Electron POC 双端运行手册

## 固定信息

- SDKAppID：`1600157176`
- Electron SDK：`trtc-electron-sdk@13.3.801`
- 房间号：`57176`
- 中国端角色：发送端，UserID `poc_cn_sender`
- 新加坡端角色：接收端，UserID `poc_sg_viewer`
- 安装包：`D:\desktop-pet\tmp\trtc-electron-demo\TRTC-API-Example\release\TRTC-Electron-API-Examples Setup 1.0.5.exe`
- 安装包大小：69,056,413 bytes
- SHA-256：`6425A46691C9DB49CBFB2CC9C110AB11CDC5328195CCE327357254B63DFFFD1F`

临时 UserSig 只在应用弹窗中粘贴，仅保留在当前页面内存。不要把 UserSig 或 SDKSecretKey 写入聊天、文件、日志或 Git。当前控制台生成的临时签名有效期为 7 天时，应在过期后重新生成。

## 新加坡接收端（当前机器）

1. 安装并打开测试应用。
2. 在左侧进入 `Basic` > `Screen Share`。
3. 房间号填 `57176`，UserID 填 `poc_sg_viewer`。
4. 进入房间时，在弹窗粘贴为 `poc_sg_viewer` 生成的临时 UserSig。
5. 不点击 `Share`。保持页面打开，应用会订阅中国端发布的屏幕辅流和系统声音。
6. 观察接收分辨率、FPS、码率、RTT、丢包和 CPU 数据，并记录卡顿及声音中断的时间点。

## 中国发送端

1. 把同一个安装包发到中国 Windows 机器并安装打开。若 SmartScreen 提示未知发布者，先核对上述 SHA-256，再选择继续运行。
2. 在左侧进入 `Basic` > `Screen Share`。
3. 房间号填 `57176`，UserID 填 `poc_cn_sender`。
4. 进入房间时，在弹窗粘贴为 `poc_cn_sender` 生成的临时 UserSig。
5. 第一轮选择 `1280×720 / 30fps / 1800kbps`，选择游戏窗口并点击 `Share`。
6. 第二轮选择 `1920×1080 / 30fps / 4000kbps`，选择相同游戏窗口并点击 `Share`。
7. 发布屏幕时系统声音 loopback 会同步启动；麦克风采集音量被设为 0。

## 首轮测试矩阵

| 轮次 | 档位 | 时长 | 必查项目 |
| --- | --- | ---: | --- |
| 1 | 1280×720 / 30fps / 1800kbps | 30 分钟 | 游戏窗口、系统声音、画面连续性、恢复能力 |
| 2 | 1920×1080 / 30fps / 4000kbps | 30 分钟 | 游戏窗口、系统声音、画面连续性、恢复能力 |

每轮记录发送与接收分辨率、FPS、码率、RTT、上下行丢包、CPU、首帧时间、声音中断、断线恢复和控制台计费分钟。优先在相近时段、相同网络环境下与现有 WebRTC 做对照。

## 计费和停止方式

- 进入房间后即产生音频在房时长，即使双方麦克风未开。
- 中国端点击 `Share` 并开始发布视频后，会产生对应档位的视频计费时长；系统声音随屏幕共享发布。
- 测完后两端都离开该页面或关闭应用，确认发送和接收统计停止增长。
- 首轮只验证标准按量 TRTC。只有标准线路仍不达标，才用相同条件测试弱网增值能力。
