# 抄得快授权服务

授权服务部署在 Linux 服务器，生产环境必须使用 HTTPS、PostgreSQL 和随机的 `KUA_YIPU_AUTH_SECRET`（至少 32 个字符）。

```bash
export DATABASE_URL='postgres://user:password@db:5432/kua_yipu'
export KUA_YIPU_AUTH_SECRET='change-this-to-a-long-random-secret'
psql "$DATABASE_URL" -f auth-server/schema.sql
export KUA_YIPU_ADMIN_USERNAME='admin'
export KUA_YIPU_ADMIN_PASSWORD='change-this-admin-password'
node auth-server/bootstrap-admin.js
node auth-server/index.js
```

管理员接口使用 `Authorization: Bearer <token>`。客户端接口为 `/api/client/login` 和 `/api/client/heartbeat`。从 1.4.6 起，新账号还必须提交独立的软件授权码；Alibaba 密码只在客户端本机通过 Windows DPAPI 加密保存，授权服务器不会接收或保存 Alibaba 密码。

## 1.4.6 安全升级

当前生产入口为 `https://106.55.45.126:80/`。由于云端 443 尚未放通，Nginx 在已开放的 80 端口提供 HTTPS；证书正常校验，不允许忽略证书错误。浏览器访问旧 HTTP 管理地址会跳转到此入口。已有客户端的 HTTP 登录、心跳和公开公告接口暂时保留兼容，但启用了授权码的账号必须使用 HTTPS。当前配置是 `deploy/nginx-compatible-https.conf`，不要同时启用旧的站点配置。

新建账号会返回一次 `activationCode`，格式为 `CDK-` 加 43 位随机字符，数据库只保存哈希。`POST /api/client/login` 的请求包含 `username`、`deviceId`、`activationCode` 及可选设备描述。客户端第一次输入后加密保存，再次登录复用。令牌由服务器签名，绑定授权记录、设备及授权码版本，最长有效期 10 分钟，心跳重新检查实际授权状态。

旧账号为避免客户被突然退出，迁移后显示“授权安全待升级”。先让客户安装 1.4.6，再点击该账号的“启用授权码”，把仅显示一次的授权码交给该客户。尚未启用的旧账号仍保留账号名授权的风险；所有旧账号完成迁移后，才应删除 HTTP 客户端兼容入口。重置授权码会使旧授权码和旧会话失效，客户必须重新输入。续期不重置授权码；停用、注销和删除仍终止授权。

管理员令牌还必须对应数据库中的有效会话；退出登录会撤销该会话，修改管理员密码会使旧会话失效。管理接口只允许 HTTPS（本机直连例外用于测试和运维），登录限速、输入校验和参数化 SQL 持续生效。

生产服务使用独立的 Node.js 22.23.2 运行时。部署顺序如下，均以 root 执行；脚本适用于本项目现有 Ubuntu 服务布局，不应直接用于其他服务器：

1. `bash auth-server/deploy/prepare-runtime.sh`：校验官方 SHA256 后安装运行时。
2. 将源码及测试文件放到独立的 `/var/tmp/kua-yipu-security-qa-*` 目录，再在该目录运行 `PATH=/opt/kua-yipu-runtime/node-v22.23.2-linux-x64/bin:$PATH bash auth-server/deploy/security-qa.sh`：新建隔离 PostgreSQL 测试库，验证后自动删除，不对生产库运行攻击测试。每次使用新的暂存目录。
3. `bash auth-server/deploy/enable-runtime.sh isolated-tests-passed`：隔离测试通过后，备份并切换服务运行时。
4. `bash auth-server/deploy/update-service.sh`：备份代码和完整数据库、执行增量迁移、部署并检查健康状态；失败回滚代码，保留兼容的新增字段。
5. `bash auth-server/deploy/enable-compatible-https.sh`：备份并更新当前 Nginx 配置，验证新旧连接，失败回滚。

迁移新增 `licenses.credential_*` 和 `admin_sessions`。不要仅复制 `index.js`：`security.js`、`http-security.js`、`policy.js` 与管理界面也需要同步。环境文件和服务器私钥必须留在服务器，不能放进部署包或 Git。

SSH 已改为密钥登录，禁止 root 和密码登录。后续运维必须使用已授权私钥；添加其他管理员时先验证新密钥能登录，再调整访问配置。系统启用了安全源自动更新，但不自动重启。内核及部分系统组件更新后需要安排维护重启。具体检查结果、备份目录及安装包见 `../docs/security-1.4.6.md`。

## 1.4 升级

升级前备份数据库和服务目录。用数据库所有者执行 `schema.sql`，这是可重复执行的增量迁移；如果迁移使用 `postgres`，需给运行服务的数据库角色授予新建 `announcements` 表的 SELECT、INSERT、UPDATE、DELETE 权限。同步部署 `index.js`、`policy.js`、`admin.html`、`admin.js`、`admin.css`，保留原环境变量和签名密钥，再重启服务。检查 `/health`、账号列表和 `/api/announcements`。

原有和新增账号默认允许多端登录。关闭单个账号的多端开关后保留最近设备，之后另一台设备登录会替换原会话。过期、暂停、注销仍会阻止所有设备；续期不会改变多端设置。

后台账号和公告列表支持分页。公告可保存草稿、发布或撤回，类型为普通公告或弹窗公告。用户的公告入口显示未读红点，弹窗只在未读时出现；修改已发布公告会生成新版本并重新提醒。已读记录按账号保存在每台电脑本地，不随清理商品或图片而删除。公开接口仅返回已发布公告，请勿发布包含密码等私密信息的公告。

`node auth-server/dev.js` 提供本地 JSON 数据预览，接口与生产后台一致；它使用独立的 `.data/auth-dev.json`，不能用于正式部署。

## 1.4.2 升级

停止旧服务后，在事务中执行 `schema.sql`，再启动新版服务。此次迁移增加删除时间，并将账号唯一约束改为仅约束未删除的授权，迁移后不能直接启动旧版服务。回滚应使用升级前的数据库及服务目录备份。

授权支持减少天数，以原到期时间扣减，保留停用或注销状态；减少到当前时间之前立即成为过期授权。操作历史保存调整前后时间。删除账号后授权失效、设备记录清除，默认列表不显示，保留在“已删除”分类用于核查。重新添加同名账号会生成新的授权 ID，旧会话不能恢复。

统计分类可点击，状态支持多选（状态之间取并集），账号/备注、活动时间、多端策略与状态之间取交集。分页应用于筛选后的结果。“全部账号”不包含已删除记录。

普通和弹窗公告均支持永久删除。客户端登录、进入公告页或手动刷新时同步公告，在线客户端每分钟同步；被删除的公告和已读标记会移除。新版客户端每分钟检查授权，旧客户端仍按其原检查周期退出。

验证命令：`node --test test/auth-dev.test.js test/announcement-sync.test.js`；`node tools/admin-qa.mjs` 检查后台及客户端公告，并将截图写入系统临时目录；`node tools/desktop-package-qa.mjs <安装包输出目录>` 校验打包源码、版本和登录窗口。PostgreSQL 集成测试可设置 `AUTH_TEST_DATABASE_URL`，仅允许名称以 `auth_qa_` 开头的独立空测试数据库，先执行迁移并创建测试管理员 `test`（密码 `local-test-password`），不要连接生产数据库。
