# Technical Design

## Overview

在现有双成员、多设备模型上新增成员级持久便签。控制面板通过既有 controller Socket 创建、查询和收藏便签；桌宠 renderer 保持每台设备唯一的 pet Socket，负责同步收件状态并管理桌面卡片。卡片与便签堆复用现有 `window.open('about:blank', frameName)` + Electron `setWindowOpenHandler` 模式，不建立额外 Socket，也不引入新路由、状态库、数据库或共享 schema package。

本任务不拆子任务：持久化模型、Socket 契约、Electron 多窗口和两个 UI 都依赖同一组状态转换、附件引用与配额；拆开会产生不可验收的中间协议。

## Runtime Ownership

| 状态 / 资源 | 权威与所有者 |
| --- | --- |
| 便签内容、成员级 new/review/favorite、配额、历史期限 | `server/src/persistent-store.js` |
| 在线成员/设备路由与 Socket 事件 | `server/src/index.js` |
| 编辑器、发件/回执/收藏列表 | `web/src/App.tsx` |
| controller Socket 契约与 Blob 获取 | `web/src/api.ts` |
| 收件快照、卡片 DOM、桌宠信封/动作、卡片操作 | `pet/src/renderer/main.ts` |
| 卡片/便签堆 BrowserWindow、bounds、游戏模式隐藏恢复、外链打开 | `pet/src/main/index.js` |
| Electron 能力边界 | `pet/src/main/preload.js` 与窄 IPC |
| 卡片 bounds、展开/收堆、本机高对比度 | Electron `pet-state.json` |

成员级状态由 server 决定；renderer 只镜像 acknowledgement 或 `note:changed` 后的快照。桌面布局只由 Electron main 持久化，不上传 server。

## Persistent Model and Migration

`PersistentStore` 显式把 registry 从 v1 迁移到 v2，保留既有房间、成员、设备与个人音频，给每个 room 增加 `notes`。不得沿用当前“版本不等即回退空数据”的行为。

```ts
type NoteRecord = {
  id: string;
  revision: number;
  senderMemberId: 'a' | 'b';
  recipientMemberId: 'a' | 'b';
  body: string;
  paperColor: 'yellow' | 'pink' | 'blue' | 'sage' | 'lavender';
  media:
    | null
    | { kind: 'image'; attachmentId: string }
    | { kind: 'song' | 'video'; url: string; source: string; title?: string; thumbnailUrl?: string };
  createdAt: string;
  noticedAt?: string;
  review?: {
    reviewedAt: string;
    body?: string;
    imageAttachmentId?: string;
  };
  favorites: Partial<Record<'a' | 'b', { favoritedAt: string }>>;
};

type NoteAttachment = {
  id: string;
  mime: 'image/jpeg' | 'image/png';
  extension: 'jpg' | 'png';
  size: number;
  width: number;
  height: number;
  createdAt: string;
};
```

- 附件文件放在 `PET_DATA_DIR/notes/<roomHash>/<attachmentId>.<ext>`；metadata 由引用它的 note 保存。
- 收藏只增加成员引用，不复制文件。房间“唯一图片”按 attachment ID 计数。
- 先写临时附件并原子 rename，再保存 registry；registry 保存失败则回滚新文件。
- 清理时先原子保存删除后的 registry，再删除无引用文件；启动时清理 orphan 临时文件和无 metadata 引用的附件。
- `prune()` 在启动及固定间隔运行。已批阅 30 天后，成员只能通过自己的 favorite 继续看到记录；底层 record 在任一收藏存在时保留，最后收藏取消后再删除。
- sender 在批阅前收藏时仍引用同一 record；review 写入后 revision 增加，因此发送方收藏会同步得到终态回执。

## Validation and Quotas

默认环境配置：

```text
NOTE_IMAGE_MAX_BYTES=2097152
NOTE_PENDING_MAX=500
NOTE_PENDING_IMAGE_MAX_BYTES=524288000
NOTE_FAVORITE_MAX=500
NOTE_FAVORITE_IMAGE_MAX_BYTES=524288000
NOTE_ROOM_IMAGE_MAX_BYTES=2147483648
NOTE_HISTORY_TTL_DAYS=30
```

