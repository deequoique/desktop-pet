# 思考指南

> **目的**：在写代码前主动检查容易遗漏的复用与跨层问题。

## 为什么需要思考指南

本项目最容易出现的问题不是语法错误，而是：

- 修改了一个事件字段，却漏掉另一个运行时中的契约副本。
- 新增 helper 前没有发现现有实现。
- 修改 asset 相关常量时只改了代码，没有检查 manifest 或资源。
- 创建外部资源后没有在断线、effect cleanup 或窗口退出时释放。

## 可用指南

| 指南 | 用途 | 何时阅读 |
| --- | --- | --- |
| [代码复用思考指南](./code-reuse-thinking-guide.md) | 搜索现有实现，避免同层重复，并同步本地契约副本 | 新增 helper、constant、状态转换或相似 UI 时 |
| [跨层思考指南](./cross-layer-thinking-guide.md) | 追踪 Socket.IO、WebRTC、TTS 和 Electron IPC 数据流 | 功能跨越 `server/`、`web/`、`pet/` 时 |

## 快速触发条件

出现以下任一情况时，阅读对应指南：

- [ ] 修改事件名、payload 字段、错误码或环境变量。
- [ ] 修改 `Command`、`WebRtcSignal`、pairing、TTS status 或 preload bridge。
- [ ] 新增 utility/helper，或看到第三处相似逻辑。
- [ ] 修改 motion ID、sprite frame、bone name、scale 等常量。
- [ ] 新建 timer、listener、socket、stream、track、audio context 或 peer connection。
- [ ] 不确定逻辑应该放在 React UI、socket adapter、server、Electron main 还是 pet renderer。

## 修改前规则

> 修改任何值或契约前，先搜索所有引用。

```bash
rg "<要修改的值或字段>" server web pet docs
```

## 使用方式

1. 开发前阅读与任务相关的指南。
2. 实现中出现重复或跨层不确定性时重新检查。
3. 发现新的长期约束后，把它写入对应项目 spec，而不是只留在任务记录中。

**核心原则**：先追踪和搜索，再修改。
