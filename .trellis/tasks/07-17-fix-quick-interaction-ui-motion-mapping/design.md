# 技术设计：快捷互动 UI 与动作映射

## 边界与数据流

快捷互动继续使用现有链路：pet renderer 通过 `pet:list-motions` 声明 `MotionMeta[]`，server 只做目标设备转发，`web/src/api.ts` 返回动作列表，React 根据远端能力渲染按钮并通过 `pet:command` 发送 `animation` 命令。服务端契约和 payload shape 不变。

## 动作身份与资源迁移

运行时 sprite 状态做以下重命名：

| 旧状态/目录 | 新状态/目录 | UI 标签 |
| --- | --- | --- |
| `waving` | `joy` | 开心 |
| `failed` | `sorrow` | 委屈 |
| `jumping` | 不变 | 跳跃 |
| `waiting` | 不变 | 等待 |

同步修改 `SpriteState`、帧数/FPS 表、`SPRITE_MOTIONS`、资源 URL、内部反应调用和表情兼容映射。`spriteStateForCommand` 仍接受旧的 `waving`/`failed` 及同义词作为输入别名，但返回新状态，避免旧 controller 在滚动升级期间完全失效。新 pet 只向控制面板声明新 ID。

只重命名 `pet/public/sprites/screen-dog/` 下运行时目录。`pet/assets/pets/screen-dog/hatch/qa/rows/` 是 Hatch 标准动作行的生成与 QA 证据，继续保留标准 `waving`/`failed` 命名。

## 控制面板

删除硬编码 `EXPRESSIONS` 六宫格。对远端 `motions` 按允许集合 `joy/jumping/sorrow/waiting` 过滤，保持远端声明顺序，并为每个 ID 提供稳定图标。按钮统一为中性样式，不再给首项静态 `primary`。

按钮使用 CSS `:hover` 与 `:active` 提供即时反馈：按下时轻微下移/缩放，松开后恢复。`prefers-reduced-motion: reduce` 下移除 transform/transition，只保留颜色或边框反馈。发送结果继续由现有 toast 表达，不增加容易与网络 acknowledgement 混淆的持久选中态。

## 兼容性与回滚

- server 无需升级；新旧 controller/pet 可通过旧 ID 输入别名短期兼容。
- 如果资源目录重命名导致帧加载失败，可同时回滚 `SpriteState` 和 public 目录名，不涉及持久数据。
- 若远端没有四个允许动作中的任何一个，快捷互动显示空态，不回退到虚假的硬编码按钮。

## 验证

- `rg` 确认运行时代码与 public 目录不存在遗漏的旧路径引用。
- `npm run build:web`、`npm run build:pet`。
- 两个隔离 Electron 实例分别作为 A/B，逐个点击“开心、跳跃、委屈、等待”，观察远端 sprite 与按钮按压反馈。
