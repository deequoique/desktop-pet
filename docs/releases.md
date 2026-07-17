# 发布与打包

正式发布由 `v*` tag 触发 GitHub Actions。流程构建 Windows NSIS、macOS x64/arm64 包，以及带生产依赖的 Linux server 压缩包。`PET_SERVER_URL` 从 GitHub Secret 生成客户端生产配置，房间密钥、ElevenLabs Key 和 DashScope Key 不进入安装包。

## v1.4.1

这是 1.4 系列的首个正式版本，包含 Beta 阶段验证过的双成员多设备、个人音频库、新控制面板、通话、桌宠缩放和诊断能力，并补充以下体验改进：

- 控制面板每次启动默认打开设置；首次配置先验证服务器与密钥，再选择真实成员身份。
- 已连接用户可以更改当前身份；设备记录随身份迁移，个人音频仍归原成员。
- 快捷互动只显示桌宠真实支持的“开心、跳跃、委屈、等待”，动作文字与动画一致。
- 快捷互动按钮增加按压反馈，不再把第一个按钮永久显示为黑色选中态。
- 正式版显式允许检查后续 prerelease，便于愿意尝鲜的安装继续接收 Beta。

从 `v1.4.0-beta.1` 或更早版本升级时，必须同时升级服务器与双方所有客户端。

## v1.4.1-beta.1

这是一次不兼容的 Beta 升级，服务端和所有客户端必须同时更新。

- 房间升级为双成员、多设备模型，分别显示每台设备的桌宠端和控制端在线状态，并支持单选或多选对方在线设备。
- 双方均可修改两个成员名称；身份选择会使用已同步的自定义名称。
- 新增成员私有音频库，支持录制、导入、重命名、删除和发送，成员之间不可查看彼此的音频。
- 重做 Electron 控制面板的控制、发送、通话和设置界面。
- 新增桌宠缩放持久化与诊断日志导出；默认尺寸和各比例档位缩小为此前的一半。
- 改进 macOS 未签名安装包的打开说明。

本地验证命令：

```bash
npm run build:web
npm run build:pet
npm run pack --prefix pet
```

发布前再更新 `pet/package.json` 版本、提交、创建 tag；功能开发阶段不要提前创建 Release。

## 未签名 macOS 应用

当前 macOS 包未接入 Apple Developer 签名和 notarization。下载 DMG、把 `Desktop Pet.app` 拖入“应用程序”后，如果系统提示“无法验证开发者”或“应用已损坏”，可以在 Terminal 中完整执行：

```bash
APP="/Applications/Desktop Pet.app"

if [ ! -d "$APP" ]; then
  echo "没有找到 $APP；请先把 Desktop Pet.app 拖入应用程序文件夹。" >&2
  exit 1
fi

xattr -dr com.apple.quarantine "$APP" || exit 1
open "$APP"
```

这段命令只移除该应用自身的下载隔离属性，不会关闭系统 Gatekeeper。只对从本项目 GitHub Release 下载且确认来源可信的包执行；不要使用 `spctl --master-disable` 等全局关闭安全检查的命令。

也可以不使用 Terminal：在 Finder 中按住 Control 点击应用并选择“打开”，或首次拦截后前往“系统设置 → 隐私与安全性”选择“仍要打开”。Apple 签名和 notarization 暂不在当前路线内。

## 自动更新

Electron 使用 GitHub Releases 检查更新。私有 Release 不应把 GitHub token 打进客户端；更适合公开发布资产或后续迁移到自有 generic 更新源。
