# 集成设计

父任务以两个子任务的设计为权威技术细节：

- `../archive/2026-07/07-17-multi-device-presence-and-personal-audio/design.md`
- `../archive/2026-07/07-17-pet-scaling-and-diagnostics/design.md`

## 集成边界

- 两个子任务都会修改控制面板与 Electron pairing/bridge 附近代码。实现时先完成缩放/日志子任务的窄 bridge，再在多设备子任务中合并扩展 pairing shape，禁止相互覆盖 preload 或 `Window` 类型。
- 多设备任务新增 server 持久数据目录；诊断导出只能读取 Electron 本机 userData，不读取或打包 server 的设备 registry/音频目录。
- 控制面板设备/音频区域与桌宠设置区域使用不同状态来源：前者来自 room/server，后者来自 Electron main bridge。独立浏览器入口已废弃，只保留为开发调试兼容层，不属于发布或手工验收范围。
- 成员显示名称属于 room/server 持久状态，双方可编辑；memberId a/b 始终是不可变的路由键。
- 发布为不兼容协议版本，最终集成只支持新版 server + 新版客户端组合。

## 推荐顺序

1. 先完成缩放/诊断子任务，建立可靠日志与 bridge 结构。
2. 再完成多设备/音频子任务，处理大范围 Socket.IO 和 room state 变更。
3. 最后运行全套 server 测试、web/pet build，并手工检查 Electron 内置控制面板与桌宠窗口的集成行为。

## 回滚

- 两个子任务保持独立提交边界；缩放/日志可在多设备任务失败时单独保留。
- 多设备发布前备份 server `PET_DATA_DIR`；旧 server 不读取新持久数据，但回滚不得删除该目录。
