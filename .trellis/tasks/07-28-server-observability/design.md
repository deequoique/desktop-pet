# 服务端结构化日志设计

## Dependency Contract

开始实现前必须从父任务读取 envelope、errorCode、隐私和保留决策。子任务不得增加客户端 incident 上传。

## Components

- `server/src/diagnostics.js`：logger、exception serializer、redaction、sampling/aggregation。
- `server/src/index.js`：只在业务边界发语义事件。
- call diagnostic state：按 `callId` 保存小型计数器，call end 后输出并释放。
- deployment config/docs：PM2 进程和日志轮转。

## Logging Policy

- 正常连接和 call 生命周期为 `info`。
- 可预期的非法输入/过期 call 为 `warn`，攻击者可触发者采样。
- 操作失败为 `error`。
- 即将退出的进程异常为 `fatal`。
- 不逐条打印原始 trickle ICE；只识别 `offer/answer/candidate/end` 并计数。

## Failure Safety

logger 序列化失败时输出一条最小 stderr fallback，不能递归调用自身。fatal 先同步写最小事件，再由 PM2 重启；不把未知状态的进程伪装为健康。
