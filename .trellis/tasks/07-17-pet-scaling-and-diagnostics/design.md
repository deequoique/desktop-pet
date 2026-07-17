# 技术设计：桌宠缩放与诊断日志

## 1. 单一缩放真相源

Electron main process 继续拥有窗口尺寸和持久化状态。新增统一的 `applyPetScale(rawScale, source)`：

- clamp 到 0.3–1.5，读取变更前 bounds 与匹配 display。
- 以 360×480 的 DIP 基准计算目标 bounds，底部中心锚定并钳制到当前 display workArea。
- 调用 `setBounds` 后读取实际 bounds，保存实际 scale/位置。
- 记录 source、请求值、钳制值、前后 bounds、display id/scaleFactor。
- 向 pet renderer 与 control window 广播 `pet:scale-changed`，避免各自维护不同 currentScale。

桌宠浮层 +/- 和控制面板 slider 都通过 preload invoke 同一个 main handler。控制面板仅在 Electron bridge 存在时显示桌宠尺寸区；独立浏览器不显示 OS 窗口控制。恢复默认大小调用同一 helper 传入 1，并把窗口钳制回可见工作区。

## 2. 诊断日志

不引入遥测或网络上传。Electron main 使用小型结构化 JSONL logger 写到 `userData/logs/`，达到固定大小后轮转，保留有限历史。

记录：

- 启动时间、应用版本、平台/架构、OS release、Electron/Chrome/Node 版本。
- `screen.getAllDisplays()` 的 id、bounds、workArea、scaleFactor、rotation。
- pet-state 中非敏感的 scale/x/y/gameMode。
- createWindow 初始 bounds、每次缩放请求/实际结果、move/resize、`display-metrics-changed`。
- renderer crash/unresponsive、`uncaughtExceptionMonitor` 和 unhandled rejection 的受控错误摘要。

不记录 room secret、server credential、TTS/API key、Socket.IO payload、音频内容或完整个人音频 metadata。所有写入和导出再经过字段名/字符串模式双层 redaction。

日志写入失败只降级为 console warning，不影响桌宠启动或缩放。

## 3. 导出诊断包

托盘与控制面板调用同一 `exportDiagnostics` handler：

1. 现场采集应用/OS/display/window/pet-state 的脱敏 snapshot。
2. 读取当前和轮转日志，再次 redaction。
3. 通过 `dialog.showSaveDialog` 让用户保存一个 UTF-8 JSON 诊断文件。
4. 返回 `{ ok, canceled, path? }`；取消不是错误。

不导出 pairing secret、凭据文件、音频文件或任意 userData 目录副本。控制面板只显示成功/取消/失败提示，不获得日志原文。

## 4. Win10 定位策略

当前证据不足以确认 DPI 根因，因此本子任务不引入硬件/DPI 猜测式比例补偿。Electron BrowserWindow bounds 使用 DIP；日志同时记录 display scaleFactor，便于判断窗口移动或系统显示指标变化是否与视觉放大同步。

可靠控制入口和默认大小恢复先解决“无法缩小”的可用性问题。收到故障机导出后，根据 `scale request → actual bounds → display scaleFactor` 链路判断是：

- UI 命中/IPC 未发生；
- 保存 scale 异常；
- Windows 返回 bounds 异常；
- display/DPI 变化造成视觉尺寸变化。

若后续确认特定根因，再创建定向修复，不把未知问题宣称为已根治。

## 5. 验证

- 抽出可测试的 clamp/redaction/diagnostic snapshot helper，使用 Node 测试覆盖敏感字段和边界值。
- pet TypeScript/build 验证 preload 契约同步。
- 手工验证浮层与控制面板互相同步、重启持久化、reset 可见、取消/完成导出。
