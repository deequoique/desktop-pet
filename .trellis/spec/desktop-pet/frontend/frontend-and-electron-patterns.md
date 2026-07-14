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

Electron 负责持久化 pairing 和加密 BYOK 凭据。独立 web 模式只用 `localStorage` 保存非敏感偏好，不能持久化 API key；必须保留这一区别。

## Pet renderer

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
