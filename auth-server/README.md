# 授权服务器 · 1.4.17 Stable 配套服务

这是独立运行的 Linux/Express/PostgreSQL 服务。完整源码在本目录，依赖使用根目录 `package.json` 和 `package-lock.json`。`index.js` 是生产入口；`dev.js` 只用于本机 JSON 数据预览，不用于正式部署。客户端当前版本 1.4.17，服务健康接口的协议版本保留 1.4.9。

## 配置与安全边界

| 环境变量 | 用途 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接地址，必须提供 |
| `KUA_YIPU_AUTH_SECRET` | 至少 32 字符随机签名密钥，必须提供 |
| `PORT` | 默认 8790 |
| `BIND_HOST` | 建议 127.0.0.1，仅由 Nginx 对外提供 HTTPS |
| `PGSSL` | 默认验证数据库 TLS；仅本机非 TLS PostgreSQL 可设 `disable` |
| `KUA_YIPU_ADMIN_USERNAME` | 初始化管理员用 |
| `KUA_YIPU_ADMIN_PASSWORD` | 初始化管理员密码，至少 12 字符 |

不要把实际环境文件提交进源码；完整迁移备份应加密后存储。`.env.example` 只作格式示例，服务不会自动加载 `.env`，应使用 systemd `EnvironmentFile` 或 shell 导出环境变量。

客户端只提交软件授权信息，不向此服务发送 Alibaba 密码。授权码仅保存哈希；管理员会话可撤销。后台支持账号授权/续期/停用/删除、多设备策略、公告和断线保持时长。1.4.9 以上客户端可配置 1 至 21600 分钟（15 天），默认 1 天；在线自动续期，断线保持不延长实际授权有效期。

## 新服务器首次安装

