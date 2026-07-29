# IPv4 WebRTC P2P 诊断设计

## Dependency Contract

开始实现前必须读取 `07-28-client-crash-diagnostics` 的最终事件、IPC 和导出契约。本设计中的 `webrtc.*` 事件使用该契约；若客户端基础任务尚未完成，本任务不得以临时 console-only 方案替代。

## 1. 设计原则

第一轮只增加可观测性和修正错误文案，不改 ICE 行为。所有诊断都以一次 PeerConnection 和对应 `callId` 为边界，并在控制端、桌宠端采用同一事件模型。

## 2. 事件模型

统一写入 `webrtc.*` 事件：

| 事件 | 触发时机 | 关键字段 |
| --- | --- | --- |
| `webrtc.peer-created` | PeerConnection 创建 | role、mediaKind、callId、policy、ICE server 类型计数 |
| `webrtc.candidate` | 本地生成、远端收到/入队/添加 | direction、action、candidate 字段 |
| `webrtc.gathering-complete` | 空 candidate 或 gathering complete | role、callId |
| `webrtc.ice-candidate-error` | `icecandidateerror` | url、errorCode、errorText |
| `webrtc.state` | 四类状态变化 | stateKind、value |
| `webrtc.stats` | 关键状态节点 | selected pair、candidate pairs、candidate 字典 |
| `webrtc.peer-closed` | 主动关闭或替换 | reason、final states |

`mediaKind` 至少区分主通话连接与摄像头连接。IPv4 P2P 的第一轮人工结论以承载音频/屏幕的主连接为主；摄像头连接保留同样的关联字段，避免两条 PeerConnection 混淆。

## 3. Candidate 序列化

优先读取 `RTCIceCandidate.toJSON()` 及浏览器公开字段。若浏览器未暴露某个拆分字段，则从 candidate 字符串中做最小、容错的只读解析；解析失败不能影响 candidate 的信令发送或添加。

不保存原始 candidate 字符串，因为它可能重复暴露更多网络信息，也不利于稳定比较。结构化记录保留诊断所需的 IP、端口和 ICE username fragment。

## 4. Stats 快照

每次快照先建立 `local-candidate`、`remote-candidate` 的 ID 索引，再展开 `candidate-pair` 引用，输出紧凑数组。selected pair 的识别按以下顺序：

1. `transport.selectedCandidatePairId`
2. candidate pair 的 `selected`
3. `nominated && state === "succeeded"` 作为兼容回退

快照只在下列事件触发：

- ICE `connected` / `completed`
- PeerConnection `connected`
- ICE 或 PeerConnection `failed`
- 持续 `disconnected`
- 路由信息刷新
- 连接关闭前

同一状态短时间重复触发时去重，防止日志膨胀。`getStats()` 异常只记录一次诊断错误，不影响通话。

## 5. Renderer 到主进程的持久化

在 pet preload 与 control preload 暴露受限的 `recordRtcDiagnostic` 方法。主进程接收后：

- 校验 sender 是现有 pet/control window 的 `webContents`
- 只接受允许的事件名与纯 JSON 数据
- 限制单条 payload 大小、字符串长度和数组长度
- 主进程自行附加 source、timestamp
- 使用现有 `appendDiagnostic` 写入、脱敏和轮转

renderer 不可指定日志路径或绕过诊断模块。主进程不接受完整 SDP、credential 等禁止字段；相关测试覆盖入口校验和已有脱敏规则。

## 6. UI 路由状态

将路由状态明确分为：

- `selecting`：尚无 selected pair
- `p2p-ipv6`
- `p2p-ipv4`
- `relay`
- `failed`

原有 `unknown` 映射为“选路中”。“连接稳定”只在连接状态成功且已解析 selected pair 后出现。relay 继续展示仅音频提示。

## 7. 实验与判定

使用同一版本按顺序执行：

1. A-Windows（有 IPv6）与 B：验证成功基线，导出两端日志。
2. A-Mac（无 IPv6）与 B，保持 `policy=all`：复现问题，导出两端日志。
3. 对齐同一 `callId`，检查双方 candidate 生成、接收、添加和 pair 状态。

分析顺序固定为：

```text
是否生成 IPv4 srflx
  → 是否到达对端
    → 是否成功 addIceCandidate 且 generation 匹配
      → 是否创建 direct pair
        → connectivity check 为何失败
          → 最终是否选择 relay
```

如果双方 `srflx` 与 direct pair 都完整但检查失败，第一轮结论限定为“IPv4 NAT/防火墙/运营商路径不支持这组端点直连”。需要识别对称 NAT 时，再设计第二阶段的双 STUN 映射对照，不混入本次观测实现。

## 8. 安全与隐私

- 禁止记录完整 SDP、媒体内容、room secret、TURN credential 和 API key。
- IP、端口和 username fragment 属于必要网络诊断元数据，仅落入本机轮转日志和用户主动导出的文件。
- 诊断入口的长度限制防止远端 candidate 或异常浏览器事件放大日志。

## 9. 风险与回滚

- 风险：诊断代码抛错影响信令。缓解：所有序列化、持久化、stats 采集均 best-effort，失败不进入协商控制流。
- 风险：日志过多。缓解：关键节点采样、重复状态去重、字段和数组上限、沿用 1 MB 轮转。
- 风险：日志改变时序。缓解：不 await 持久化，不进行周期性高频 `getStats()`。
- 回滚：移除诊断调用与 UI 文案修正即可；不涉及协议或服务端数据迁移。
