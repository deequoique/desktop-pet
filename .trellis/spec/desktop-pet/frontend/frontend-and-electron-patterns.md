# 前端与 Electron 模式

## 运行时边界

项目存在两种不同的前端风格，必须保持边界：

- `web/src/App.tsx` 是 React 控制面板；`web/src/api.ts` 管理 Socket.IO singleton，并把 socket 事件转换为 typed listener 和返回 Promise 的函数。
- `pet/src/renderer/main.ts` 是命令式 Three.js/DOM/Web Audio renderer，使用模块级状态、事件监听、动画 helper 和直接的 Socket.IO handler。
- `pet/src/main/index.js` 负责 BrowserWindow、tray、自动更新、文件持久化、安全存储、桌面采集源、窗口移动和其他 Electron/OS API。
- `pet/src/main/preload.js` 与 `pet/src/main/control-preload.js` 是 renderer 访问 main 能力的唯一 bridge。

renderer 不得直接导入 Electron 或 Node API。普通功能变更不要顺带把命令式 pet renderer 改成 React，也不要顺带重构当前单文件 UI 架构。

## React 控制面板

当前 React 结构刻意保持紧凑：

- UI 与协调后的 call/TTS 状态集中在单个 `App` component。
- `StatusPill`、`PeerPill`、`CallPill` 是无状态的小型展示 component，定义在 `App.tsx` 底部。
- socket 细节留在 `api.ts`；UI handler 调用 `sendCommand`、`requestCall`、`createTts` 等导出 wrapper。
- 有限状态使用字符串 union，如 `Status`、`CallState`、`CandidateType`；跨边界命令使用 discriminated union `Command`。

会参与渲染的值使用 `useState`。不应触发渲染的外部可变资源使用 `useRef`，例如 `RTCPeerConnection`、`MediaStream`、DOM media element、待处理 ICE candidate、call ID 和 timer handle。函数进入 effect dependency 或管理长生命周期资源时使用 `useCallback`。

effect 用于安装外部 listener 或同步外部状态；如果 effect 创建资源，就必须返回 cleanup。`App.tsx` 中的现有例子会清空 API listener、拆除 call、用 flag 取消异步声音加载，并清除 interval。

当前仓库不使用 router、context store、Redux/Zustand、React Query/SWR、form library、component library 或项目自定义 hook。小型局部改动不要引入这些体系。

## Electron bridge 模式

BrowserWindow 保持 `contextIsolation: true` 和 `nodeIntegration: false`。新增 native 能力时必须同时完成：

1. 在 `pet/src/main/index.js` 中使用 `ipcMain.on` 实现单向通知，或使用 `ipcMain.handle` 实现 request/reply。
2. 在对应 preload 中通过 `contextBridge.exposeInMainWorld` 暴露窄接口。
3. 在 `web/src/App.tsx` 或 `pet/src/renderer/main.ts` 中补齐 TypeScript `Window` 声明。
4. 如果同一代码设计为可在 Electron 外运行，补齐浏览器安全 fallback。

cursor、drag 等高频事件式操作使用 `send`；pairing config、scale、声音发现、凭据和桌面 source 等需要结果的操作使用 `invoke`。

Electron 负责持久化 pairing 和加密 BYOK 凭据。独立 web 入口已废弃，不是发布或验收目标；现有浏览器 fallback 仅可作为开发调试兼容层，不应为其新增产品功能或阻塞 Electron 交付。

## Electron 自动更新渠道

产品允许正式版安装发现 GitHub prerelease。`electron-updater` 的 `allowPrerelease` 默认值取决于当前安装版本：正式版默认是 `false`，因此不得依赖该默认值。初始化打包应用的 updater 时必须显式设置：

```js
autoUpdater.allowPrerelease = true;
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
```

这使正式版和 Beta 安装都能检测后续 Beta；开发模式仍由 `app.isPackaged` guard 禁止检查。`pet/test/updater-main.test.cjs` 必须断言 `setupAutoUpdater` 保留该显式配置，发布产物还必须包含对应 prerelease channel 的更新元数据（例如 `beta.yml`）。

## 场景：桌宠窗口缩放与本地诊断导出

### 1. 适用范围与触发条件

修改桌宠窗口大小、位置、显示器/DPI 诊断或本地日志导出时使用本节。窗口 bounds 与 scale 的权威状态必须留在 Electron main；透明 pet renderer 和 React control window 只能经 preload 调用。

### 2. 签名

