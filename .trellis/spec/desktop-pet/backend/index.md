# 后端开发规范

适用于 `server/`，以及面向 server 的配置或部署文档。

## 开发前检查清单

- 阅读[服务端与通信模式](./server-and-communication.md)。
- 修改任何 Socket.IO payload 时，同时阅读共享架构索引，并追踪对应的 web 和 pet handler。
- 添加状态前，先判断它属于房间、参与者、socket、目标 pet，还是整个进程。

## 质量检查

- 在事件边界检查角色、房间成员身份、目标归属以及过期的 call/job 标识符。
- 可预期失败使用 acknowledgement 错误码返回，不要从 socket handler 向外抛出。
- 确认断线清理覆盖受影响的 timer、call、TTS queue/job 和 socket 级凭据。
- 运行 `npm test --prefix server`。

## 规范索引

- [服务端与通信模式](./server-and-communication.md)：目录结构、内存状态、校验、错误、日志和测试约定。
