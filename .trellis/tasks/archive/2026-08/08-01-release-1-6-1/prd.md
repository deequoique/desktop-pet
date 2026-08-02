# 发布 1.6.1 正式版

## 目标

把 `v1.6.1-beta.1` 至 `v1.6.1-beta.4` 已验证的诊断、通话画质、TURN 选路与服务器持久化改进，连同 `master` 上刚完成的 Windows 桌宠尺寸漂移修复，集成为 `1.6.1` 稳定版，完成 release 提交并正式发布到 GitHub。

## 背景

- `master` 当前基于 `v1.6.0`，包含提交 `4919c82` 的 Windows 125% DPI 拖拽尺寸修复。
- `origin/codex/call-video-reliability` 基于同一个 `v1.6.0`，包含 `v1.6.1-beta.1` 至 `v1.6.1-beta.4` 的完整线性历史，但尚未合并进 `master`。
- Beta 分支当前版本为 `1.6.1-beta.4`；稳定版目标版本应为 `1.6.1`。
- `v*` tag 推送会触发 GitHub Actions 并对外生成 Windows、macOS 和 Linux server Release 资产。
- 用户在本地质量门通过后明确扩大范围，授权推送 `master`、创建并推送 `v1.6.1` tag，以及发布 GitHub Release。

## 需求

- R1：把 `origin/codex/call-video-reliability` 完整合并进当前 `master`，保留 Beta tag 历史以及 `master` 上的 Windows 尺寸修复。
- R2：解决 Electron main、frontend code-spec 和 Trellis journal/index 冲突，不丢失任一分支的代码契约或会话记录。
- R3：`pet/package.json` 与 `pet/package-lock.json` 的应用版本统一为 `1.6.1`。
- R4：`docs/releases.md` 新增面向用户的 `v1.6.1` 稳定版说明，汇总 Beta 诊断、P2P/TURN 画质、摄像头选路、服务器数据持久化、Windows 安装依赖与桌宠尺寸修复，并明确服务器和双方客户端应同步升级。
- R5：保留 Beta 分支对 `.github/workflows/pet-release.yml` 的 Windows npm cache 隔离和 Linux server bundle 补全。
- R6：发布前通过 server/pet 测试、web/pet 构建及 Electron 未安装目录打包；版本修改后复跑关键质量门。
- R7：完成稳定版 release merge commit。
- R8：在用户明确授权后推送 `master` 与 `v1.6.1` tag，等待 Windows、macOS、Linux server 发布资产全部构建成功，并把 Release 发布为正式最新版。

## 验收标准

- [x] AC1：`git merge-base --is-ancestor origin/codex/call-video-reliability master` 与 `git merge-base --is-ancestor 4919c82 master` 均成功。
- [x] AC2：应用和 lockfile 版本均为 `1.6.1`，发布说明存在 `v1.6.1` 稳定版章节。
- [x] AC3：Windows 拖拽使用冻结 bounds，Beta 诊断会话退出清理也保留在最终 `pet/src/main/index.js`。
- [x] AC4：Trellis journal 同时保留 Beta 分支 Session 14–18 与 Windows 修复记录，编号无冲突。
- [x] AC5：server/pet 测试与 web/pet 构建全部通过；本地未签名目录打包成功，GitHub Windows 完整安装器构建成功（本机标准打包仅受符号链接权限限制）。
- [x] AC6：生成 `chore(release): prepare v1.6.1` merge commit `47b7be7`。
- [x] AC7：`master` 与 `v1.6.1` 已推送；Windows、macOS、Linux server 工作流全部成功，GitHub Release 已发布为正式最新版。

## 范围外

- 在稳定版集成过程中新增产品功能或改变既有 WebRTC 策略。
