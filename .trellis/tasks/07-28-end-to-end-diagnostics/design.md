# 端到端诊断系统设计

## 1. 边界

```text
产品代码
  → 统一事件/错误分类
    → 本地或 server logger
      → client incident bundle / PM2 日志
        → 人工导出、过滤与跨层关联
```

本任务不引入外部 APM。留证自动发生并仅保存在本机；只有用户主动操作才生成导出文件，不存在后台上传路径。

## 2. Event Envelope

```ts
type DiagnosticEvent = {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  domain: string;
  event: string;
  errorCode?: string;
  source: 'server' | 'electron-main' | 'pet-renderer' | 'control-renderer';
  appVersion: string;
  runtimeSessionId: string;
  recoverability?: 'automatic' | 'retryable' | 'user_action' | 'fatal';
  correlation?: {
    callId?: string;
    requestId?: string;
    jobId?: string;
    socketSessionId?: string;
    deviceRef?: string;
  };
  context?: Record<string, unknown>;
  exception?: {
    name?: string;
    message: string;
    stack?: string;
    cause?: unknown;
  };
};
```

各运行时本地实现 envelope，暂不为此新建共享 npm package。仓库当前没有共享 schema package；通过契约测试和字段搜索保持同步。

## 3. Error Taxonomy

稳定 code 使用 `<domain>_<condition>`，例如：

- `socket_server_unreachable`
- `config_room_secret_rejected`
- `media_microphone_permission_denied`
- `webrtc_ice_connectivity_failed`
- `app_renderer_crashed`
- `storage_diagnostic_write_failed`

错误 code 与 UI 映射分离。未知异常保留 stack，但使用 `<domain>_unexpected`，同时标记 `recoverability`。

## 4. Client Data Flow

renderer 通过受限 preload API 发送结构化事件；主进程重新校验、补齐可信 source/runtime 字段并写入。

主进程维护：

- 滚动 JSONL：普通事件和 breadcrumbs。
- incident index：每个 `error/fatal` 或 crash 的摘要、关联 ID 和状态。
- incident snapshot：故障附近有界 breadcrumbs、runtime snapshot、规范化 exception。
- crash artifact index：Electron/Chromium 本地 crash 文件 metadata，不直接嵌入大型二进制导出。
- clean shutdown marker：下次启动识别非正常退出。

renderer 注册 `window.error`、`unhandledrejection`、React root ErrorBoundary 和关键业务 promise 的显式分类上报。main 注册 process/window/crash/load hooks。

## 5. Server Data Flow

server logger 输出 JSONL 到 stdout/stderr，由 PM2 负责持久化和轮转。Socket handler 使用脱敏 connection context；call 生命周期创建 `callId` correlation。

对 trickle ICE 不逐条输出 SDP/candidate，只累计 description/candidate/end 数量、sender/target role、forwarded/rejected 和拒绝原因，并在 call 结束时汇总。

HTTP 日志记录方法、归一化 route、status、duration 和 request ID；一次性 TTS job URL 不原样写入通用访问日志。

## 6. Incident Lifecycle

```text
warn/error/fatal
  → 写事件
  → 达到 incident 条件？
      否：留作 breadcrumb
      是：冻结附近 breadcrumbs + snapshot
          → 本地 incident
          → 下次用户主动打开控制面板时显示持久提示
          → 用户主动导出
```

重复错误按 `errorCode + top stack frame + correlation` 指纹合并，保存 count、firstSeen、lastSeen，避免错误风暴。

fatal incident 不触发启动弹窗，也不改变现有控制面板启动策略。提示只在控制面板实际打开后渲染，并保持到用户导出或忽略；普通 warn/error 延续非阻塞交互。

## 7. Export UX

设置页使用独立“诊断与故障”区块。设置按钮、托盘快捷入口和 crash banner 都调用同一 main-process export handler：

1. 提示诊断包包含 IP、端口等网络元数据，不包含密钥、用户内容或媒体。
2. 用户确认后打开系统保存对话框。
3. 输出带 `schemaVersion` 和时间戳文件名的单个 JSON 文件。
4. 成功返回保存路径；用户取消是正常状态，不创建 error incident。

## 8. Privacy and Redaction

在 producer、persist、export 三个边界校验/脱敏：

- 永不记录 secret、credential、Authorization、媒体字节、便签/TTS 正文或完整 SDP。
- IP、端口和 related address 只有 WebRTC 专项诊断需要，按用户决定保留精确值，标记为网络元数据并只进入本地日志和用户主动导出的诊断包。
- device ID 使用诊断期哈希引用；room 只用服务端已有的哈希短引用。
- payload 有深度、字符串、数组和单条字节上限。

## 9. Retention

MVP 固定边界：

- client JSONL：单文件 2 MB，当前文件加 3 个历史代，理论上限约 8 MB。
- client incident：最近 10 个，每个最多 200 条 breadcrumbs；单条 renderer payload 序列化前最多 32 KB。
- crash metadata/artifact 索引：最近 5 个；大型二进制不嵌入 JSON 导出包。
- server PM2 stdout/stderr：单文件 20 MB、保留 7 代并压缩。

测试需覆盖阈值轮转、超长 payload 裁剪和 incident 淘汰。

## 10. Compatibility and Rollback

- 现有导出 JSON 增加 `schemaVersion`，保持旧入口可用。
- 诊断模块没有网络客户端或上传 endpoint；server 也不接收 incident。
- 旧客户端不发送结构化事件时 server 仍正常工作。
- 诊断不能成为 join 或通话的硬依赖。
- server logger、client incident manager 和 WebRTC 事件接入均可独立回滚，不迁移业务数据。
