# 修复服务器更新后持久数据清空：实施计划

## 1. 启动路径与预检

- 新增可单测的 data-directory helper，解析显式路径、生产默认 `/var/lib/desktop-pet` 和开发 legacy 路径。
- 生产显式相对路径 fail closed。
- 在 `server/src/index.js` 创建 `PersistentStore` 前运行目录创建、权限和 legacy registry 冲突检查。
- 错误信息不得包含房间密钥、registry 内容或用户便签，只包含必要的路径和操作提示。

## 2. 回归测试

- 新增 data-directory unit tests，覆盖生产/开发默认、override、相对路径、legacy 冲突和有效已迁移目录。
- 扩展 store 持久化测试，使同一恢复案例同时断言成员名称、设备、个人音频、便签 metadata 与图片附件。
- 保留未知版本和损坏 registry 的 fail-closed 断言。

## 3. 部署与 Git 安全

- `.gitignore` 增加 `server/data/`。
- `server/start-linux.sh` 明确以 production 模式启动。
- 更新 `server/.env.example`，说明生产默认路径、显式 override 与首次目录权限要求。
- 更新 `docs/deployment.md`：Git clone、首次配置、PM2 启动、`git pull --ff-only` 更新、禁止清理命令、备份、legacy 全目录迁移、验证、密钥切房排查和回滚。
- 核对 `docs/server-diagnostics.md` 与 `docs/ubuntu-coturn-deployment.md` 的 cwd/PM2 命令，避免提供相互冲突的路径。

## 4. 验证

按顺序运行：

```bash
npm test --prefix server
bash -n server/start-linux.sh
git check-ignore -v server/data/registry.json
git status --short
```

检查 release workflow 的复制清单仍不包含 `.env`、`server/data` 或 `/var/lib/desktop-pet` 内容。

## 5. Review 与回滚点

- 若路径 helper 会影响测试子进程，优先显式传入测试 `PET_DATA_DIR`，不放宽生产保护。
- 若发现现有生产部署依赖相对 `PET_DATA_DIR`，回到 planning 记录兼容方案，不静默 `path.resolve`。
- 回滚代码不触碰任何已迁移数据；保留 `/var/lib/desktop-pet` 与 legacy 备份，由操作者明确选择唯一权威目录。
