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
