# 执行计划：桌宠缩放与诊断日志

## 实施顺序

1. 主进程缩放收口
   - 抽取 clamp、display snapshot、workArea 钳制和 `applyPetScale`。
   - 将现有 `pet:resize`、启动恢复与 reset 统一到该路径，并广播实际 scale。
   - 记录 move/resize/display metrics，避免事件回写循环。

2. Electron bridge 与 UI
   - control preload 增加 get/set/reset scale、scale changed listener 和 export diagnostics。
   - pet preload/renderer 的 +/- 改为 request/reply 并监听权威 scale。
   - 控制面板增加尺寸 slider、百分比、恢复默认和导出日志按钮；浏览器模式隐藏。
   - 托盘增加恢复默认大小和导出诊断日志。

3. 日志与导出
   - 增加有限轮转 JSONL logger、redaction、startup/display/window/error 事件。
   - 实现保存对话框和单文件 JSON 诊断包，覆盖取消与写入失败。
   - 添加不包含 secret/API key/audio 的自动化测试。

4. 验证与文档
   - 构建 pet/web，手工验证尺寸同步、持久化、reset 和导出。
   - 更新 troubleshooting，说明如何从 Win10 故障机导出并提供日志。
   - 后续拿到日志后再决定是否需要 DPI 定向修复。

## 验证命令

```bash
npm run build:web
npm run build:pet
```

若新增独立 Node 测试脚本，同时运行对应 `npm test --prefix pet` 或明确脚本。

## 风险与回滚点

- 缩放 helper 必须先在现有 +/- 路径验证，再接控制面板，避免两个入口同时失效。
- redaction 测试失败时禁止交付导出功能。
- 日志写入/导出必须是非关键路径；异常不能阻止 app ready、窗口创建或退出。
- 不对未复现的 Win10 DPI 行为加入自动比例补偿。
