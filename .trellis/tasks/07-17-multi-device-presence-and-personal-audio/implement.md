# 执行计划：双用户多设备与个人音频库

## 实施顺序

1. 服务端持久层与数据模型
   - 增加 `PET_DATA_DIR`、版本化 registry、原子保存、30 天设备清理和音频目录 helper。
   - 将 room runtime 重构为 member→device→endpoint，并实现 v2 join/`upgrade_required`。
   - 增加成员 displayName、`room:rename-member`、`room:state` 快照与断连更新；扩展 server 集成测试覆盖改名、多设备和重启恢复。

2. 配对与设备恢复
   - Electron pairing schema 将旧 `participantId` 迁移为 `deviceId`，增加 memberId/deviceName 默认值与 IPC。
   - web 独立浏览器迁移 localStorage；控制面板增加首次身份/设备名设置和离线设备认领流程。
   - 同步 main、两个 preload、web/pet 类型和浏览器 fallback。

3. 单目标控制与媒体路由
   - web API 和 UI 增加 room state、设备列表、targetDeviceId 选择与持久偏好。
   - 在成员标题提供双方均可用的重命名入口，保持 memberId 与 displayName 分离。
   - 修改 command、motion query、TTS 和 RTC 事件携带/校验目标设备。
   - server call state 绑定设备对，只向相关 endpoints 发事件；保持 callId、ICE 暂存和 teardown 不变量。
   - 更新 server 集成测试，断言没有广播、自控、串设备或串房。

4. 个人音频库
   - server 增加上传/list/rename/delete/preview/send 事件、一次性 HTTP job、格式/大小/数量校验和持久文件清理。
   - web 增加 MediaRecorder、文件导入、duration 校验、试听、重命名、删除和发送 UI。
   - pet 增加私有 audio job 播放事件并复用既有音频清理；移除旧 `pet:list-voices` 远程查询链。
   - 测试成员隔离、配额、过期 job、目标离线与服务端重启后列表恢复。

5. 文档、迁移与集成
   - 更新 `.env.example`、部署/架构/故障排查和强制升级说明。
   - 检查生产包配置、Linux release 的可写 `PET_DATA_DIR` 约束。
   - 对父任务进行跨子任务集成检查。

## 验证命令

```bash
npm test --prefix server
npm run build:web
npm run build:pet
```

手工验证至少覆盖：两成员各两设备、设备目标切换、单设备自动选择、目标离线、首次迁移/认领、录音权限拒绝、导入/试听/删除、双向通话只涉及设备对。

## 风险与回滚点

- 房间模型重构后先让 server 测试全绿，再接入 UI；若路由测试失败，不继续音频工作。
- RTC 改为设备对后单独验证 call teardown；异常时回滚该步骤，不保留混合 room-level/device-level call state。
- 音频上传严格在 10 MB 以内，写盘失败必须清理临时文件且不写 metadata。
- 不修改用户现有未提交文档内容；更新文档时逐块合并。
