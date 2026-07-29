# 提升通话可靠性与低带宽视频

## Goal

保证两人通话在 P2P 与 TURN 两种路径下都至少有可用媒体：修复双端通话生命周期，支持双方仅控制自己的双向摄像头，并在 TURN relay 下以受限最低画质继续传输屏幕与摄像头，而不是退化为纯音频。

## Confirmed Product Decisions

- 双方都应看到对方屏幕，并能在各自开启摄像头后互相看到摄像头。
- 每个人只能打开、关闭和切换自己的摄像头；对方不能远程启动硬件。
- 摄像头每次通话默认关闭，首次本机开启才申请权限。
- P2P 失败并选中 TURN relay 时，屏幕和已开启的摄像头继续传输最低清画质，音频优先。
- TURN 固定最低清 profile：screen 640×360、5fps、最高 240 kbit/s；每路 camera 320×180、10fps、最高 120 kbit/s。

## Child Deliverables

| Child task | Outcome | Dependency |
| --- | --- | --- |
| `07-28-bidirectional-call-camera` | 修复单向可见回归；建立双方本地控制的双向 camera 协议、轨道和 UI | 可先独立完成 P2P 验收 |
| `07-28-turn-low-bandwidth-video` | 将主屏幕与双向 camera sender 在 relay 下切换为受限低清 profile，并恢复到 P2P profile | Screen 部分可独立；camera 部分依赖前一 child |

## Cross-child Requirements

- 主屏幕/音频与 camera 使用独立 PeerConnection；camera failure 不结束主通话。
- P2P 保持现有正常画质；只有 selected pair 明确为 relay 时应用低清 profile。
- 路由从 P2P↔relay 切换时不重新申请权限、不重新捕获屏幕/摄像头，只调整 sender track/encoding。
- TURN 下优先保证麦克风与系统声音；屏幕和 camera 都必须有独立且可验证的码率、帧率和分辨率上限。
- 所有 UI 状态明确区分 P2P 正常画质、TURN 低清视频、选路中与失败。
- 低带宽策略必须与 coturn `max-bps`、`bps-capacity` 和单通话 allocation 数量一起验收，不能只检查页面有画面。

## Acceptance Criteria

- [ ] A、B 双方主通话不会因 React listener/角色变化被 teardown，双方都能收到对方屏幕和音频。
- [ ] 双方可独立开启自己的摄像头并同时看到对方；任何远程 camera control 都被拒绝。
- [ ] P2P 下屏幕和 camera 使用正常 profile；强制 relay 下 screen 不超过 640×360、5fps、240 kbit/s，每路 camera 不超过 320×180、10fps、120 kbit/s，并持续显示。
- [ ] 强制 relay 时音频连续可懂，视频不会使 coturn 超过配置上限或出现持续丢包/断流。
- [ ] P2P↔relay 恢复不会重新弹权限、泄漏 track 或把用户关闭的 camera 自动打开。
- [ ] Server/pet 自动测试、web/pet 构建和两台隔离 Electron profile 的 P2P/强制 relay 矩阵通过。

## Out of Scope

- 多人会议、云端录制、自适应多档 simulcast/SVC。
- 为了视频扩大到不受控的 TURN 带宽或取消 coturn 配额。
- 改变用户只能控制自己摄像头的隐私边界。
