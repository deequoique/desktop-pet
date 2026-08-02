# 技术设计：1.6.1 稳定版集成

## 集成边界

使用 `git merge --no-commit --no-ff origin/codex/call-video-reliability` 将完整 Beta 历史合入 `master`。在质量门通过前保持 merge 未提交状态，最终用一个 `chore(release): prepare v1.6.1` merge commit 同时记录稳定版版本与发布文档。

## 冲突处理

- `pet/src/main/index.js`：保留 Beta 的 `completeDiagnosticSession(...)`，同时调用 `stopPetDrag()`，确保诊断会话和拖拽快照均被清理。
- `.trellis/spec/desktop-pet/frontend/frontend-and-electron-patterns.md`：合并 Beta 的诊断契约与本次 Windows 分数 DPI 拖拽契约。
- `.trellis/workspace/deequoique/journal-1.md` 与 `index.md`：以 Beta 的 Session 14–18 为顺序基础，把 Windows 修复的原 Session 14 重编号为 Session 19；后续 release 会话由 Trellis 继续编号。
- 其他文件使用无冲突自动合并结果，不手工重写 Beta 画质、诊断或部署逻辑。

## 版本与发布说明

版本只修改 Electron 应用拥有的 `pet/package.json` 与 lockfile 根包版本。server/web 的 `0.0.1` 是独立私有包版本，不随桌宠 release 改动。

稳定版发布说明新增在 Beta 章节之前，按用户价值汇总经过 Beta 验证的能力，不逐条复制内部实现细节。

## 发布边界

本任务只生成本地 merge/release commit。`v1.6.1` annotated tag 与 `master`/tag push 会触发真实外部发布，必须在后续获得明确确认后执行。

## 回滚

在 merge commit 前可使用 `git merge --abort` 回到干净 `master`；禁止使用 `git reset --hard`。merge commit 后若尚未推送，仍由用户决定是否保留或创建新回滚提交。
