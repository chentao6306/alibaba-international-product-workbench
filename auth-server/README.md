# 跨易铺授权服务

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
