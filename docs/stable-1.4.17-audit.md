# Stable 1.4.17 归档核查

应用代码基线：`65dc255`，分支：`Stable`，应用与锁文件版本：`1.4.17`。

## 源码范围

核查目录：`src`、`server`、`electron`、`auth-server`（包含所有 deploy 脚本）、`test`、`tools`、`public`、`assets`、`docs`、`build/installer.nsh`，以及根目录配置和启动脚本。归档基于已有完整 Git 历史，不是复制部分源码建立的空仓库。

本次补充 README、备份恢复说明、授权环境模板、完整 systemd 服务模板、AES-256-GCM 备份工具及其验证测试。与基线相比，客户端业务代码和已有授权服务实现保持一致，打包版本仍为 1.4.17。

## 验证

- `npm test -- --test-concurrency=2`：187 项测试通过，无失败、取消或跳过。
- `npm run build`：通过，保留现有前端体积提示。
- 新增备份工具验证：随机二进制文件加密后可原样恢复；错误密钥或篡改密文被拒绝，认证失败不生成最终明文文件。
- 通过 SSH 读取线上部署文件，与本地代码按换行归一后比较：生产 `index.js`、`security.js`、`http-security.js`、`policy.js`、后台 JS/CSS/HTML、`schema.sql` 均一致。线上 `dev.js` 和旧 README 属历史预览文件，保存在加密服务器快照内，不覆盖当前维护版本。
- PostgreSQL 使用在线 `pg_dump -Fc` 创建一致性备份，并通过 `pg_restore --list` 读取归档结构；不停止生产服务。
- 1.4.17 安装包 SHA-256：`36f9dd8a3452d147f6815f587993b915dcc8b12069a0cb0f90a50fdbf89b0257`。
- 用户退出软件后重新生成本地快照：18,903 个文件、2,183,611,572 字节、0 个读取失败；包含之前被占用的 9 个浏览器会话文件。

## 上传后核对方法

Release 的 `backup-manifest.json` 记录备份文件数量、例外和校验值，`SHA256SUMS.txt` 记录全部附件 SHA-256。上传后重新从 GitHub 下载附件并比对哈希；Stable 分支使用远程引用和全新 clone 比较文件树。GitHub 自动生成的源码压缩包不包含 Release 的加密数据附件，恢复资料时需要同时下载。

恢复密钥保留在项目所有者本机的 `E:/workbench-stable-1.4.17-backup/restore-key.json`，未写入 Git 或 Release。具体解密和恢复命令见 [stable-backup.md](stable-backup.md)。
