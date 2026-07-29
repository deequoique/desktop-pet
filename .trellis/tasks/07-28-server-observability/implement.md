# 服务端结构化日志实施

1. 读取父任务契约与 backend/shared specs。
2. 新建可独立测试的 logger、redaction、exception 和聚合模块。
3. 接入启动、HTTP、Socket join/leave/reject、call、WebRTC signal、TTS、storage。
4. 增加 process/http/socket error hooks 和 graceful fatal 行为。
5. 增加 PM2 配置/文档、轮转和提取步骤。
6. 增加 JSON shape、脱敏、聚合上限和进程异常测试。
7. 运行 `npm test --prefix server`，再与客户端用 `callId` 做手工对齐。

风险点：`server/src/index.js` 是单文件业务核心；logger 接入必须分批，不在同一提交重构业务 handler。
