# 代码复用思考指南

> **目的**：新增代码前先确认仓库中是否已有可复用模式，同时尊重当前各运行时的边界。

## 先搜索

```bash
# 搜索函数、事件、字段或常量
rg "functionName|event:name|payloadField|CONSTANT" server web pet

# 查找相关源码文件
rg --files server/src web/src pet/src
```

搜索后回答：

| 问题 | 处理方式 |
| --- | --- |
| 同一层已经有相似 helper？ | 复用或扩展现有 helper |
| 同一状态转换散落在多个分支？ | 放回现有 dispatcher、`switch` 或集中 cleanup 函数 |
| 第三处出现完全相同的局部逻辑？ | 在该层已有结构内提取 helper |
| 跨进程类型在多处重复？ | 先同步所有副本；不要在普通任务中顺带创建共享 package |
| 常量与 asset/manifest 耦合？ | 同时检查代码、manifest 和资源目录 |

## 本项目已有的复用模式

### Web 控制面板

- Socket.IO 连接和 emit wrapper 集中在 `web/src/api.ts`，React UI 不直接重复连接逻辑。
- call cleanup 集中在 `App.tsx` 的 `teardownCall`；新增退出路径应调用它，而不是复制部分清理代码。
- 小型纯展示状态复用现有 `.pill`、`.btn` 等 CSS class 和 stateless component。

### Server

- room、participant、远端目标查询复用 `roomForSocket`、`participantForSocket`、`otherParticipant`。
- peer 状态从 `peerSnapshot` 生成，不在每个事件中手写不同 shape。
- TTS job 完成统一经过 `finishTtsJob`，避免重复删除 job、queue 和 timer。

### Pet renderer

- 远程命令统一经过 `handleRemoteCommand` 的 discriminated `switch`。
- motion load 使用 `motionClipCache`；动画循环内复用模块级 Three.js object 和 math buffer。
- WebRTC 结束统一经过 `cleanupRtc`，TTS 播放结束统一经过 `stopTtsPlayback`。

## 有意保留的契约副本

当前仓库没有共享 schema package。`Command`/`RemoteCommand`、`WebRtcSignal`、pairing shape 和 preload bridge type 会在不同运行时本地定义。这是当前架构事实，不代表普通功能任务可以只改其中一份。

修改契约时：

1. 使用 `rg` 找出全部生产者、中继者和消费者。
2. 同一任务内同步更新每个本地副本。
3. 运行 server 测试和两个 TypeScript 构建。
4. 只有独立架构任务才能决定是否引入共享契约 package。

## 何时不要抽象

- 逻辑只使用一次且非常局部。
- 抽象后的参数和分支比原逻辑更复杂。
- 两段代码属于不同运行时，生命周期或安全边界不同。
- 为一次小改动引入新的 state library、event bus 或 utility package。

## 常量修改检查

修改以下值前必须搜索并核对关联资源：

- motion ID 与 `pet/public/motions/manifest.json`。
- sprite 状态、frame 数与 `pet/public/sprites/`。
- voice 文件前缀与 `pet/public/voices/`。
- Electron IPC channel 与 main、preload、renderer 三端。
- Socket.IO event/error code 与 server、web、pet 三端。

## 提交前检查

- [ ] 已搜索相似函数、事件、字段和常量。
- [ ] 没有复制已有 cleanup、routing 或 state transition 逻辑。
- [ ] 所有本地契约副本已同步。
- [ ] asset 相关常量与 manifest/资源一致。
- [ ] 新增抽象符合当前层结构，没有顺带引入新架构。
- [ ] 对应测试和构建通过。
