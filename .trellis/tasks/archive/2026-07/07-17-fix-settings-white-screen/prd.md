# 修复设置页白屏回归

## Goal

避免本地开发时控制面板服务未启动或短暂重启导致 Electron 控制窗口永久白屏，让故障原因可见并能自动恢复。

## Background

- Electron 开发态控制窗口固定加载 `http://localhost:5174`（`pet/src/main/index.js:15,559`）。
- 复现白屏时，服务器端口 3030 和桌宠渲染端口 5173 正常监听，但控制面板端口 5174 没有监听。
- 单独启动 `npm run dev --prefix web` 后，同一份前端代码可以正常渲染；Agent Browser 检查未发现未捕获错误，证明白屏不是本轮 React/CSS 修改造成的运行时回归。
- 当前 `createControlWindow` 未监听 `did-fail-load`，加载失败后没有原因提示或重试机制（`pet/src/main/index.js:544-571`）。

## Requirements

- R1：仅在 Electron 开发态为控制面板加载失败提供恢复界面，明确提示控制面板开发服务（5174）不可用。
- R2：恢复界面应自动重试原控制面板地址；5174 恢复后无需重启 Electron 即可进入正常界面。
- R3：记录控制窗口加载失败的诊断事件与错误码，便于以后导出日志定位。
- R4：不得改变正式安装包加载 `dist/control/index.html` 的路径或行为。
- R5：保留尚未提交的成员名称显示、设置页布局、连接按钮对比度和桌宠尺寸改动。

## Acceptance Criteria

- [ ] AC1：开发态 5174 不可用时，控制窗口不再显示无信息白屏，而是显示可理解的服务未启动提示。
- [ ] AC2：保持 Electron 运行并启动 5174 后，控制窗口能自动恢复到正常 React 页面。
- [ ] AC3：控制面板正常运行时，页面无未捕获控制台错误，身份选项仍使用已知成员名称。
- [ ] AC4：`npm run build:web`、`npm run build:pet` 和相关 Electron 单元测试通过。
- [ ] AC5：正式安装包的控制窗口加载分支不受影响。

## Out of Scope

- 调整服务器 3030 的占用策略。
- 修改控制面板产品功能或视觉设计。
- 重新设计开发命令和进程编排。
