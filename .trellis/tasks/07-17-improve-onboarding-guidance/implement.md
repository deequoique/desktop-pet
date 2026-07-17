# 实施计划：首次配置引导与身份切换

## 1. 配置判定与 Electron 启动行为

- [x] 提取可测试的完整 pairing 判定，覆盖服务器、密钥、合法成员、稳定设备 ID 和设备名称。
- [x] 让 Electron main 的启动自动显示条件与 pairing snapshot 使用同一判定，不再只检查两个非空字符串。
- [x] 为控制面板未就绪时的显示请求增加 pending/ready 处理，确保首次配置窗口实际显示并获得焦点。
- [x] 调整 pairing 保存顺序：写盘成功后才替换内存配置并广播，写盘失败不污染运行时快照。
- [x] 扩展 `pet/test`，以纯函数/行为断言覆盖首次配置判定，避免只用正则检查源码存在调用。

## 2. 服务端配置发现

- [x] 在 server 增加 `pairing:discover` ack 事件，校验协议版本与房间密钥，只返回 `a/b` 的显示名称。
- [x] 为错误密钥、旧协议和成功响应定义稳定错误码；不得创建 participant 或登记设备。
- [x] 在 `web/src/api.ts` 增加独立临时 socket wrapper，统一清理成功、失败、超时和连接错误路径。
- [x] 在 server 集成测试中覆盖正确/错误密钥、真实成员名称和无设备副作用。

## 3. 首次两步 UI

- [x] 将 `memberId` 的未配置状态显式建模为空，不再在 pairing 加载前默认 `a`。
- [x] 将 `settings` 设为控制面板固定首页；pairing 不完整时展示服务器/密钥验证步骤，已有完整配置仍从设置开始。
- [x] 验证成功后展示真实成员名称、空的必选身份和设备名称，再保存完整 pairing 并连接。
- [x] 服务器或密钥字段变化时清除旧验证结果；为错误密钥、不可达、超时和版本不支持提供中文反馈。
- [x] 首次引导期间隐藏或禁用依赖已连接房间的设置区；补充所需 CSS、焦点与窄窗口样式。

## 4. 设备成员归属迁移

- [x] 在 `PersistentStore` 实现带内存回滚的 `moveDevice`，保留设备名称/首次时间、刷新最后时间，不移动成员音频。
- [x] 新增 `device:change-member`：限制为已加入 controller，只迁移发送方设备，校验目标与冲突，结束相关通话，并同步 participant 与两个 endpoint 的 `socket.data.memberId`。
- [x] 在 `web/src/api.ts` 增加带 timeout 的身份迁移 wrapper 和稳定返回类型。
- [x] 为 store 和 server 集成补充成功、权限拒绝、目标冲突、字段保留、音频隔离及两个 endpoint 一致性测试。

## 5. 已连接身份切换 UI 与补偿

- [x] 设置页把已连接身份显示为摘要，并增加“更改身份”选择与确认层。
- [x] 确认后先请求服务端迁移，再通过 Electron IPC 保存新 pairing；成功后沿用 pairing 广播让 pet/controller 自动重连。
- [x] Electron 保存失败时请求迁回旧成员，并分别处理补偿成功与补偿失败反馈；失败路径不得显示成功或静默改变本地身份。
- [x] 切换过程禁用重复提交，结束当前通话，并保持设置页；普通运行时断线不触发自动导航。

## 6. 契约同步与生成产物

- [x] 同步 `web/src/App.tsx`、`web/src/api.ts`、Electron preload bridge/`Window` 类型和需要的 pet renderer pairing 副本。
- [x] 运行 web 构建生成并复核已跟踪的 `web/src/*.js`，不手工编辑生成文件。
- [x] 若实现形成新的长期 pairing/Socket.IO 约束，按 `trellis-update-spec` 更新 frontend、backend 与 shared spec。

## 7. 验证与评审门

- [x] `npm test --prefix server`
- [x] `npm test --prefix pet`
- [x] `npm run build:web`
- [x] `npm run build:pet`
- [x] 使用独立临时 `userData` 做 Electron 首次启动烟雾测试：窗口自动显示、首屏设置、先验证后选身份。
- [x] 验证完整配置重启不强制显示控制面板，运行中断线不切页。
- [x] 验证身份 A→B 后同一设备 ID 只归 B，两个 endpoint 均重连，A 的私有音频仍归 A；再验证 B→A 可逆。
- [x] 复核并保留任务开始前已有的未提交修改：`.trellis/spec/desktop-pet/frontend/frontend-and-electron-patterns.md`、`pet/src/main/index.js`、`pet/test/updater-main.test.cjs`。

## 风险与回滚点

- server 新事件是客户端首次配置的前置依赖；部署顺序必须是 server 先、Electron 后。
- `pet/src/main/index.js` 当前已有用户未提交修改，实施时只做最小局部补丁并在提交前检查 diff，禁止覆盖 updater 相关工作。
- 身份迁移同时影响持久 registry 与 runtime socket 身份；任一测试失败先回滚该事件和 store helper，不把 UI 降级成生成新 device ID。
- 若 Electron 实机窗口显示仍不稳定，保留纯判定与 UI 自动设置导航，单独回滚 ready/pending 窗口机制并继续定位平台生命周期问题。
