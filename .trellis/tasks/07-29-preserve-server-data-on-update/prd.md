# 修复服务器更新后持久数据清空

## Goal

确保通过 Git 拉取或重新部署 Linux server 时，双方成员名称、设备历史、个人音频和桌面便签不会因为代码目录被替换而静默清空；同时提供可执行的旧数据迁移与恢复路径。

## Background

- 修复前 `server/src/index.js:117-121` 在未配置 `PET_DATA_DIR` 时使用包内 `server/data`；当前启动入口位于 `server/src/index.js:118-123`，路径契约由 `server/src/data-directory.js:5-50` 实现。
- `server/src/persistent-store.js:88-115` 将成员名称、设备、音频 metadata 和便签 registry 写入该目录；便签图片与个人音频也位于其子目录。
- 修复前 `server/.env.example:5-6` 仅注释提示 `/var/lib/desktop-pet`；当前模板在 `server/.env.example:2-7` 明确生产环境与持久目录。
- 普通 `git pull --ff-only` 和 `npm ci --prefix server --omit=dev` 不删除未跟踪的 `server/data`；重新 clone、替换整个部署目录或 `git clean -fdx` 会删除包内默认数据。
- `server/data/` 当前未列入仓库 `.gitignore`，存在被误提交或被清理命令处理的风险。
- 房间以 `ROOM_SECRET` 的 SHA-256 hash 作为 registry key；更换房间密钥也会表现为名称和便签同时恢复默认，但不等同于文件丢失。

## Requirements

- R1：`NODE_ENV=production` 时，未显式设置 `PET_DATA_DIR` 必须默认使用代码仓库外的绝对路径 `/var/lib/desktop-pet`；非生产开发环境继续默认使用 `server/data`。
- R2：标准更新流程使用同一 checkout 中的 `git pull --ff-only`，然后安装 server 生产依赖并通过 PM2 reload；不得要求每次重新下载 release 包。
- R3：从旧包内 `server/data` 切换到外部目录时，必须迁移整个目录，包括 `registry.json`、`audio/` 和 `notes/`，不能只复制 registry。
- R4：当配置指向空的新目录、但旧包内目录存在 registry 时，server 必须阻止静默以空 registry 启动，并给出可执行的迁移提示。
- R5：未知 registry 版本、损坏 JSON、迁移/复制失败继续遵守现有 fail-closed 约束，不得覆盖或删除原数据。
- R6：`server/data/` 必须被 Git 忽略；`.env` 与持久数据都不得进入提交或 release bundle。
- R7：部署文档必须覆盖首次 Git 部署、日常 pull 更新、升级前备份、旧数据迁移、PM2 实际工作目录确认、权限、验证和回滚。
- R8：文档必须说明更换 `ROOM_SECRET(S)` 会切换 registry 房间 key，并提供区分“数据目录丢失”和“房间密钥变化”的检查方法。
- R9：持久路径选择与 legacy 检测必须有自动化测试；现有 PersistentStore 重启恢复测试继续通过。

## Acceptance Criteria

- [x] AC1：已配置外部 `PET_DATA_DIR` 的部署执行 `git pull --ff-only`、`npm ci --prefix server --omit=dev` 和 PM2 reload 后，原有成员名称、便签及附件仍可读取。
- [x] AC2：新部署只阅读文档即可建立外部数据目录、配置 `.env`、启动 server 并通过健康检查。
- [x] AC3：旧 `server/data/registry.json` 存在而新配置目录为空时，server 拒绝创建空 registry，并明确指出旧目录、新目录及迁移要求。
- [x] AC4：完成整个旧数据目录迁移后，server 正常启动，store 测试证明名称、便签、音频 metadata 和附件路径保持有效。
- [x] AC5：损坏 registry 或不支持的版本仍拒绝启动并保留原文件。
- [x] AC6：`git status` 不显示 `server/data/` 内容；release workflow 不打包运行时数据或 `.env`。
- [x] AC7：server 自动化测试通过；部署文档中的 shell 示例通过语法/静态检查。
- [x] AC8：生产模式未设置 `PET_DATA_DIR` 时解析为 `/var/lib/desktop-pet`；开发/测试模式仍解析为包内 `server/data`。

## Out of Scope

- 自动登录或修改当前生产服务器。
- 引入数据库、对象存储、远程备份服务或零停机多实例迁移。
- 自动修改云厂商安全组、systemd 用户或 PM2 运行用户。
