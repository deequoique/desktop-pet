# 发布 1.4.1 Beta 1

## Goal

将当前已完成并经本机验收的桌宠、多设备、个人音频和控制面板改动发布为 `v1.4.1-beta.1`，生成 Windows、macOS 与 Linux server Beta 资产。

## Requirements

- R1：`pet/package.json` 及锁文件版本统一更新为 `1.4.1-beta.1`。
- R2：发布说明以活泼、非技术用户可理解的语言，分点介绍相对 `v1.4.0-beta.1` 的用户可见变化，并保留现有未签名 macOS 安装说明。
- R3：发布前完整验证 server、web、pet 的测试、类型检查和构建；本机能够生成 Electron 未安装目录包。
- R4：提交当前已确认的未提交改动，但不实现已放弃的白屏恢复方案。
- R5：发布提交推送至 `master` 后创建并推送 annotated tag `v1.4.1-beta.1`，由现有 GitHub Actions 生成 Release 资产。
- R6：等待发布工作流结束，确认 Windows NSIS、macOS x64/arm64 和 Linux server 资产成功上传；失败时不得宣称发版完成。
- R7：自动更新明确允许 prerelease，使正式版安装也能检测并升级到后续 Beta。

## Acceptance Criteria

- [x] AC1：版本文件统一为 `1.4.1-beta.1`；发布阶段将创建对应 `v1.4.1-beta.1` tag。
- [x] AC2：server、web、pet 的自动化测试与构建全部通过。
- [x] AC3：Electron 本机打包与生产包实机烟雾检查通过，控制面板产物包含最新 UI 与身份名称修复。
- [x] AC4：发布提交和 tag 已推送到 `origin`，工作区没有遗漏的待发布源代码改动。
- [x] AC5：GitHub Release 已作为 Pre-release 正式发布，13 个跨平台资产全部生成并可见。
- [x] AC6：正式版与 Beta 安装都允许检测 GitHub prerelease，且有自动化回归测试覆盖该配置。

## Constraints

- 本次为 Beta，不创建稳定版 `v1.4.1` tag。
- 不包含已放弃的开发态白屏恢复功能。
- 不改动 GitHub Actions 的发布架构；若外部 Secret 或 CI 环境阻塞，应报告具体阻塞点。
