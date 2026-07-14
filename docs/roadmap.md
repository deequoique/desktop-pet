# 路线图

## v1.3 当前能力

- 网页控制台与桌宠合并为 Electron 二合一客户端。
- 稳定 participant 双端点模型与严格双人房间。
- 双向屏幕、麦克风、系统声音和双方远程控制。
- Windows、未签名 macOS x64/arm64、Linux server 发包。
- v1.2.1 新增 ElevenLabs / CosyVoice 低延迟克隆语音消息。
- 服务端声音白名单、ElevenLabs 可选 BYOK、目标桌宠 FIFO 播放、口型同步、限流和明确错误状态。
- v1.2.2 修复移除旧聊天组件后桌宠无法拖动的问题，并将 pet TypeScript 检查加入发布构建。
- v1.3.0 更新应用、托盘和网页图标，缩放范围调整为 0.3–1.5，并将透明桌宠拖动迁移到主进程系统光标轮询。

## 后续方向

- 继续改善中文克隆声音效果和供应商配置体验。
- ElevenLabs 之外的 BYOK 方案暂不承诺版本。

旧 AI 聊天、手工交换 SDP 和 macOS 签名/notarization 已不在计划中。房间、Socket.IO 信令和 WebRTC P2P 媒体架构保持不变。
