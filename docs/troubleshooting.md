# 故障排查

## 房间与菜单

- “房间已满”：该密钥已有两个不同 participant。关闭多余实例后等待 30 秒宽限期再试。
- macOS 看不到控制面板：点击系统顶部菜单栏的桌宠托盘图标，选择“打开控制面板”；也可按 `Ctrl+Alt+P`。
- 修改服务器或密钥后，本机 pet 与 controller 会同时断开旧房间并重连。

## 窗口缩放与诊断

- 桌宠大小异常或透明窗口上的 +/- 无法点击：打开控制面板，在“本机桌宠大小”中调整，或选择“恢复默认大小”。托盘菜单也提供 “Reset Pet Size”。
- Win10 上出现自动变大、跨显示器尺寸异常或缩放不生效：从控制面板选择“导出诊断日志”，也可从托盘选择 “Export Diagnostics...”，然后提供导出的 JSON 文件。
- 诊断文件包含应用/系统版本、显示器 DPI scaleFactor、窗口 bounds 和缩放请求结果；不会包含房间密钥、API Key 或音频内容，也不会自动上传。

## 通话

- 麦克风无权限：使用 HTTPS 或 localhost，并在系统和浏览器设置中允许麦克风/屏幕录制。
- 有连接但无画面：检查双方端点状态、屏幕录制权限及 ICE 类型。
- ICE 为 `failed`：当前 NAT 无法点对点打洞；需要配置可用 TURN。`relay` 时应用只保留音频并暂停屏幕视频；credential、端口和带宽诊断见 [Ubuntu 24.04 coturn 部署手册](./ubuntu-coturn-deployment.md)。

## ElevenLabs

- 没有可选声音：检查托管白名单 JSON；BYOK 则确认 Key 有权限访问声音。
- `tts_queue_full`：对方已有 3 条正在播放或等待的消息，稍后重试。
- `tts_rate_limited`：默认每位参与者每分钟最多 10 次。
- 401：API Key 无效；429：ElevenLabs 限流或额度不足；断流会显示播放失败。

## CosyVoice

- `/api/health` 显示 `tts: disabled`：检查 `TTS_PROVIDER=cosyvoice`、`DASHSCOPE_API_KEY`、`DASHSCOPE_WORKSPACE_ID` 和非空白名单。
- 401/403：API Key 与 Workspace 地域或权限不匹配；3.5 Plus 应使用北京地域。
- `tts_voice_not_allowed`：发送的 voice ID 不在 `COSYVOICE_VOICES_JSON`，或控制面板还保留着旧供应商的本地选择。
- 上游生成失败：确认 voice ID 是用 `COSYVOICE_MODEL` 指定的同一模型创建的。
- 白名单移除了已保存 voice：控制面板会清除旧选择并要求重选。

TTS 故障是隔离的，不应影响动作控制、房间连接或 WebRTC 通话。浏览器刷新会清除 BYOK Key；Electron 可从系统安全存储恢复。
