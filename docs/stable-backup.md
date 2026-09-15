# 1.4.17 Stable 数据备份与恢复

源码在 `Stable` 分支；实际业务数据以 AES-256-GCM 加密附件保存在私有仓库的 `v1.4.17-stable` Release。解密密钥只交由项目所有者保管，不上传 GitHub。源码分支的 Git 历史不包含明文账号、Cookie、生产数据库或环境文件。

## 备份附件

- `local-data-1.4.17.tar.gz.enc`：仓库 `.data`、本地测试数据、桌面用户目录。包含商品、任务、断点、上传图片、浏览器资料和加密凭据。解密包内 `inventory.json` 保存每个文件的大小、SHA-256 和读取失败清单。
- `server-data-1.4.17.tar.gz.enc`：在线 PostgreSQL 一致性备份、角色备份、实际部署源码、systemd、Nginx、授权环境及 HTTPS 配置。包内有校验清单。没有停止或修改生产服务。
- `chaodekuai-1.4.17-setup.exe`：已验收的安装包。
- `SHA256SUMS.txt`、`backup-manifest.json`：Release 附件校验值和范围说明。

本次在用户正常退出软件后重新复制完整目录，共 18,903 个文件、2,183,611,572 字节，读取失败为 0，先前锁定的 9 个浏览器文件已全部纳入。`inventory.json` 记录逐文件校验值。恢复后应检查任务状态；数据快照不是 Windows VSS 磁盘镜像。

不备份其他客户电脑、整台电脑、整个服务器操作系统或本机 SSH 私钥。可再生成的 Node 依赖、Chromium 缓存、旧安装包不进入源码 Git；当前发行程序包含运行所需依赖和浏览器。线上旧调试文件与实际部署依赖清单在服务器加密快照内，当前可维护生产源码在 `auth-server/`。

## 下载和解密

先登录有仓库权限的 GitHub 账号，将附件下载到仓库之外的私有目录：

```powershell
gh release download v1.4.17-stable --repo chentao6306/alibaba-international-product-workbench --dir D:/workbench-restore
Get-FileHash D:/workbench-restore/*.enc -Algorithm SHA256
```

核对结果与 `SHA256SUMS.txt` 后，使用单独保存的 `restore-key.json`：

```powershell
node tools/encrypted-backup.mjs open D:/workbench-restore/local-data-1.4.17.tar.gz.enc D:/workbench-restore/local.tar.gz D:/private/restore-key.json
node tools/encrypted-backup.mjs open D:/workbench-restore/server-data-1.4.17.tar.gz.enc D:/workbench-restore/server.tar.gz D:/private/restore-key.json
New-Item -ItemType Directory -Force D:/workbench-restore/local,D:/workbench-restore/server
tar -xzf D:/workbench-restore/local.tar.gz -C D:/workbench-restore/local
tar -xzf D:/workbench-restore/server.tar.gz -C D:/workbench-restore/server
```

错误密钥或被篡改的文件不能通过认证，工具不会生成最终明文输出文件。工具也拒绝覆盖已有输出文件。**丢失密钥后无法解密 GitHub 数据备份**，请另存一份离线备份。

## 恢复桌面数据

1. 完全退出抄得快，确认没有运行中的采集/上架任务；先备份当前用户目录。
2. 恢复 `desktop-user-data/.data` 到 `%APPDATA%/alibaba-international-product-workbench/.data`。其中 `workspace.json`、`collection-checkpoints` 和 `media` 应一起恢复。
3. 同一 Windows 用户可按需恢复同目录下的凭据和浏览器资料。不同电脑/用户应重新登录及配置授权码和 API 密钥，Windows DPAPI 密文不能视作跨电脑凭据迁移方案。
4. 仓库开发数据在 `project-data`，测试数据在 `project-e2e-data`；不要把两者覆盖进正式桌面工作区。
5. 启动后检查商品数量和任务状态，核对实际平台结果再继续未完成上架，避免重复提交。

## 恢复服务器

包中的 `database.dump` 为 PostgreSQL custom format，可用 `pg_restore --list database.dump` 检查。恢复时先在新建空数据库演练：

```bash
sudo -u postgres createdb kua_yipu_restore_check
sudo -u postgres pg_restore --exit-on-error --no-owner --no-acl --dbname kua_yipu_restore_check /private/restore/database.dump
```

根据新数据库角色重新授权。正式切换前备份现有数据库，暂停授权服务写入，恢复并检查表、账号、公告和健康状态，再切换连接地址。`roles.sql` 含角色密码哈希，不应直接覆盖现有集群角色；仅在明确恢复方案下使用。

`server-files.tar.gz` 保留实际部署树及配置，先解压到隔离目录核对，再选择性恢复。不要将旧证书/环境变量直接覆盖到不同服务器；证书可能到期，需要续签。部署源码和日常运维命令见 [auth-server/README.md](../auth-server/README.md)。

## 创建下一次加密备份

先将所需数据打包到仓库之外，再执行：

```powershell
node tools/encrypted-backup.mjs keygen D:/private/new-restore-key.json
node tools/encrypted-backup.mjs seal D:/private/data.tar.gz D:/private/data.tar.gz.enc D:/private/new-restore-key.json
```

`KYB1` 文件格式为 4 字节标识、12 字节随机 nonce、密文和末尾 16 字节认证标签；头部也参与认证。每个备份使用随机 nonce。加密附件可以上传私有 Release，密钥和解密后的数据留在独立受控存储。
