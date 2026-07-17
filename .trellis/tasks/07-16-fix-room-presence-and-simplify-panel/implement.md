# 父任务执行与集成计划

1. 启动并完成 `07-17-pet-scaling-and-diagnostics`。
   - 按子任务 PRD/design/implement 实现与检查。
   - 交付控制面板缩放、reset、日志和脱敏导出，不猜测未知 Win10 根因。
2. 启动并完成 `07-17-multi-device-presence-and-personal-audio`。
   - 按子任务 PRD/design/implement 实现 v2 协议、设备状态/路由和个人音频库。
   - 合并而非覆盖第一子任务的 preload、React UI 和文档修改。
3. 父任务集成检查。
   - 对照父 PRD 检查所有跨子任务 acceptance criteria。
   - 运行：

```bash
npm test --prefix server
npm run build:web
npm run build:pet
```

   - 手工验证 Electron 内置控制面板、两成员多设备、设备目标切换、音频管理/播放、缩放同步和诊断导出；独立浏览器已废弃，不纳入验收。
4. 更新必要 spec/架构文档，保护用户已有未提交文档块；提交按子任务保持可审查边界。
