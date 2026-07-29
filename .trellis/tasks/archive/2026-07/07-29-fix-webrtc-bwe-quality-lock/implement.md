# WebRTC 双维屏幕自适应实施计划

> 用户已明确批准执行；本文件同时作为实施核对清单。

## Phase 1：测试定义

1. 扩展 `pet/test/video-profile.test.cjs`，覆盖独立的 quality/fps state。
2. 固化用户确认后的七级内部状态表：
   - 480p30→720p30→720p45；
   - 1080p45→1080p60；
   - 2K60→2K90。
3. 固化反向逐级回退与严重拥塞直接回到480p30。
4. 覆盖TURN固定5fps、camera原帧率不变和90fps/2K边界。
5. 覆盖AOB低估自锁复现、健康恢复试探和真实严重拥塞。

## Phase 2：双维纯控制器

修改并保持镜像：

- `web/src/video-profile.ts`
- `pet/src/renderer/video-profile.ts`

实施内容：

1. 保留 camera 的现有五档 controller。
2. 新增 screen 专用 state/controller，独立返回 `qualityLevel` 与 `frameRateTarget`。
3. 分离 P2P resolution limits 与 `RELAY_VIDEO_LIMITS`。
4. 计算 resolution/fps 对应的最大码率。
5. AOB仅作软信号；RTT/loss/jitter负责硬降级。
6. 用可解释reason返回每次状态变化。

完成后运行：

```bash
diff -u web/src/video-profile.ts pet/src/renderer/video-profile.ts
```

## Phase 3：Pet screen接入

修改 `pet/src/renderer/main.ts`：

1. screen sender同时应用quality和fps target。
2. P2P设置 `degradationPreference='maintain-framerate'`。
3. TURN继续独立5fps profile。
4. capture fallback请求最高90fps，保留系统不支持时的正常降级。
5. route切换、generation guard、串行`setParameters()`、track ownership和音频链路保持不变。
6. 档位变化诊断增加帧率目标和决策原因。

## Phase 4：Web与生成文件

1. `web/src/App.tsx` 仅同步新增的诊断字段；camera行为不变。
2. 运行构建生成 `web/src/video-profile.js` 与 `web/src/App.js`，禁止手改生成文件。
3. UI继续显示实测接收fps和清晰度档位；90fps不作为保证值展示。

## Phase 5：验证

```bash
npm test --prefix pet
npm run build:web
npm run build:pet
diff -u web/src/video-profile.ts pet/src/renderer/video-profile.ts
git diff --check
```

手工矩阵：

- IPv4 P2P与IPv6 P2P按内部状态表升级，普通台阶约6秒、高成本台阶约12秒；
- 高性能设备与高刷新率屏幕在2K60稳定后尝试2K90；
- 人为限速时按既定顺序回退且音频连续；
- 强制relay始终不超过640×360、5fps、240kbps；
- 静止画面不会因实测fps低而永久阻止清晰度升级；
- 导出诊断能还原每一步fps/quality决定。

## Rollback

- 可回滚screen双维controller为固定P2P profile。
- 不回滚TURN独立硬上限。
- 不恢复`availableOutgoingBitrate`硬容量门。
