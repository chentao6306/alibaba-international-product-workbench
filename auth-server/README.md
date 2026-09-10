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

管理员接口使用 `Authorization: Bearer <token>`。客户端接口为 `/api/client/login` 和 `/api/client/heartbeat`。账号授权只匹配 Alibaba 登录账号；密码只在客户端本机通过 Windows DPAPI 加密保存，授权服务器不会接收或保存 Alibaba 密码。

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
