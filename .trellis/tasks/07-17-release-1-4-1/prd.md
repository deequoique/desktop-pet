# 发布 1.4.1 正式版

## Goal

把已经通过 Beta 验证、并补齐首次配置引导与快捷互动修复的当前 master 发布为 `v1.4.1` 稳定版，生成 Windows、macOS 与 Linux server 正式资产。

## Requirements

- R1：`pet/package.json` 与 `pet/package-lock.json` 版本统一为 `1.4.1`，tag 为 `v1.4.1`。
- R2：发布说明面向普通用户，重点说明设置首页/首次配对、身份可修改、真实快捷动作和按钮反馈，并保留多设备、个人音频、缩放诊断等 Beta 能力。
- R3：正式版继续允许发现后续 prerelease；`allowPrerelease` 配置及回归测试必须进入 tag。
- R4：发布前 server/pet 测试、web/pet 构建和本机 Electron 未安装目录包全部通过；版本修改后至少复跑 pet 测试与生产构建。
- R5：发布提交推送到 `master` 后创建 annotated tag `v1.4.1` 并推送，由现有 GitHub Actions 构建 Windows NSIS、macOS x64/arm64 与 Linux server 包。
- R6：监控工作流直到全部成功，确认 GitHub Release 是非 Pre-release 的正式发布，且所需资产完整；失败时不得宣称完成。
- R7：服务端与客户端继续使用 v2 协议；从 `v1.4.0-beta.1` 或更旧版本升级时，应提示服务器与双方客户端一起升级。

## Acceptance Criteria

- [x] AC1：版本文件、发布文档和 release notes 均标记 `1.4.1` / `v1.4.1`。
- [x] AC2：所有发布质量门通过，工作区在创建 tag 前无未提交发布内容。
- [ ] AC3：`master` 和 annotated tag `v1.4.1` 已推送到 origin。
- [ ] AC4：GitHub Actions Windows、macOS、Linux server 三段成功完成。
- [ ] AC5：GitHub Release `v1.4.1` 为正式发布，Windows、两种 Mac 架构和 Linux server 资产均可见。
- [ ] AC6：最终发布说明已写入 Release 页面，下载文件名与实际资产一致。

## Constraints

- 不修改现有 GitHub Actions 发布架构或签名策略；macOS 仍为未签名包。
- 不在发布任务中新增产品功能。
- tag 推送属于正式对外发布边界；推送后持续监控，不中途停止。
