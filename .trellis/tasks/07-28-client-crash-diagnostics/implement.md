# 客户端错误与崩溃诊断实施

1. 读取父任务和 frontend/shared specs，冻结类型与 UI 映射。
2. 扩展 diagnostics 模块并补齐纯单元测试。
3. 接入 main 的 runtime session、clean marker、window/process/crash hooks。
4. 增加两个 preload 的受限写入 API 与 sender 校验。
5. 接入 pet renderer global handlers；为 React control root 增加 ErrorBoundary/global handlers。
6. 把 Socket、配对、TTS、媒体、更新等关键 catch 映射为稳定错误码。
7. 升级本机留存、用户主动导出的 bundle、统一导出 handler 与设置页 incident banner；验证取消/成功/失败、网络元数据提示、crash 重启不弹窗、不强制打开控制面板，并确认不存在上传网络路径。
8. 验证轮转、重复合并、非法 IPC、诊断目录不可写、renderer crash 和重启恢复。
9. 运行 pet tests、web build、pet build 和打包 Electron 手工测试。

风险点：main-process fatal 与 native crash 不能依赖异步 flush；renderer console 拦截不能作为核心方案，也不能无差别保存高频渲染日志。