- 所有配置解析为有限、非负整数并设置合理上界；非法值回退默认值。
- 正文/回复使用 `Intl.Segmenter` 的 grapheme 语义；运行时不可用时使用一致的 code-point fallback。客户端提示不是安全边界，server 再校验。
- 图片只接受 JPEG/PNG；检查 MIME、magic bytes、尺寸 header、最大边和总像素，拒绝 SVG、动图、音频、视频和伪装 payload。客户端使用 Canvas 限制尺寸并压缩到上限内。
- 创建图片便签依次检查单图、接收方 pending 数量、pending 图片总量和 room 唯一图片总量。
- 图片回复原子检查 room 总量；失败不写附件、不改变 review。无图 review 在 room 图片满额时仍可成功。
- 收藏检查成员收藏数及其唯一图片引用总量；重复收藏幂等，不重复计数。
- URL 必须是无用户名/密码的绝对 `http:`/`https:` URL，长度受限。MVP 不抓取任意网页：已知 provider 可用纯 URL 解析生成安全预览，其他链接只保存 source hostname + URL，避免 SSRF。远程 thumbnail 只允许受信 provider host；其余不自动加载图片。

## Socket.IO Contracts

### Requests

```ts
note:create(payload, ack)
note:list({ view: 'inbox' | 'sent' | 'history' | 'favorites', cursor?, limit? }, ack)
note:mark-noticed({ noteId }, ack)
note:review({ noteId, reply?: { body?: string; image?: BinaryImage } }, ack)
note:set-favorite({ noteId, favorite: boolean }, ack)
note:get-attachment({ noteId, attachmentId }, ack)
```

- `note:create` 只允许已 join 的 controller；目标永远从发送者 member 推导为另一 member，不接受 target socket/device/member。
- `note:mark-noticed` 和 `note:review` 只允许 recipient member；review 是 compare-and-set，第二台设备并发提交得到 `note_already_reviewed` 与最新 snapshot。
- `note:set-favorite` 允许 sender/recipient 的已 join endpoint，但只能操作自己仍可见的记录。
- `note:list` 按 endpoint member 过滤并分页。pet 初始只拉 pending inbox；controller 拉 sent/history/favorites。
- `note:get-attachment` 先验证请求 member 当前是否能通过 pending、30 天历史或自己的 favorite 看到该 note，再返回最多 2 MB binary；越权和不存在统一为 `note_not_found`。

### Events

```ts
note:changed({ reason, note })
note:removed({ noteId, reason })
```

server helper 向受影响成员的所有在线 pet/controller endpoint 发送，不广播整个 room。payload 带 `revision`；客户端忽略旧 revision。重连后始终以 `note:list` 权威快照修复漏事件。

稳定错误码至少包括：

- `not_joined`, `wrong_role`, `invalid_note`, `invalid_image`, `invalid_link`
- `note_not_found`, `note_already_reviewed`, `note_storage_failed`
- `note_inbox_full`, `note_pending_image_limit`, `note_room_image_limit`
- `favorite_limit_reached`, `favorite_image_limit`

可预期失败只通过 acknowledgement 返回，不从 handler 抛出，不记录正文、链接 query 或二进制。

## Electron Window Architecture

### Card and stack windows

- pet renderer 是唯一 pet Socket owner。每张展开便签调用 `window.open('about:blank', 'note-card:<uuid>', features)`；便签堆使用固定 `note-stack`。
- `petWin.webContents.setWindowOpenHandler` 只允许 `about:blank` 且 frame name 精确匹配 `note-card:<validated uuid>` 或 `note-stack`。其他请求拒绝。
- override options：`frame:false`, `transparent:true`, `alwaysOnTop:true`, `resizable:true`, `skipTaskbar:true`, `contextIsolation:true`, `nodeIntegration:false`, `show:false`。卡片设置最小 bounds，加载完成后 `showInactive()`，不抢输入焦点。
- renderer 使用 DOM API 与 `textContent` 创建卡片，不插入服务器 HTML。子窗口事件调用 opener 中的受控 action helper；不创建 Socket。
- main 监听 move/resize/closed，把实际 bounds 和 collapsed 状态写入 `pet-state.json.noteLayouts[device-local noteId]`。已批阅/过期记录清除 stale layout。
- 外链通过 `pet.openExternal(url)` 窄 bridge 交给 main，main 再校验 http/https 后 `shell.openExternal`；卡片禁止自身导航和任意新窗口。
- parent renderer reload、被替换或退出时关闭全部 card/stack child，清除 handler/timer/Blob URL；重连后从 snapshot 重建。

