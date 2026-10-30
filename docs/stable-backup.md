# 数据备份与恢复

源码分支不包含数据库、商品、媒体、账号、授权环境、浏览器会话或它们的加密备份。需要备份时，将数据放在仓库之外的受控目录，并单独保管解密密钥。

## 备份范围

- 桌面端：商品数据库、采集和发布任务断点、上传媒体、模板及相关本机配置。
- 服务端：PostgreSQL 一致性备份、安装包更新目录、公告和诊断存储、服务环境与部署配置。
- 凭据及浏览器资料只在经授权的受控存储中保管。Windows DPAPI 密文不能当作跨电脑或跨用户的凭据迁移方案。
- 源码、依赖和 Chromium 与业务数据分开管理；不要把完整运行目录提交 Git。

## 加密工具

`tools/encrypted-backup.mjs` 提供密钥生成、AES-256-GCM 加密和解密。以下路径均为示例，执行前替换为自己的受控目录。

```powershell
node tools/encrypted-backup.mjs keygen D:/private/restore-key.json
node tools/encrypted-backup.mjs seal D:/private/data.tar.gz D:/private/data.tar.gz.enc D:/private/restore-key.json
node tools/encrypted-backup.mjs open D:/private/data.tar.gz.enc D:/private/restored.tar.gz D:/private/restore-key.json
```

工具拒绝覆盖已有输出；错误密钥或篡改内容无法通过认证。密钥丢失后无法恢复。密钥与加密文件必须分开保存，解密后的资料也不能上传源码仓库。

## 恢复桌面端

1. 完全退出软件并确认没有运行中的任务，备份当前数据目录。
2. 将对应版本的商品、媒体、模板和断点一起恢复，不能只替换 `workspace.json`。
3. 使用原 Windows 用户恢复本机凭据；切换电脑或用户时重新登录及配置授权和 API 密钥。
4. 区分开发测试目录与正式桌面数据目录，不能相互覆盖。
5. 启动后核对商品数量、任务状态和平台真实提交结果，再决定继续哪些任务，避免重复发布。

## 恢复服务端

先在隔离的空数据库演练，不直接覆盖生产库：

```bash
sudo -u postgres createdb kua_yipu_restore_check
sudo -u postgres pg_restore --exit-on-error --no-owner --no-acl --dbname kua_yipu_restore_check /private/restore/database.dump
```

正式切换前备份现有数据库并暂停对应服务写入，恢复后检查结构、授权、公告、更新目录和健康状态。数据库角色、权限、环境变量与证书必须按目标环境配置，不要直接覆盖旧角色密码或过期证书。

服务端部署及运维见 [授权后台说明](../auth-server/README.md)。源码版本与数据库结构需兼容；回退代码不等于可以回退业务数据。
