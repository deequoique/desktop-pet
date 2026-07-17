# 实施计划：快捷互动 UI 与动作映射

## 1. Sprite 动作重命名

- [x] 将运行时资源目录 `waving`→`joy`、`failed`→`sorrow`，保留每组帧数量与内容。
- [x] 同步 `SpriteState`、帧数、FPS、动作清单和所有内部状态调用。
- [x] 让旧 `waving`/`failed` 命令作为输入别名映射到新动作，pet 对外只声明 `joy`/`sorrow`。
- [x] 确认 Hatch QA 标准行目录不改名。

## 2. 快捷互动渲染

- [x] 删除硬编码六个表情按钮及不再使用的 `ExpressionName` UI import。
- [x] 从远端 `MotionMeta[]` 过滤 `joy/jumping/sorrow/waiting`，只渲染实际声明的动作。
- [x] 给四类动作提供与语义相符的稳定图标；无动作时显示清晰空态。
- [x] 移除首项永久 `primary` 样式与展开/收起状态。

## 3. 按钮反馈

- [x] 增加 hover、active 的颜色/边框/transform 反馈和短 transition。
- [x] 禁用按钮不触发交互样式。
- [x] 在 reduced-motion 下移除位移和过渡，同时保留非运动反馈。

## 4. 验证与收尾

- [x] 运行 `rg` 检查旧运行时 ID/目录引用，只允许兼容别名与 Hatch QA 证据存在。
- [x] `npm run build:web`
- [x] `npm run build:pet`
- [x] 两实例人工验证四个动作、按钮反馈、无永久黑底和禁用状态。
- [x] 复核并保留任务开始前已有的 updater 相关工作区修改。

## 风险点

- `pet/src/renderer/main.ts` 同时包含 sprite 与暂存 VRM 兼容逻辑，修改只限 sprite 状态与远程映射，不恢复 VRMA loader。
- `web/src/*.js` 是 TypeScript 构建生成产物，不能手工编辑。
- 运行时 public 目录与 Hatch QA 目录用途不同，禁止为了名称统一破坏 Hatch 标准行结构。