### Placement

- main 根据 pet window 当前 display/workArea 与实际 card size 计算初始位置。
- 从不遮挡 pet/信封的候选方向开始，每张约 24 DIP 阶梯偏移；碰边换向并 clamp。
- 已保存合法 bounds 优先恢复；显示器移除或 DPI 改变时 clamp 回可见 workArea。
- 不设业务展开数量上限，但只为实际展开的 note 创建窗口；收堆即关闭 card window，避免后台窗口占资源。

### Game mode

- 进入 game mode 时暂时隐藏当时已展开的卡片并记录集合，保持全部鼠标穿透。
- 游戏模式收到的新件只更新 stack/badge，不创建 card。
- 退出时只恢复进入前已展开的卡片；游戏期间新增便签仍留在 stack，避免批量弹出。

## Pet Renderer and Visual Direction

- 在现有透明 pet footprint 底部放置信封按钮，不改变成员配对或 Socket 身份。点击命中必须纳入现有 `setClickable` 逻辑；game mode 继续无条件穿透。
- 信封显示 `newCount` 与 `pendingCount`，标签与屏幕阅读器文本明确区分“新”与“待批阅”。
- 新件触发既有 `waiting`/短暂动作能力；不新增动作 ID 或素材依赖。reduced-motion 下只更新角标。
- 视觉签名是“桌宠送信员”：信封与纸张采用轻微物理纸边/折角，不增加多余装饰；五种纸色使用 PRD 固定 token，高对比度覆盖仅本机。
- 卡片工具只保留：收藏、收进便签堆、批阅。回复 composer 在卡片内按需展开，避免常驻控件拥挤。

## Control Panel

- 在现有 `App.tsx` view union 中增加 notes view，不引入 router/store/form library。
- 页面含 compose、sent/history、favorites 三个局部区块；复用 `web/src/api.ts` singleton 和现有 error/toast 模式。
- compose 支持正文计数、纸色选择、单一媒体模式切换、图片预览/压缩、链接种类与 URL。
- sent list 展示 pending/reviewed/time/reply；favorites 按当前成员私有状态展示。
- Socket `note:changed/removed` 更新局部 React state；断线重连后重新分页拉取，不以事件流代替权威 list。
- 独立浏览器只保留安全降级，不承诺桌面卡片、主进程压缩或外链 bridge；Electron 内置 controller 是验收目标。

## Concurrency, Cleanup, and Privacy

- noticed、favorite 是幂等转换；review 只能从 unreviewed 到 reviewed 一次。
- 每次 mutation 在 store 中校验当前 revision/状态与配额后再落盘；成功保存后才 emit/ack。
- 附件 Blob URL 在 note 更新、窗口关闭、列表卸载和 disconnect 时 revoke。
- 不记录正文、回复、完整 URL、图片 bytes、room secret 或收藏内容。日志只含 subsystem、note ID 短前缀、受控错误码和 byte counts。
- 设备身份迁移不改变成员历史归属；迁移后的设备按新 member 权限重新 list，旧本地 layout 不能赋予内容访问权。

## Compatibility and Rollback

- server 与两个客户端契约需同版本发布；旧客户端忽略未知事件但无法使用便签。失败不影响既有命令、TTS、通话与个人音频。
- v1 registry 必须原地迁移并保留现有数据；迁移失败保留原文件并拒绝启动 notes 写入，不能静默清空 registry。
- card/stack window 创建失败时收件状态仍保留，用户可从控制面板查看；不得导致 pet renderer 或 Socket 断开。
- 可通过 UI feature flag 暂时隐藏便签入口，但不得删除持久 note 数据；回滚 Electron UI 不要求回滚 store v2。
