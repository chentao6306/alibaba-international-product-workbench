# 抄得快官网

中文响应式官网，含产品功能演示、安装指南、常见问题、Windows 下载、更新说明和微信咨询。品牌素材来自项目；客服微信为 `Chen_Tao6306`，二维码由所有者提供，页面不显示电话。

官网地址：<https://106.55.45.126/website/>。现有部署统一使用 IP，后台、授权、公告与下载也使用该 IP；域名配置已经停用。保留 IP HTTPS 和自动续期。历史部署截图及运行记录不包含在源码快照中；新环境按下述步骤部署，并审阅目标 IP、目录与证书配置。

## 启动与构建

在项目根目录执行：

```powershell
npm ci
npm run website:dev
```

开发地址：`http://127.0.0.1:5175/website/`。

```powershell
npm run website:build
npm run website:preview
```

构建输出 `dist-website/`，成品预览 `http://127.0.0.1:4175/website/`。不改变桌面应用的 `dist/`，无需重新打包 EXE。只需修改文案或样式时修改 `website/src/`；客服信息在 `website/src/config.js`，二维码在 `website/public/wechat-qr.png`。

**本地预览**会读取 `release-installer/` 中与 `package.json` 版本一致的真实安装包及签名文件，检查签名、版本和大小，提供下载安装测试。未打包时显示暂无安装包。这仅用于本机验证，不代表该版本已经在生产后台发布。

## 后台统一管理安装包

官网与桌面端在线更新共用现有授权后台的版本目录，不在官网源码里写死版本号或 EXE 地址：

1. 后台进入“软件管理 → 系统更新”。
2. 上传正式 EXE 及同次构建生成的 `.exe.update.json`，填写更新标题与说明。
3. 等待分块上传和完整性校验完成，保存为草稿。
4. 在版本记录点击“正式发布”。官网新访客和下载弹窗自动读取该版本、文件大小与说明，软件内更新同时生效。
5. 后台停止分发最新版本后，官网显示暂无安装包；不会自动改为下载旧版本。新版本草稿不影响当前已发布版。

`GET /updates/chaodekuai/latest.json` 获取公开版本元数据。`GET /updates/chaodekuai/download` 在每次下载时重新选择最高版本号的正式版，用正确的文件名返回附件，支持 HTTP Range；即使访客长时间未刷新页面，也不会从固定旧文件地址下载。两者均 `Cache-Control: no-store`。发布说明按纯文本显示。

更新说明与版本信息无需重新构建官网；修改网站页面才需要重新构建。后台原有签名验证、上传校验与管理员权限继续使用。

## IP 与 HTTPS

服务器仅启用 `/etc/nginx/sites-enabled/kua-yipu`。原有隐藏管理员入口保持不变，仅使用 IP 作为主机地址；未登录的管理员 API 返回 401，`/admin` 等默认地址返回 404。实际管理员入口只配置在服务器，不提交版本库或出现在官网链接中。公告图片上传单独允许 8 MB，安装包分块上传单独允许 5 MB，其余 API 保留 128 KB 限制。证书位于服务器 `/etc/letsencrypt/live/106.55.45.126/`，不放入网站目录、构建产物或版本库。

保留现有管理员入口、客户端接口和历史端口兼容。80 端口沿用服务器已有 TLS 监听，用 497 错误处理普通 HTTP；不要单独将该共享端口改成纯 HTTP。官网与后台普通 HTTP 请求跳转到同一 IP 的 HTTPS，现有旧客户端兼容规则由 `auth-server/deploy/nginx-compatible-https.conf` 管理。

IP 证书有效期较短，必须保留 `snap.certbot.renew.timer` 自动续期及 Nginx 重载钩子。查看 `systemctl list-timers --all` 和 `journalctl -u snap.certbot.renew.service` 确认续期执行结果；部署后从外部验证证书 IP SAN、受信链和有效期。不要通过跳过 TLS 校验来掩盖续期故障。

## 原 IP 站点部署

官网部署到与授权后台**同一来源**的 `/website/`，例如 `https://服务器IP/website/`。需使用覆盖该 IP 的有效 HTTPS 证书。沿用原有后台 HTTPS 配置，不另开开发端口供客户使用。

1. 执行 `npm run website:build`，将 `dist-website/` **内部文件**复制到服务器 `/var/www/chaodekuai-website/`。不要上传浏览器配置、`.data`、环境变量、源码私钥或整个开发目录。
2. 先按 `auth-server/README.md` 运行 `deploy/update-service.sh` 部署完整配套后台，不要只替换个别页面文件；数据库和授权数据无迁移。
3. 将 `website/deploy/nginx-location.conf` 放到服务器，在现有 HTTPS `server` 块中 `include` 此文件。已有 `/` 后台入口和 `/updates/chaodekuai/` 代理继续使用。
4. 执行 `sudo nginx -t`，通过后 `sudo systemctl reload nginx`。
5. 打开 `https://服务器IP/website/`，核对官网、微信二维码、后台入口、当前版本说明和下载。

例如服务器目录已准备好时，Windows PowerShell 上传静态产物：

```powershell
scp -r dist-website/. 用户名@服务器IP:/var/www/chaodekuai-website/
```

生产服务器上验证固定下载入口（有正式版时应为 200，暂无或撤回时为 404）：

```sh
curl -I https://服务器IP/updates/chaodekuai/download
curl https://服务器IP/updates/chaodekuai/latest.json
```

网页更新前保留上一份静态产物；回滚时恢复旧产物和本次备份的后台文件、Nginx 配置，并在配置校验通过后重载。不要回滚客户数据或更改现有版本目录。

本项目当前服务器也可使用 `website/deploy/install.sh`：部署包保留 `dist-website/`、`website/deploy/` 结构，将包解压到服务器独立暂存目录后执行 `sudo bash 暂存目录/website/deploy/install.sh`。脚本针对现有 `kua-yipu-auth` 服务与 Nginx 站点配置，自动备份、切换静态目录、等待健康检查，失败会回滚；其他服务器需先审阅路径。不会携带或读取 SSH 密码。

## 验证

```powershell
node --test test/website-release.test.js test/software-updates.test.js
npm run website:build
npm test -- --test-concurrency=2
```

自动测试覆盖公开下载的草稿隔离、正式发布切换、撤回、断点范围与文件名，以及官网元数据解析和异常下载地址拒绝。界面需检查桌面/手机布局、功能切换、菜单、FAQ、下载、版本说明和二维码弹窗。功能演示使用标明的示例数据，不读取客户商品资料。