```js
ipcMain.handle('pet:get-scale', () => number);
ipcMain.handle('pet:set-scale', (_event, scale) => ({ ok, scale?, bounds?, error? }));
ipcMain.handle('pet:reset-scale', () => ({ ok, scale?, bounds?, error? }));
ipcMain.handle('diagnostics:export', () => ({ ok, canceled?, path?, error? }));

webContents.send('pet:scale-changed', actualScale);
```

两个 preload 各自暴露窄封装；`onPetScaleChanged` / `onScaleChanged` 必须返回移除 listener 的 cleanup。

### 3. 契约

- scale 输入转为有限数值并 clamp 到 0.3–1.5；非法值回退到 1。
- 主进程以 180×240 DIP 为基准计算 bounds（旧版 360×480 的一半），底部中心锚定并 clamp 到匹配 display 的 workArea；scale 百分比及其持久值语义保持不变。
- `setBounds` 后读取实际 bounds，以实际宽度重新计算并持久化 scale，再广播给两个 renderer。
- 诊断 JSONL 位于 Electron `userData/logs/`，有限轮转；只在用户调用导出时弹出保存对话框，不自动上传。
- 日志/导出允许包含应用版本、OS/Electron 版本、display bounds/workArea/scaleFactor、窗口 bounds 和非敏感 pet-state；禁止包含 room secret、API key、credential、Socket.IO payload 或音频二进制。

### 4. 校验与错误矩阵

| 条件 | 行为 |
| --- | --- |
| pet window 尚未创建或已销毁 | `{ ok:false, error:'pet_window_unavailable' }` |
| scale 非有限值 | 使用 1，再按正常路径应用与广播 |
| 目标位置超出 workArea | clamp 回当前匹配显示器可见范围 |
| 用户取消保存对话框 | `{ ok:false, canceled:true }`，不改变窗口状态 |
| 日志写入失败 | console warning 并继续运行；不得阻止 app ready 或缩放 |
| 导出写入失败 | `{ ok:false, canceled:false, error }`，控制面板显示受控错误 |

### 5. 正常、基准与错误案例

- 正常：控制面板把 scale 改为 0.8，main 应用实际 bounds、保存 0.8，并让浮层与控制面板同时更新。
- 基准：Electron bridge 不可用时隐藏本机桌宠缩放/导出 UI；该 fallback 只服务开发调试。
- 错误：renderer 自己保存 currentScale 并直接假设 `setBounds` 成功，导致 Windows DPI/实际 bounds 与 UI 显示分叉。

### 6. 必需测试

- unit：scale clamp、workArea bounds clamp、敏感字段/字符串/二进制 redaction、持久日志再次导出仍无秘密。
- build：`npm run build:web` 与 `npm run build:pet`，确认 main/preload/renderer 契约副本一致。
- manual：浮层与控制面板互相同步、重启持久化、reset 可见、导出成功/取消；故障机日志必须能串起 request→actual bounds→display scaleFactor。

### 7. 错误与正确写法

```ts
// 错误：renderer 先认定本地值是真相，IPC 失败后 UI 与窗口分叉。
currentScale = requestedScale;
petBridge.resize(currentScale);

// 正确：main 返回/广播实际值，renderer 只镜像权威状态。
const result = await petBridge.resize(requestedScale);
if (result.ok && result.scale != null) currentScale = result.scale;
```

## Pet renderer

### 场景：Sprite 动作能力与快捷互动

#### 1. 适用范围与触发条件

修改 sprite 状态 ID、运行时帧目录、`pet:list-motions` 返回项或控制面板快捷互动时适用。动作名称、资源目录和用户可见语义必须同步，不能用固定 UI 模板猜测远端能力。

#### 2. 签名

```ts
type MotionMeta = { id: string; label: string; loop: boolean };
socket.emit('pet:list-motions', { targetDeviceId }, (motions: MotionMeta[]) => {});
sendCommand({ type: 'animation', name: motion.id }, targetDeviceIds);
```

#### 3. 契约

- `pet/src/renderer/main.ts` 的 `SPRITE_MOTIONS` 是当前 pet 对外声明能力的真相；每个 ID 必须存在同名 `pet/public/sprites/<pet>/<id>/` 帧目录。
- 当前可由控制面板主动触发的动作是 `joy`（开心）、`jumping`（跳跃）、`sorrow`（委屈）、`waiting`（等待）。`idle`、`running-left`、`running-right` 是内部状态，不显示为快捷互动。
- React 必须先与允许集合求交，再渲染远端实际返回的动作；不得追加硬编码表情模板。旧 `waving` / `failed` 仅可作为 pet 输入兼容别名，不能继续对外声明。
- 动作按钮使用瞬时 `:active` 反馈，不使用永久首项高亮表示发送；reduced-motion 下移除 transform/transition。

