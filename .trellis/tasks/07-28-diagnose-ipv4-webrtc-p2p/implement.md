# IPv4 WebRTC P2P 诊断实施计划

## Dependency Gate

- `07-28-client-crash-diagnostics` 已完成 renderer 事件持久化、脱敏、轮转和导出测试。
- 父任务的网络元数据隐私边界已确认。
- 未满足时只保留本计划，不开始 WebRTC 接入。

## Phase 1：诊断基础设施

1. 阅读并遵守 pet 主进程、renderer 与 web 包的 Trellis 规范。
2. 在现有 diagnostics 模块旁增加 RTC 事件校验、裁剪和落盘入口。
3. 在主进程增加受限 IPC，并校验 pet/control sender。
4. 在两个 preload 暴露窄接口。
5. 扩展 diagnostics 测试：
   - 合法事件可写入和导出
   - 超长或非法 payload 被裁剪/拒绝
   - secret、credential、token 等仍被脱敏
   - candidate IP/端口按设计保留

## Phase 2：两端统一观测

1. 为 web 控制端实现无副作用的 candidate、state 和 stats 序列化。
2. 为 pet renderer 实现相同事件契约。
3. 接入主通话 PeerConnection：
   - 创建/关闭
   - 本地 candidate
   - 远端 candidate 收到、入队、添加和失败
   - gathering、signaling、ICE、connection 状态
   - `icecandidateerror`
   - 关键节点 stats
4. 对摄像头 PeerConnection 至少加入 `mediaKind`、candidate、状态和 selected pair，避免诊断混线。
5. 保证任何诊断失败不会阻断现有 offer/answer/candidate 流程。

## Phase 3：界面准确性

1. 修正 `unknown`/未选路状态为“选路中”。
2. selected pair 可用后显示 IPv4 P2P、IPv6 P2P 或 TURN。
3. 保留 relay 仅音频提示，技术细节仍放在诊断导出。

## Phase 4：自动验证

1. 运行 diagnostics 单元测试。
2. 为 candidate 序列化、pair 展开、selected pair 回退和状态映射补单元测试。
3. 运行 web 与 pet 的类型检查、测试和构建。
4. 检查导出的 fixture，不得出现完整 SDP 或 credential。

## Phase 5：人工对照测试

前置依赖：`.trellis/tasks/07-28-bidirectional-call-camera/` 已完成并证明 A、B 主通话都不会被控制端 listener cleanup 提前销毁。

1. A-Windows（IPv6）↔ B，建立成功通话并导出双方日志。
2. A-Mac（无 IPv6）↔ B，保持相同服务器和 `policy=all`，复现后导出双方日志。
3. 以 `callId` 和 username fragment 对齐两端。
4. 按 PRD 判定规则出具结论：
   - STUN/gathering
   - signaling
   - ICE generation/timing
   - NAT/firewall/operator path
5. 只有证据指向代码缺陷时再建立修复任务；若证据指向网络路径，再决定是否增加第二 STUN、TURN/UDP 优化或产品提示。

## Explicit Non-Changes

本任务第一轮不修改 ICE server 列表、candidate 优先级、信令协议、协商模型、重试时序或 TURN 媒体策略。
