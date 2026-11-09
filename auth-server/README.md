# 授权服务器 · 1.4.102 源码交接

整理日期：2026-11-09，源码分支 `codex/1.4.102`。这是独立运行的 Linux/Express/PostgreSQL 服务，完整源码在本目录，依赖使用根目录 `package.json` 和 `package-lock.json`。`index.js` 是生产入口；`dev.js` 只用于本机 JSON 预览，不能用于正式部署。客户端候选版本为 1.4.102，本次无后台业务代码修改；健康接口保留的独立服务标识为 1.4.53，两者不能混作同一版本号。

包含账号授权、管理员账号、批量续期/减期/停用、图文公告、签名更新包和客户诊断报告。后台代码提交不会自动部署服务或发布客户端。生产数据库、环境文件、私有管理员入口和存储内容不在源码中。

## 文档导航

- [配置与安全边界](#配置与安全边界)
- [新服务器首次安装](#新服务器首次安装)
- [HTTPS 与现有服务器](#https-与现有服务器)
- [日常命令](#日常命令)
- [Docker](#docker)
- [本机预览与测试](#本机预览与测试)
- [客户诊断日志](#客户诊断日志)
- [批量授权管理](#批量授权管理)
- [管理员修改账号密码与私有入口](#管理员修改账号密码与私有入口)

入口与职责：`index.js` 注册生产路由，`schema.sql` 定义结构；`security.js`、`policy.js`、`http-security.js` 负责授权和安全；`admin-pages.js` 挂载管理页面，`admin-*.js` 实现前端模块；`bulk-licenses.js`、`diagnostics.js`、`updates.js` 分别实现批量授权、报告和更新。升级时不能遗漏这些依赖模块。

## 图文与重复弹窗公告

后台“新建公告”可添加文字段落和 JPG、PNG、WebP 图片（每条最多 10 张，单张上传最多 8 MiB），支持调整顺序、图片说明和预览。展示方式选择“每次进入软件都弹窗”时，1.4.64 及以后客户端在每次打开软件进入工作台时显示，关闭后不会因定时刷新或窗口重新获得焦点而重复。旧客户端继续显示文字正文及图片升级提示，重复弹窗需升级客户端。

图片由 `sharp` 校验并转存为 WebP，最大边长 2400 像素；不接收任意 HTML 或外部图片地址。仅正式发布的公告图片允许客户端访问，草稿、未关联、撤回或删除后不再公开。文件默认位于 `KUA_YIPU_UPDATE_DIR/announcement-images`，可用 `KUA_YIPU_ANNOUNCEMENT_DIR` 覆盖；该目录必须持久化、可由服务用户写入，并随数据库一起备份。暂未自动清理已不被引用的文件。

Nginx 为 `/api/admin/announcement-images` 单独配置 `client_max_body_size 8m`，保持其他 API 原有限额。`tools/deploy-announcement-proxy.mjs` 可幂等更新当前服务的代理配置。此次部署使用暂存目录 `/var/tmp/kua-yipu-announcements-版本号`：先安装含 `sharp` 的服务依赖并运行 `auth-server/deploy/announcement-qa.sh`，再运行 `auth-server/deploy/update-announcements.sh isolated-tests-passed`，后者备份源码、依赖、代理配置和数据库，执行增量迁移并在健康检查失败时回滚代码。

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
| `KUA_YIPU_ADMIN_PATH` | 私有管理员入口；生产必须由维护者单独配置 |
| `KUA_YIPU_UPDATE_DIR` | 更新包、版本索引与上传状态的持久目录 |
| `KUA_YIPU_ANNOUNCEMENT_DIR` | 公告图片目录，默认在更新目录下 |
| `KUA_YIPU_DIAGNOSTIC_DIR` | 私有诊断报告目录，禁止通过静态网站公开 |

不要把实际环境文件提交进源码；完整迁移备份应加密后存储。`.env.example` 只作格式示例，服务不会自动加载 `.env`，应使用 systemd `EnvironmentFile` 或 shell 导出环境变量。

客户端只提交软件授权信息，不向此服务发送 Alibaba 密码。授权码仅保存哈希；管理员会话可撤销。后台支持账号授权/续期/停用/删除、多设备策略、公告和断线保持时长。1.4.9 以上客户端可配置 1 至 21600 分钟（15 天），默认 1 天；在线自动续期，断线保持不延长实际授权有效期。

## 新服务器首次安装

以下示例针对 Ubuntu。操作前准备 Node.js 22、PostgreSQL、Nginx 和有效证书；目录固定为 `/opt/kua-yipu-auth`。已有生产服务不要重复执行初始化或覆盖原密钥。

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates xz-utils postgresql postgresql-client nginx
sudo useradd --system --home /opt/kua-yipu-auth --shell /usr/sbin/nologin kua-yipu
sudo git clone --branch codex/1.4.99 --single-branch git@github.com:chentao6306/alibaba-international-product-workbench.git /opt/kua-yipu-auth
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
- `update-admin.sh`：用于已装好在线更新服务的后台修补，备份并替换五个管理页面/更新模块文件，重启服务并检查健康，失败回滚；不迁移数据库。
- `enable-compatible-https.sh`：更新本项目现有布局的 Nginx 兼容配置。
- `harden-host.sh`、`enable-security-updates.sh`：主机与更新策略；先审阅，避免影响 SSH 运维访问。

升级服务应先将当前版本源码放在独立暂存目录，验证后以 root 运行该目录内的 `auth-server/deploy/update-service.sh`。不要从旧数据备份直接覆盖整个系统，不要只同步 `index.js` 而遗漏模块、SQL 和后台资源。

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
docker build -f auth-server/Dockerfile -t kua-yipu-auth:1.4.99 .
docker run -d --name kua-yipu-auth --restart unless-stopped \
  --env-file /private/auth.env -e BIND_HOST=0.0.0.0 \
  -e KUA_YIPU_UPDATE_DIR=/var/lib/kua-yipu/updates \
  -e KUA_YIPU_ANNOUNCEMENT_DIR=/var/lib/kua-yipu/announcement-images \
  -e KUA_YIPU_DIAGNOSTIC_DIR=/var/lib/kua-yipu/diagnostics \
  -v /srv/kua-yipu:/var/lib/kua-yipu \
  -p 127.0.0.1:8790:8790 kua-yipu-auth:1.4.99
```

容器内 `BIND_HOST=0.0.0.0`；数据库地址使用容器可达地址，不是容器自身 `127.0.0.1`。发布到宿主机端口仅绑定回环，Nginx 再代理 HTTPS。先准备宿主持久目录及权限，单独执行结构迁移和管理员初始化，镜像不会自动创建数据库。容器更换时保留数据卷，不将数据库备份或真实环境文件放进构建上下文。

## 本机预览与测试

### 重置授权码与多端登录

允许多端登录的账号，管理页面重置授权码时默认不勾选“同时退出已登录设备”。新授权码用于后续登录，旧码立即不能再用于登录；已验证的在线会话保持有效，可继续心跳续期。退出软件、会话到期后重新登录需要新授权码，客户端本地保存的旧码不会自动更新。

勾选“同时退出已登录设备”会撤销所有现有会话。首次启用授权码强制撤销未验证旧会话；单设备账号默认勾选，即使取消勾选，新电脑登录仍会替换旧电脑。停用、注销、删除和授权过期继续阻止使用。

管理 API 的 `credential` 操作接受布尔值 `revokeSessions`。显式传入 `false` 才保留已验证会话；省略时保持旧 API 的撤销行为，避免旧管理页面的确认含义改变。结果及审计事件中的 `sessionsRevoked` 记录实际行为，不记录授权码。实现不需要数据库迁移，也不能恢复修复前已被撤销的会话。

此行为属于独立授权服务，必须部署服务端并刷新管理页面后生效，仅更新桌面安装包无效。已被旧服务退出的电脑，使用最新授权码重新登录一次即可；给新电脑登录可复用现有有效授权码，无需每次重置。

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

## 客户诊断日志

桌面设置和登录页提供问题描述、上传日志、清理日志；客户端不提供预览或导出。管理后台“客户诊断日志”可按编号、账号或版本查询，查看商品快照、错误详情及截图，并下载报告。

发布失败记录包含当前商品及独立来源快照的标题、原链接、正文、属性、规格价格、图片/视频链接、包装信息，以及发布阶段、耗时、控件实际值、错误提示和最多两张发布页截图。只捕获国际站发布页面；不捕获登录或验证页面，不读取密码、授权码、Cookie、会话令牌。文字及结构化字段经过脱敏和体积限制；截图遮挡密码等敏感输入。截图失败或页面无响应时有界退出，保留文字诊断，不覆盖原发布错误。

普通操作摘要保留一天，异常摘要和发布证据保留七天，启动/运行期间每小时及上传前清理。正常日志单文件上限约 64 KiB；发布记录按账号分目录，最多 60 份/96 MiB，每份最多 4 MiB。上传优先带最近五次失败，体积不够时明确记录省略数量。清理操作只删除本机诊断文件，不删除商品或账号资料。

`POST /api/client/diagnostics` 验证授权会话、设备、有效期和安全传输。同一报告重试返回同一编号，每份限 8 MiB，每账号每小时最多 10 份；服务器总计最多 1000 份/512 MiB，保留约 30 天，达到上限时先清理旧报告。元数据索引避免查询列表时读取全部截图。读取和下载只允许管理员。Nginx 为该上传路径单独放开 8 MiB，其他 API 保持原有限额。

设置 `KUA_YIPU_DIAGNOSTIC_DIR` 为私有持久目录，Linux 目录权限 700、文件 600。systemd 将 `deploy/diagnostics.conf` 安装为最后加载的 `zz-diagnostics.conf`（防止安全配置重置可写目录）；Docker 需挂载持久卷。完整更新脚本包含该配置；增量部署使用 `deploy/update-diagnostics.sh`，备份并在检查失败时回滚。旧客户端升级后才有上传入口，不自动上传历史数据。

验证：`node --test test/diagnostics.test.js`、`node tools/diagnostic-desktop-qa.mjs`。覆盖隔离目录、实际 Electron IPC、断网重试、真实 HTTP 接收、后台截图/下载、清理与商品数据隔离和脚本注入防护。

## 在线更新管理（1.4.53 起）

登录后台后通过左侧“软件管理 → 系统更新”，上传正式安装包及构建生成的 `.exe.update.json`，填写标题和说明，保存草稿再正式发布。下方版本记录显示完整说明、状态、时间和大小，每条记录可编辑、发布、停止分发或下载。支持上传暂停和分块续传，只有管理员可写。侧栏分组可展开/收起，还可跳转新增授权、版本记录和新建公告；手机上菜单移到顶部。

官网也使用同一份正式版本信息与安装包。`/updates/chaodekuai/download` 是公开的当前正式版下载入口，在请求时选取最新已发布版并返回正确 EXE 文件名，支持 Range，禁止缓存。草稿不公开；撤回最高版本后停止下载，不回退旧版。系统更新页提供“查看官网”和“下载当前官网正式版”入口。官网按 IP 部署到 `/website/` 的操作见 [官网部署](../website/README.md)。

部署需配置 `KUA_YIPU_UPDATE_DIR` 和目录写权限，使用 `deploy/updates.conf`；Nginx 同时配置精确 `/api/admin/updates` 和前缀 `/api/admin/updates/` 路由，防止创建草稿的 POST 被 301 转为 GET。分块路由放行 5 MB 请求。完整说明和后台增量部署步骤见 [软件更新与部署](../docs/software-updates.md)。私钥只在构建电脑，不能上传到服务器。


## 批量授权管理

后台支持对当前有效授权批量延长、缩短有效期或停用。操作先调用预览，返回数量、可能到期数及短期有效的签名凭据，再确认应用。预览绑定管理员会话和授权集合指纹；人数或状态变化时要求重新预览，不能直接绕过校验。

生产实现使用事务、行锁和批次记录，避免同一批重试被重复执行；只处理未删除且当前有效的授权。操作写入审计事件，已有单账号授权和设备规则保持。涉及客户有效期，部署和普通测试不能自动执行真实批量操作。

接口为 POST /api/admin/licenses/bulk-preview 和 POST /api/admin/licenses/bulk，均需管理员鉴权。源码在 bulk-licenses.js、admin-bulk-licenses.js；隔离验证见 test/bulk-licenses.test.js 与 tools/admin-bulk-licenses-qa.mjs。增量部署工具为 deploy/update-bulk-licenses.sh，先审阅备份与回滚行为。

## 管理员修改账号密码与私有入口

登录后台后选择“系统设置 → 账号与密码”。验证当前密码后可修改自己的账号、新密码或两者；新密码两次输入必须一致，长度 12–128 位。只改账号时新密码留空。服务端保存带独立盐的 scrypt 哈希，在同一事务中修改并删除该管理员的全部会话。账号冲突、当前密码错误均不修改任何记录。保存后须重新登录，其他管理员及客户授权不受影响。

根路径 `/` 现在跳转 `/website/`，旧 `/admin.js`、`/admin.css`、`/admin-updates.js` 不再开放。开发预览默认入口为 `http://127.0.0.1:8790/admin/`，可用 `KUA_YIPU_ADMIN_PATH` 覆盖。开发环境修改后哈希持久化到开发状态文件，重启不会还原初始环境密码。

生产运行 `deploy/update-service.sh` 时，自动生成 128 位随机入口并保存 `/etc/kua-yipu/admin-entry.env`（root 600），systemd 的 `admin-entry.conf` 加载该配置。重复部署保留现有入口。首次安装也需以 root 执行 `bash auth-server/deploy/admin-entry.sh` 后 `systemctl daemon-reload` 并重启服务。Docker/直接运行需自行设置唯一 `KUA_YIPU_ADMIN_PATH`（单段路径，不得使用 api/website/updates/health）。仅管理员通过 SSH 查看配置并保存书签，不要把实际路径提交到 Git 或放在官网链接里。页面禁止索引且不发送 Referer，API 保持会话鉴权、HTTPS 和限流；随机路径不是额外密码。

忘记管理员密码时仍可按初始化说明显式执行 `bootstrap-admin.js`，只重置指定账号。例行部署不能执行它，否则会覆盖管理员自己设置的密码。修改账号后须使用新的账号名执行恢复。

验证：`node --test test/admin-account.test.js test/auth-dev.test.js test/auth-security.test.js`。指定 `AUTH_TEST_DATABASE_URL` 可在独立 `auth_qa_` 数据库上验证生产事务，测试不会使用生产数据库。