#### 4. 校验与错误矩阵

| 条件 | 行为 |
| --- | --- |
| 远端未返回允许动作 | 显示中性空态，不生成虚假按钮 |
| 远端返回内部移动/待机状态 | 保留在 pet 能力清单，但快捷互动过滤 |
| 收到旧 `waving` / `failed` 命令 | 分别兼容映射到 `joy` / `sorrow` |
| 动作目录或首帧缺失 | 构建前回归测试失败，不发布 |
| 按钮禁用 | 不应用 hover/active 反馈，不发送命令 |

#### 5. 正常、基准与错误案例

- 正常：远端返回 `joy/jumping/sorrow/waiting`，UI 显示四个同名语义按钮并发送对应 animation ID。
- 基准：断线或远端无可触发动作时只显示空态。
- 错误：UI 固定渲染“开心/吃惊/生气”等表情，再把它们猜测映射到招手、跳跃或失败动画；或者把左右移动重复放入快捷互动。

#### 6. 必需测试

- pet unit：断言公开 ID/中文标签、运行时首帧目录、新旧目录不存在性，以及旧输入别名仍可识别。
- control source regression：允许集合固定为四项，不存在 `EXPRESSIONS` / `expandedMotions`，且 active/reduced-motion 样式存在。
- build/manual：运行 `npm run build:web` 与 `npm run build:pet`；用两个隔离 Electron 实例逐项确认远端动画。

#### 7. 错误与正确写法

```tsx
// 错误：固定模板与远端能力并列渲染，会重复且语义错配。
{EXPRESSIONS.map(renderExpression)}
{motions.map(renderMotion)}

// 正确：只投影远端真实声明、且允许用户主动触发的动作。
const quickMotions = motions.filter((motion) => QUICK_MOTION_IDS.has(motion.id));
{quickMotions.map(renderMotion)}
```

pet renderer 在单一模块内按功能区组织：constant 和 type 在 state 之前，每个小函数负责一个动画或交互关注点，底部 animation loop 统一协调更新。远程命令通过 discriminated `switch` 校验，再路由到现有 expression、motion、audio、relocation 或 sprite 函数。

昂贵 Three.js object 和可复用数学 buffer 放在模块级，禁止在每帧动画内重复分配。异步 asset load 使用 `motionClipCache` 一类缓存；audio/WebRTC 资源必须显式清理。修改 motion ID、sprite frame 数、bone name、model rotation 等与 asset 耦合的常量前，先检查对应 manifest 和资源。

## 类型与契约副本

两个 TypeScript 项目都启用 `strict: true`。优先使用 literal union、明确 payload type、nullable resource type，以及现有的 `Record`/`Map` 结构。静态 HTML 保证 element 存在时，可以使用局部非空 DOM assertion。宽泛 `any` 不是常规写法；现有使用主要集中在 Electron media constraint、浏览器 stats 或 caught error 互操作。

当前没有生成式共享契约 package。修改 `Command`、`WebRtcSignal`、`MotionMeta`、pairing shape、TTS status 或 preload bridge 时，必须搜索并同步更新 `web/src`、`pet/src` 和 `server/src` 中的所有本地副本。

## 样式

控制面板使用单一全局 stylesheet `web/src/styles.css`，用 CSS custom property 表示颜色，用 `.section`、`.pill`、`.btn` 等普通 class 复用样式，并在同一文件中通过 media query 处理响应式布局。当前没有 CSS module、CSS-in-JS、Tailwind 或 component scoped stylesheet；局部新增样式复用现有变量和 modifier。

## 源码与构建产物

`web/src/*.ts` 和 `web/src/*.tsx` 是手写源码。当前 `tsc -b` 会在 Vite 构建前生成已跟踪的 JavaScript 同名文件 `App.js`、`api.js`、`main.js`。不要单独手改这些 JavaScript 文件；运行构建保持同步。

pet renderer 的 TypeScript 配置使用 `noEmit`，bundle 由 Vite 负责。两个 Vite config 都使用 `base: './'`，因为生产页面由 Electron 从本地文件加载。

验证命令：

```bash
npm run build:web
npm run build:pet
```

跨层行为还要运行 `npm test --prefix server`。
