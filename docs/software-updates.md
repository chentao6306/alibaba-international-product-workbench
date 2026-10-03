# 软件在线更新（1.4.53 起）

客户在“设置 → 软件更新”查看当前版本和更新说明，点击“检查更新”“下载更新”“退出并安装更新”。启动后 15 秒及每隔 4 小时检查一次，只检查，不自动安装。1.4.52 及更早版本需要手动安装一次新版。便携版只支持查看和下载，在线安装需要安装版。

## 管理员发布

1. 提升 `package.json` 和 `package-lock.json` 的版本号，运行 `npm test`。
2. 运行 `npm run dist:win:installer`。输出在 `release-installer`，可设置 PowerShell 环境变量 `$env:CHAODEKUAI_RELEASE_DIR='E:/build/chaodekuai'` 指定构建目录。
3. 打包同时生成 `chaodekuai-版本-setup.exe` 和 `.exe.update.json`。**只分发这两个文件**，`inner.exe` 是内部 NSIS 文件，不能单独使用。
4. 打开原授权管理后台，进入“系统更新”，选择 EXE 和配套签名文件，填写标题和更新说明，点击“上传并保存草稿”。
5. 完整上传和校验后，点击“正式发布”。客户可检查更新，下一次自动检查也会发现新版。
6. 说明可随时编辑保存；“撤回版本”停止分发和安装该版本，不会卸载客户已安装的软件。撤回最新版本后不会向客户推荐更旧版本；修复时提高版本号再发布。

安装包按 4 MB 分块上传。关闭网页、断网、服务器重启后，重新选择相同两个文件可继续上传；只有校验完且正式发布的版本能下载。相同版本不能换另一个 EXE，必须提升版本号。更新标题与说明按纯文本显示。

## 下载与安装中断

- 下载时继续运行任务；退出软件保留 `.part` 文件，重新打开并检查后可续传。下载完成与安装前分别校验签名、大小和 SHA-256。
- 安装前有任务执行、图片处理或保存请求时拒绝安装。请先保存编辑内容，并等待任务完成或暂停；软件不会为了更新强行中断一次商品提交。
- 安装程序就绪后桌面程序才退出；安装独立继续，不依赖桌面进程。完成后自动打开新版，未完成任务由用户确认继续。
- 在线安装先复制并校验旧版程序，恢复副本位于 `%LOCALAPPDATA%/chaodekuai-update-recovery`。安装报错会尝试恢复；断电、强制结束安装程序后，**重新运行已下载的同一安装包**会先恢复，再安装。安装包在 `%APPDATA%/alibaba-international-product-workbench/updates` 中以 SHA-256 命名，也可重新取得公开安装包。不要在恢复前清理该目录。
- 恢复仅覆盖程序文件，不读写商品数据库、媒体、模板、设备授权或卖家会话。业务数据继续位于原 `userData` 目录。安装磁盘空间不足时先报错，不卸载旧版。
- 恢复副本不能保证抵抗磁盘硬件故障；安装失败后保留安装日志，位于安装包旁的 `chaodekuai-install-logs` 或 `%LOCALAPPDATA%` 下同名目录。

## 签名与私钥

使用 Ed25519 签名。客户端与后台只包含公钥，私钥不提交 Git、不上传服务器。默认私钥位置为工作区忽略目录 `.data/chaodekuai-update-private.pem`，可用 `CHAODEKUAI_UPDATE_SIGNING_KEY` 指定安全备份路径。本机另有 `E:/ChaodekuaiPrivate/chaodekuai-update-private.pem` 备份，目录限制为当前 Windows 用户访问。**维护者必须保留该私钥的安全备份；不能随意重新生成，否则已安装客户端拒绝新安装包。** 私钥缺失时构建签名步骤失败。

`npm run update:sign -- <EXE绝对路径> <版本号>` 可重新生成配套签名文件。签名文件必须与安装包逐字节对应。

## 服务器

沿用 HTTPS 授权服务器和管理员会话，不增加公开写接口。

- 客户：`GET /updates/chaodekuai/latest.json`，已发布 EXE 支持 Range 续传。
- 管理：`/api/admin/updates`，所有写操作和列表都要求管理员会话。
- 数据：`KUA_YIPU_UPDATE_DIR=/var/lib/kua-yipu/updates`，需由 `kua-yipu` 用户写入，随更新包一起备份 `releases.json`。
- 部署：`auth-server/deploy/update-service.sh` 会备份现有服务和数据库、更新源码、设置更新目录写权限、重启并检查健康；失败恢复源码。`deploy/updates.conf` 放入 systemd 服务覆盖目录。
- Nginx：只给 `/api/admin/updates/` 设置 5 MB 请求限制和 120 秒上游等待；分块请求不需要放开全站大文件上传。`node tools/deploy-updates.mjs /etc/nginx/sites-available/kua-yipu` 可添加对应段，然后 `nginx -t && systemctl reload nginx`。保留原 HTTPS、鉴权反向代理与证书配置。

更新包会占用服务器磁盘。版本记录上限 200 个；归档历史包时保留当前发布版、目录元数据和备份。
