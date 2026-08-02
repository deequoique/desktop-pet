# 客户端错误与崩溃诊断设计

## Dependency Contract

实现前读取父任务 envelope、隐私和保留决策。对 renderer 暴露的 API 只能写本地事件，不能选择文件、读取其他日志、发起上传或伪造可信 source。

## Components

- 扩展 `pet/src/main/diagnostics.js`：envelope、验证、breadcrumbs、incident、retention。
- `pet/src/main/index.js`：可信 runtime metadata、IPC、process/window/crash hooks、导出。
- 两个 preload：窄 `recordDiagnostic` 接口。
- pet renderer 与 control renderer：global handlers、ErrorBoundary 和业务分类。

## Crash Semantics

- renderer JavaScript error：renderer 先上报；若 renderer 整体退出，main 的 `render-process-gone` 是最终权威事件。
- main JavaScript fatal：同步写最小事件；不假设可继续安全运行。
- native crash：依靠 Electron/Chromium 本地 crash artifact；下次启动扫描并创建 incident。
- 强制断电/kill：clean-shutdown marker 只标记 abnormal exit，不伪称 crash stack。

## UI Semantics

UI 使用 errorCode → 中文摘要/动作映射。raw exception 只在诊断包。重复错误合并为一次可更新提示；warn 默认不弹 modal。上次 crash/fatal 只在用户主动打开控制面板后显示持久 banner，不自动打开窗口。

设置页新增独立“诊断与故障”区块。所有入口调用同一个 main-process export handler：设置页按钮、托盘快捷项和 crash banner 不各自拼装文件。handler 显示网络元数据提示与系统保存对话框，生成带时间戳的单个 JSON 诊断包；取消保存是正常用户行为。

## Privacy

renderer payload 先 allowlist/cap，再由 main 做全量脱敏。导出再次处理。diagnostic writer 的错误走独立最小 fallback，避免自引用。