以下示例针对 Ubuntu。操作前准备 Node.js 22、PostgreSQL、Nginx 和有效证书；目录固定为 `/opt/kua-yipu-auth`。已有生产服务不要重复执行初始化或覆盖原密钥。

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates xz-utils postgresql postgresql-client nginx
sudo useradd --system --home /opt/kua-yipu-auth --shell /usr/sbin/nologin kua-yipu
sudo git clone --branch Stable git@github.com:chentao6306/alibaba-international-product-workbench.git /opt/kua-yipu-auth
cd /opt/kua-yipu-auth
sudo bash auth-server/deploy/prepare-runtime.sh
sudo env PATH=/opt/kua-yipu-runtime/node-v22.23.2-linux-x64/bin:$PATH npm ci --omit=dev
```

私有仓库 clone 需要服务器上配置只读部署身份，或者先在本机下载源码并通过 SCP 传入。`prepare-runtime.sh` 下载并校验其固定 Node.js 版本，部署前可审阅该脚本。

创建数据库和角色，交互输入独立数据库密码：

```bash
sudo -u postgres createuser --pwprompt kua_yipu
sudo -u postgres createdb --owner=kua_yipu kua_yipu
sudo install -d -m 700 /etc/kua-yipu
sudo install -m 600 auth-server/.env.example /etc/kua-yipu/auth.env
sudoedit /etc/kua-yipu/auth.env
```

编辑实际连接地址、随机签名密钥与管理员初始化信息。可用 `openssl rand -hex 32` 在服务器本机生成随机值。不要把生成值发到日志或 GitHub。

以 root shell 加载环境并初始化结构/管理员：

```bash
sudo -i
cd /opt/kua-yipu-auth
export PATH=/opt/kua-yipu-runtime/node-v22.23.2-linux-x64/bin:$PATH
set -a
source /etc/kua-yipu/auth.env
set +a
psql "$DATABASE_URL" --set ON_ERROR_STOP=1 -f auth-server/schema.sql
node auth-server/bootstrap-admin.js
exit
```

`bootstrap-admin.js` 对已有同名管理员会重设密码，仅用于首次初始化或明确的密码重置。完成后从环境文件移除 `KUA_YIPU_ADMIN_PASSWORD`。

安装 systemd 服务：

```bash
sudo chown -R kua-yipu:kua-yipu /opt/kua-yipu-auth
sudo install -m 644 auth-server/deploy/kua-yipu-auth.service /etc/systemd/system/kua-yipu-auth.service
sudo systemctl daemon-reload
sudo systemctl enable --now kua-yipu-auth
curl --fail http://127.0.0.1:8790/health
```

## HTTPS 与现有服务器

对外使用 Nginx 的 HTTPS 443；8790 仅监听回环，不开放公网。云防火墙还需放行 TCP 443。

当前服务器使用 `deploy/nginx-compatible-https.conf` 兼容旧客户端，配置包含当前 IP 与证书路径。新服务器应先按域名/IP、证书路径审阅并修改配置，执行 `nginx -t` 后再 reload，不能原样套用旧证书。

现有生产部署脚本：

- `prepare-runtime.sh`：安装固定 Node.js 运行时并核验下载哈希。
- `security-qa.sh`：在隔离 PostgreSQL 测试库运行安全测试，不使用生产库。
- `enable-runtime.sh isolated-tests-passed`：仅在隔离测试通过后切换运行时。
- `update-service.sh`：备份源码和数据库、增量迁移、更新代码、健康检查，失败回滚代码。
- `enable-compatible-https.sh`：更新本项目现有布局的 Nginx 兼容配置。
- `harden-host.sh`、`enable-security-updates.sh`：主机与更新策略；先审阅，避免影响 SSH 运维访问。

升级服务应先将 Stable 源码放在独立暂存目录，验证后以 root 运行该目录内的 `auth-server/deploy/update-service.sh`。不要从旧数据备份直接覆盖整个系统，不要只同步 `index.js` 而遗漏模块、SQL 和后台资源。

## 日常命令

```bash
sudo systemctl status kua-yipu-auth --no-pager
sudo systemctl restart kua-yipu-auth
sudo journalctl -u kua-yipu-auth -n 100 --no-pager
curl --fail http://127.0.0.1:8790/health
sudo nginx -t
sudo systemctl reload nginx
```

数据库备份到权限受控的目录：

```bash
sudo install -d -m 700 /var/backups/kua-yipu
sudo sh -c 'umask 077; runuser -u postgres -- pg_dump -Fc kua_yipu > /var/backups/kua-yipu/database.dump'
sudo pg_restore --list /var/backups/kua-yipu/database.dump
```

完整数据加密备份和恢复见 [stable-backup.md](../docs/stable-backup.md)。新增 SQL 迁移一般可重复执行，但回滚旧版本仍需核对结构兼容性并保留升级前备份。

## Docker

从仓库根目录构建，使用根目录锁文件：

```bash
docker build -f auth-server/Dockerfile -t kua-yipu-auth:1.4.17 .
docker run -d --name kua-yipu-auth --restart unless-stopped \
  --env-file /private/auth.env -e BIND_HOST=0.0.0.0 \
  -p 127.0.0.1:8790:8790 kua-yipu-auth:1.4.17
```

容器内 `BIND_HOST=0.0.0.0`；数据库地址使用容器可达地址，不是容器自身 `127.0.0.1`。发布到宿主机端口仅绑定回环，Nginx 再代理 HTTPS。先单独执行结构迁移和管理员初始化，镜像不会自动创建数据库。

## 本机预览与测试

在开发终端设置自己的临时管理员密码和随机签名密钥，再启动：

```powershell
$env:KUA_YIPU_ADMIN_USERNAME='admin'
$env:KUA_YIPU_ADMIN_PASSWORD='replace-with-a-local-test-password'
$env:KUA_YIPU_AUTH_SECRET='replace-with-a-random-local-secret-at-least-32-characters'
node auth-server/dev.js
```

另开终端启动开发桌面：

```powershell
$env:KUA_YIPU_AUTH_URL='http://127.0.0.1:8790'
npm run desktop
```

开发预览数据默认 `.data/auth-dev.json`，不连接生产 PostgreSQL。正式打包桌面忽略该地址覆盖，生产入口修改方法见根目录 README。

```powershell
node --test test/auth-dev.test.js test/auth-security.test.js test/announcement-sync.test.js
node tools/admin-qa.mjs
```

PostgreSQL 集成测试仅允许 `AUTH_TEST_DATABASE_URL` 指向名称以 `auth_qa_` 开头的独立测试数据库。不要把生产连接串传给测试。
