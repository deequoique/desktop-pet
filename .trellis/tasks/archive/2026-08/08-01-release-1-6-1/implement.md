# 执行计划：1.6.1 稳定版

1. 执行 `git merge --no-commit --no-ff origin/codex/call-video-reliability`。
2. 按设计解决四类已知冲突，并检查不存在冲突标记。
3. 将 pet 版本从 `1.6.1-beta.4` 提升到 `1.6.1`，新增稳定版发布说明。
4. 验证双分支关键提交、tag 历史、workflow 和最终运行时清理逻辑均被保留。
5. 运行：
   - `npm test --prefix server`
   - `npm test --prefix pet`
   - `npm run build:web`
   - `npm run build:pet`
   - `npm run pack --prefix pet`
6. 运行 Trellis 质量检查并更新验收项；release 不引入新的长期代码契约时不额外修改 spec。
7. 展示最终 commit 计划，确认后创建 `chore(release): prepare v1.6.1` merge commit。
8. 归档 Trellis 任务并记录会话；不创建 tag、不 push。
