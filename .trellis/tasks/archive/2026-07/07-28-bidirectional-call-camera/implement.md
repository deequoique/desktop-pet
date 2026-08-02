# 双向通话与双向摄像头实施计划

## Phase 1：修复破坏性生命周期

1. 阅读 web、pet、server 与 shared WebRTC Trellis 规范。
2. 在 `web/src/App.tsx` 分离 listener cleanup 与 call teardown。
3. 用同步 refs 消除 camera 角色 handler 的陈旧 closure。
4. 为主通话/camera 初始化与 signal continuation 增加 `callId` generation guard。
5. 增加窄回归测试，证明角色、设备和 handler 变化不会结束活跃通话。

## Phase 2：升级对称 camera 协议

1. 在 `server/src/index.js` 的 `call:start` 增加 `cameraOffererDeviceId`，过渡期保留旧字段。
2. 将 camera status 改为当前 call 任一 controller 均可发送，server 从 socket 注入 source 并只路由给对端。
3. 从 `webrtc:media-control` 删除 camera 远程控制分支，只保留 screen；旧版 camera control 返回稳定拒绝码且不转发。
4. 扩展 `server/test/rooms.test.js`：
   - 双方 camera signal/status 正确路由；
   - source 不可伪造；
   - 任一方的 camera media-control 均被拒绝且目标 controller 不收到事件；
   - stale call、错误角色、第三设备和其他房间被拒绝；
   - 旧字段兼容。
5. 同步 `web/src/api.ts` 合同；生成的 JavaScript 只通过 build 更新。

## Phase 3：双向 camera runtime

1. 将 camera PeerConnection 改为固定 offerer + 双向 transceiver。
2. 拆分 local desired/status 与 remote status/stream。
3. 让双方各自保存 sender、采集本机 camera 并独立 `replaceTrack`。
4. Camera 按钮只调用本机采集状态转换，不再发送 `requestMediaControl()`。
5. 保留设备枚举、记忆、切换、devicechange 回退与硬件释放。
6. Camera failure/recovery 只影响 camera connection，不结束主通话。
7. 暴露稳定的 camera sender、local desired 和 route profile 切换边界，供 `07-28-turn-low-bandwidth-video` 设置 relay 低清参数。

## Phase 4：双向 UI

1. 双方都显示本地 preview card、设备选择与明确的“我的摄像头”开关。
2. MediaStage camera surface 统一表示对方摄像头，保留隐藏、交换、自动顶替和浮窗。
3. 分开显示本地权限/采集错误与远端关闭/网络错误。
4. 检查键盘操作、按钮 pending 状态和小窗口布局。

## Phase 5：验证

自动验证：

```bash
npm test --prefix server
npm test --prefix pet
npm run build:web
npm run build:pet
```

两个隔离 Electron profile 手工矩阵：

1. A 发起、B 被叫：双方屏幕/音频都可见/可听。
2. A 先开 camera、B 后开；再反序与同时开启，双方均看到对方。
3. 任一方关闭、切换设备、拒绝权限、拔出设备，不影响另一方向和主通话；任一方尝试远程 camera control 都被拒绝。
4. 双方 camera 默认关闭；挂断/断线/窗口销毁后两台机器摄像头指示灯都熄灭。
5. P2P camera 与 camera ICE failure/recovery 正常；TURN 低清画质由兄弟任务的集成矩阵验收。
6. 浮窗只显示远端屏幕/远端 camera，本地 preview 留在控制面板。

## Dependencies and Review Gate

- 本任务必须在 `.trellis/tasks/07-28-diagnose-ipv4-webrtc-p2p/` 的 Phase 5 双端人工实验前完成。
- 已确认双方只能控制自己的摄像头。
- `.trellis/tasks/07-28-turn-low-bandwidth-video/` 的 camera 部分依赖本任务先提供双向 sender；依赖必须按这个顺序实施。
- 规划获批前不修改代码。

## Rollback

- Camera 双向协议可整体回退，主屏幕/音频连接不动。
- 若新协议协商失败，关闭 camera path 并显示升级/不可用提示，不结束主通话。
- 不修改 ICE server、主通话协商方向或 TURN 策略，除非规划阶段另行批准。
