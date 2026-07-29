# 修复服务器更新后持久数据清空：技术设计

## 1. 边界与原则

持久数据继续由现有 `PersistentStore` 管理，不修改 registry schema、房间 hash、Socket.IO 契约或客户端。新增的职责只位于 server 启动边界：

1. 根据运行环境解析数据目录。
2. 在创建 `PersistentStore` 前检查目录、权限与 legacy 数据冲突。
3. 对需要人工搬迁的情况 fail closed，禁止创建第二份空 registry。

代码仓库负责发布应用；`/var/lib/desktop-pet` 负责生产数据。两者的生命周期必须分离。

## 2. 路径解析

新增一个无副作用、可单测的 server data-directory helper：

- 显式且非空的 `PET_DATA_DIR` 优先。
- `NODE_ENV=production` 且未显式配置时返回 `/var/lib/desktop-pet`。
- 其他环境返回由 `server/src/` 推导出的 legacy `server/data`，保留本地开发体验。
- 生产环境显式配置相对路径时拒绝启动，防止 PM2 cwd 或启动方式变化后写到不同位置。

Linux release 的 `start-linux.sh` 明确提供生产环境；PM2 的 `ecosystem.config.cjs` 已设置 `NODE_ENV=production`。源码部署文档也必须显式使用生产环境。

## 3. 启动预检与 legacy 保护

在构造 `PersistentStore` 前执行预检：

1. 计算目标目录和 legacy `server/data`。
2. 如果目标目录不是 legacy，目标没有 `registry.json`，但 legacy 存在 `registry.json`，抛出带两个绝对路径的受控启动错误。
3. 否则递归创建目标目录，并验证当前进程可读、可写。
4. 权限失败时拒绝启动，提示操作者为真实 PM2/systemd 用户创建并授权目录。
5. 目标 registry 存在时交给现有 `PersistentStore` 加载；损坏或未知版本继续由 store fail closed。

不自动复制旧数据。registry、音频和便签附件必须作为一个目录一致迁移；自动跨文件系统复制会引入部分成功、空间不足、权限和并发写入风险。文档要求停服、备份、使用保留属性的复制命令、验证后再 reload。

## 4. Git 与发布边界

- `.gitignore` 增加 `server/data/`，避免运行时 registry、私人音频和便签附件进入 Git。
- release workflow 继续只打包 `server/src`、部署脚本、依赖和模板，不包含 `.env` 或运行时数据。
- 标准更新路径固定为同一 checkout 执行 `git pull --ff-only`，禁止用 `git clean -fdx` 清理部署目录。
- 文档同时覆盖 Git clone 首次部署、日常 pull、旧目录迁移、备份、验证和回滚。

## 5. 数据迁移与回滚

推荐迁移流程：

1. 确认 PM2 实际 cwd、运行用户、`.env` 和 legacy 数据路径。
2. 停止 server 或在停写窗口内执行，备份整个 legacy 目录。
3. 创建 `/var/lib/desktop-pet` 并授权给运行用户。
4. 把 legacy 目录全部内容复制到新目录，保留权限与时间信息。
5. 启动 server，验证 registry 可加载、双方名称和便签列表存在。
6. 在确认稳定前保留旧目录备份。

回滚代码只切回上一提交并 reload；不得删除或降级 `/var/lib/desktop-pet`。如果需要回到 legacy 路径，必须停服后复制完整目录，避免两个 registry 分叉。

## 6. 测试策略

- unit：生产默认、开发默认、显式绝对路径、生产相对路径拒绝。
- unit：目标空但 legacy registry 存在时 fail closed；目标已有 registry 时不误报。
- unit：不可写/不可创建目录返回可操作错误。
- store regression：名称、设备、音频、便签与附件重启恢复；损坏/未知 registry 保留。
- integration：完整 `npm test --prefix server`。
- static：`bash -n server/start-linux.sh`，并检查文档/示例与 release bundle 不包含运行时数据。

## 7. 风险与取舍

- `/var/lib` 首次创建通常需要 sudo。通过启动前明确失败和文档中的 `install -d` 解决，不让 server 以 root 常驻。
- 生产默认路径变化会让已有 legacy 部署首次升级时触发保护性停机。该停机是有意的：它阻止服务以空数据继续运行。
- 改变 `ROOM_SECRET(S)` 会选中另一个 room hash；文档必须先检查密钥配置，避免把逻辑切房误判为迁移失败。
