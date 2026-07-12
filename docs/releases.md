# 发布与打包

正式发布由 `v*` tag 触发 GitHub Actions。流程构建 Windows NSIS、macOS x64/arm64 包，以及带生产依赖的 Linux server 压缩包。`PET_SERVER_URL` 从 GitHub Secret 生成客户端生产配置，房间密钥和 ElevenLabs Key 不进入安装包。

本地验证命令：

```bash
npm run build:web
npm run build:pet
npm run pack --prefix pet
```

发布前再更新 `pet/package.json` 版本、提交、创建 tag；功能开发阶段不要提前创建 Release。

## 未签名 macOS 应用

当前 macOS 包未接入 Apple Developer 签名和 notarization。首次打开时可在 Finder 中按住 Control 点击应用并选择“打开”，或在“系统设置 → 隐私与安全性”允许打开。自建测试包也可执行：

```bash
xattr -dr com.apple.quarantine "/Applications/Desktop Pet.app"
```

只对自己确认来源可信的包执行。Apple 签名和 notarization 暂不在当前路线内。

## 自动更新

Electron 使用 GitHub Releases 检查更新。私有 Release 不应把 GitHub token 打进客户端；更适合公开发布资产或后续迁移到自有 generic 更新源。
