# 抄得快 · 阿里巴巴国际站商品工作台

当前源码版本：**1.4.92**。源码分支：**`codex/1.4.92`**。整理日期：**2026-10-30**。

此分支是当前系统的独立源码快照，包含桌面客户端、采集与发布服务、授权管理后台、官网、数据库结构、部署脚本及自动测试。分支不继承旧提交，不包含商品库、后台用户数据、运行日志、浏览器会话、密钥、客户截图或安装包。本地业务数据与既有分支保持原状。

## 目录

| 目录 | 内容 |
| --- | --- |
| `src/` | React 工作台、采集任务、商品编辑、发布、设置及日志上传界面 |
| `server/` | 本地 Express API、持久化、各平台采集、类目与属性映射、发布、图片和视频处理 |
| `electron/` | 桌面主进程、登录、安全存储、本地服务管理、在线更新及预加载桥接 |
| `auth-server/` | 授权与管理员后台、公告、安装包更新、诊断报告接收、SQL 结构和服务端部署脚本 |
| `website/` | 官网源码、公开品牌素材及 Nginx 部署配置 |
| `tools/` | 构建、签名、打包、备份、部署和自动验收工具源码 |
| `test/` | Node 自动测试及测试中使用的人工构造样例 |
| `assets/`、`public/` | 应用图标、品牌素材 |
| `build/` | 安装引导程序与 NSIS 脚本源码；不含编译产物 |
| `docs/` | 构建、更新、备份及本次源码范围说明 |

## 开发准备

使用 Node.js **22.18 或更新的 22 LTS 版本**、npm，以及 Windows 桌面构建环境。项目以根目录的 `package.json` 和 `package-lock.json` 管理全部依赖；授权后台不另设锁文件。

```powershell
git clone --branch codex/1.4.92 --single-branch git@github.com:chentao6306/alibaba-international-product-workbench.git
cd alibaba-international-product-workbench
npm ci
node node_modules/playwright-core/cli.js install chromium
npm run prepare:chromium
```

Chromium、依赖和构建产物由上述命令准备，不放入 Git。真实授权信息、API 密钥及会话通过本机配置或软件设置提供。

## 常用命令

| 操作 | 命令 | 说明 |
| --- | --- | --- |
| 前后端开发 | `npm run dev` | Vite 界面与本地 API |
| 构建工作台 | `npm run build` | 输出 `dist/` |
| 桌面开发 | `npm run desktop:dev` | 同时启动开发服务与 Electron |
| 启动已构建桌面版 | `npm run desktop` | 先执行工作台构建 |
| 启动浏览器版 | `npm start` | 先构建，访问 `http://127.0.0.1:8787` |
| 全部自动测试 | `npm test` | 部分测试使用 Chromium 和隔离的临时目录 |
| 降低测试并发 | `npm test -- --test-concurrency=2` | 适用于资源较少的机器 |
| Windows 完整安装包 | `npm run dist:win:installer` | 默认输出 `release-installer/chaodekuai-1.4.92-setup.exe` |
| Windows 便携包 | `npm run dist:win:portable` | 默认输出 `release/` |
| 官网开发 | `npm run website:dev` | 独立官网开发服务 |
| 官网构建 | `npm run website:build` | 输出 `dist-website/` |
| 官网预览 | `npm run website:preview` | 预览官网构建结果 |

## 后台与部署

授权服务全部可维护源码在 `auth-server/`，包括 `index.js`、管理页面、诊断模块、更新模块、`schema.sql`、Dockerfile 和 `deploy/`。生产数据库内容不在源码中。

新环境参考 [授权后台部署说明](auth-server/README.md)。使用 `auth-server/.env.example` 创建环境配置，并自行设置数据库连接、授权签名密钥和管理员密码。示例仅含占位符；真实配置留在服务器，不提交 Git。生产更新前先备份并在隔离环境验证 SQL 与配置，不能把开发测试库覆盖到生产库。

官网部署参考 [官网说明](website/README.md)。已有服务器配置内的 IP、服务名、目录及证书路径需要按目标环境审阅。

## 安装包与更新签名

完整安装包同时产生 EXE 与 `.exe.update.json`；正式发布时必须使用同次构建的一对文件。现有客户更新依赖既有更新签名私钥，私钥通过本机 `CHAODEKUAI_UPDATE_SIGNING_KEY` 配置，源码只含校验公钥。不要为现有客户随意更换签名密钥。

源码提交不会自动发布客户端更新、部署授权后台或上传安装包。流程见 [软件在线更新](docs/software-updates.md) 与 [发行源码保护](docs/source-protection.md)。

## 数据边界与测试

- 商品、任务断点、图片、视频、模板、授权信息和浏览器会话由运行时保存到本机数据目录。
- 后台账号、授权记录和诊断内容由服务端数据库或配置的数据目录保存。
- `.env`、数据库备份、私钥、运行日志、客户截图、缓存和安装产物不进入此源码分支。
- `test/` 中的测试账号、伪密钥及人工构造商品用于隔离回归，不是客户数据库导出；真实账号验收脚本需要维护者自行配置环境。
- 自动测试通过不等于全部类目及客户环境均验收通过。真实发布应先保存草稿，并按目标类目核对属性、规格、价格、详情、图片、视频和平台保存结果。

本次快照的完整性与验证范围见 [1.4.92 源码记录](docs/release-1.4.92-source.md)。数据备份工具的使用见 [备份与恢复](docs/stable-backup.md)。

