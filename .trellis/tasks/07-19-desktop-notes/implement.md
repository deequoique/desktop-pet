# Implementation Plan

## Scope and Ordering

1. 扩展 `server/src/persistent-store.js`：
   - v1→v2 无损 migration；
   - note/attachment CRUD、原子 review、noticed/favorite；
   - 30 天 visibility/prune、orphan cleanup、引用与配额计算；
   - 单图、pending、favorite、room 总量配置与稳定错误。
2. 先扩展 `server/test/persistent-store.test.js`：
   - migration 保留 member/device/audio；
   - restart 恢复、原子失败回滚、并发 review；
   - 30 天清理、收藏保留、最后引用删除；
   - 500/500 MB/2 GB 边界及唯一附件不重复计数。
3. 在 `server/src/index.js` 增加 member endpoint emit helper 与 note Socket handlers：
   - create/list/mark-noticed/review/set-favorite/get-attachment；
   - role、room、member visibility、payload、revision 与配额校验；
   - 成功落盘后向相关成员所有 endpoint 发送 `note:changed/removed`。
4. 扩展 `server/test/rooms.test.js`：
   - 离线持久与重连 list；
   - 成员级多设备广播、不向自己以外房间泄漏；
   - 非法 role/越权 attachment/第二次 review；
   - 满额时图像拒绝但文本、链接和无图 review 可用；
   - failure ack 不产生伪记录或 orphan file。
5. 扩展 `web/src/api.ts` 的 note types、typed wrappers、listener 与错误映射；继续使用现有 Socket singleton。构建生成的 `web/src/api.js` 不手改。
6. 在 `web/src/App.tsx` 与现有 stylesheet 增加控制面板 notes view：
   - compose、grapheme counter、五色纸张、媒体互斥、图片压缩；
   - sent/history/favorites 分页与实时 revision 更新；
   - reviewed receipt、收藏配额/空间/失败提示；
   - 断线、重连和 listener cleanup。
7. 在 `pet/src/main/index.js` 实现 note window manager：
   - allowlist card/stack `about:blank` child；
   - bounds clamp、阶梯 placement、move/resize persistence；
   - always-on-top、showInactive、最小尺寸、display change；
   - game mode hide/restore、native close→收堆、app/reload cleanup；
   - http/https-only `shell.openExternal` IPC。
8. 同步 `pet/src/main/preload.js` 与 `pet/src/renderer/main.ts` bridge 类型：
   - 外链、layout/window lifecycle 所需的最窄接口；
   - 浏览器安全 fallback；
   - listener 返回 cleanup。
9. 在 pet renderer 增加成员级 note store 与 Socket handlers：
   - join 后拉 pending snapshot，revision reconciliation；
   - card/stack DOM、图片 Blob cache、noticed/review/favorite ack；
   - 收堆、单张/全部展开、信封两个计数；
   - waiting 新件状态、reduced-motion、高对比度；
   - game mode 与 click-through 命中协作。
10. 增加 Electron/source 回归测试：
    - window allowlist、安全 webPreferences、始终置顶与 min bounds；
    - frameName/note ID 校验、外链协议拒绝；
    - placement/workArea clamp、状态持久化、游戏模式恢复；
    - preload listener cleanup 与 pet click-through 不回归。
11. 运行构建生成跟踪的 `web/src/*.js`，不得手动编辑生成文件。
12. 做一次完整跨层审查：create→persist→all devices→noticed→review→receipt→favorite→30-day prune，以及 app quit、renderer reload、socket replace、store failure、窗口创建失败和磁盘满。

## Expected Files

- `server/src/persistent-store.js`
- `server/src/index.js`
- `server/test/persistent-store.test.js`
- `server/test/rooms.test.js`
- `web/src/api.ts` 与构建生成的 `web/src/api.js`
- `web/src/App.tsx` 与构建生成的 `web/src/App.js`
- `web/src/control-panel.css`
- `pet/src/main/index.js`
- `pet/src/main/preload.js`
- `pet/src/renderer/index.html`
- `pet/src/renderer/main.ts`
- `pet/test/notes-main.test.cjs`（新增）及必要的现有回归测试
- server/部署配置文档，仅在新增环境变量需要公开时更新

## Automated Validation

```bash
npm test --prefix server
npm test --prefix pet
npm run build:web
npm run build:pet
npm run pack --prefix pet
```

补充静态扫描：

```bash
rg "note:(create|list|mark-noticed|review|set-favorite|get-attachment|changed|removed)" server/src web/src pet/src
rg "NOTE_(IMAGE|PENDING|FAVORITE|ROOM|HISTORY)" server/src docs
```

## Manual Validation Matrix

- 两名成员、每人两台隔离 Electron profile：
  - 对方离线发送，重启 server 与接收设备后恢复；
  - 两台在线设备同时展开，任一设备 noticed/review 后另一台同步；
  - 两台设备布局互不影响，收藏跨设备一致。
- 内容：
  - 纯文字、图片、歌曲链接、视频链接、预览 fallback；
  - 1,000/500 grapheme 边界、emoji、2 MB 前后、伪装 MIME；
  - 外链只由系统浏览器打开，卡片自身不导航。
- 桌面：
  - 多显示器、DPI、移除显示器、桌宠四角位置、阶梯换向；
  - 任意数量展开、resize 下限、收堆/全部展开、不抢焦点；
  - 游戏模式隐藏既有卡片，新件只入堆，退出只恢复旧集合。
- 状态：
  - 打开不批阅、mark noticed 不向发送方暴露；
  - 两设备并发 review 只有一次成功；
  - 图片回复失败仍未批阅，改为文字后成功；
  - sender/recipient 独立收藏和取消。
- 生命周期：
  - 30 天清理与 favorite 保留；
  - 最后引用取消后附件清理；
  - pet/control reload、socket replaced、app quit 无 orphan child、listener、timer 或 Blob URL。
- 配额：
  - pending、favorite 和 room 总量分别命中；
  - room 图片满时文本/链接/无图批阅仍成功；
  - 满额不覆盖、不自动删除、不产生伪成功。

## Risk and Rollback Points

- `PersistentStore` migration 风险最高：先完成 migration/store 单测，保留原 registry，禁止失败时空数据启动。
- 多 BrowserWindow 有资源成本：只为展开卡片创建窗口，收堆立即释放；不以隐藏 500 个窗口实现堆。
- parent renderer 是 card action owner：reload 时关闭 children，重连后以 server snapshot 重建，避免孤儿窗口和重复 Socket。
- 任意外部 link preview fetch 会带来 SSRF；MVP 只用纯 URL 解析/受信 provider，不新增通用网页抓取。
- note 功能失败必须与 call/TTS/audio 隔离。若窗口层不稳定，可隐藏入口并保留 server 数据与控制面板历史。

## Review Gate Before Start

- 确认 PRD、设计和实施计划符合：成员级异步投递、显式批阅、桌宠信封入口、始终置顶可收堆、跨设备收藏、30 天普通历史和三层图片配额。
- 确认 Electron 采用“唯一 pet Socket + 同源受限子窗口”，而不是每张卡片建立 Socket。
- 只有用户复核并明确同意开始实现后，才运行：

```bash
python3 ./.trellis/scripts/task.py start 07-19-desktop-notes
```
