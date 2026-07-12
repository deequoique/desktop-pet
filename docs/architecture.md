# 架构

## 二合一客户端

Electron 启动透明桌宠窗口和一个默认隐藏的控制面板窗口。托盘菜单负责打开或聚焦控制面板；关闭控制面板只会隐藏它。生产包把 Web 构建放在 `dist/control/`，开发时加载 Vite 页面。

每台客户端有一个保存在 Electron `userData` 的稳定 `participantId`，并以 `pet`、`controller` 两个 socket 端点加入同一参与者。独立浏览器只有 controller 端点。

## 双人房间

server 按房间密钥哈希建立内存房间。每个房间最多两个 participant，每人每种端点最多一个 socket；重连会替换自己的旧端点。第三名参与者得到 `room_full`，不会挤掉前两人。两端都离线后有 30 秒重连宽限期。

动作、台词列表和 `pet:command` 都路由给另一个 participant，不能控制自己的桌宠。`room:peers` 返回参与者视角的端点状态。

## 通话与 server 的边界

server 承担房间鉴权、在线状态、命令转发和 WebRTC SDP/ICE 信令。屏幕、麦克风和系统声音由 WebRTC 尽量点对点传输，正常情况下不经过应用 server。server 仍然必要，因为 NAT 下双方通常无法仅凭一个房间密钥发现彼此、协商连接或可靠维护房间状态。

## ElevenLabs 消息

controller 提交最多 200 字的文字和 voice ID。server 校验白名单或当前 BYOK 账号可访问的声音、频率及目标队列，然后给对方 pet 下发一次性流地址。pet 用 `HTMLAudioElement` 渐进播放，并将媒体元素接入 Web Audio analyser 驱动口型。

每个目标 pet 同时最多容纳 3 条任务（含正在播放的一条），按 FIFO 播放；每位参与者默认每分钟 10 次。流 URL 不可猜测、只能使用一次并在 60 秒后过期。音频和文字不落盘、不做长期缓存。

BYOK 密钥在 Electron 中用系统安全存储加密，传到 server 后只挂在当前 controller socket 的内存上，不写入 job、日志或磁盘；浏览器刷新后即丢失。
