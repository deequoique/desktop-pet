# Bug Analysis: Windows 点击桌宠后尺寸逐帧变大

## 1. Root Cause Category

- **Category**: E - Implicit Assumption（同时存在 D - Test Coverage Gap）
- **Specific Cause**: 绝对光标拖拽轮询假设 `BrowserWindow.setPosition()` 只改变位置；Windows 125% DPI 下该调用的 DIP/物理像素往返取整会反馈到实际窗口尺寸。轮询每 16ms 无条件调用，使误差逐帧累积。

## 2. Why Fixes Failed

1. 之前的缩放修复统一了 scale 真相源、reset 和诊断导出，但当时没有故障机日志，按任务约束没有猜测 DPI 根因。
2. 既有测试覆盖主动 scale 请求，没有覆盖“只移动窗口时尺寸必须保持不变”的原生窗口契约。

## 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
| --- | --- | --- | --- |
| P0 | Architecture | 拖拽开始冻结实际 bounds；移动时原子设置位置与冻结尺寸 | DONE |
| P0 | Runtime | 光标与目标位置未变化时跳过原生窗口调用 | DONE |
| P0 | Test Coverage | 断言轮询中无 `setPosition`、冻结尺寸被复用、结束路径清理快照 | DONE |
| P1 | Documentation | 将 Windows 分数 DPI 拖拽契约写入 Electron frontend code-spec | DONE |

## 4. Systematic Expansion

- **Similar Issues**: 其他高频 `setPosition` 路径若未来进入计时器或动画循环，也必须显式验证实际 bounds 是否稳定；当前 `pet:drag` 相对位移旧入口不在 renderer 生产路径中。
- **Design Improvement**: Electron main 继续作为窗口 bounds 唯一真相源；renderer 不缓存或推断原生尺寸。
- **Process Improvement**: 窗口位置/DPI 修复必须同时检查位置、尺寸和调用频率，不能只检查 scale IPC。

## 5. Knowledge Capture

- [x] 更新 `.trellis/spec/desktop-pet/frontend/frontend-and-electron-patterns.md`。
- [x] 增加 `pet/test/window-drag-main.test.cjs` 回归测试。
- [x] 项目不存在 `src/templates/markdown/spec/` 模板副本，无需同步。
