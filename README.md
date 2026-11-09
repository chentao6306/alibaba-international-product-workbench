# 抄得快 · 阿里巴巴国际站商品工作台

**源码版本：1.4.100｜分支：`codex/1.4.100`｜交接日期：2026-11-09｜发行状态：候选版**

这是 Windows 桌面商品采集、编辑和发布系统的完整源码快照，包括 React 工作台、本地业务服务、Electron 桌面端、授权管理后台、官网、SQL 结构、构建工具和自动测试，用于继续开发、排障和复现构建。

版本分支使用独立根提交，不继承历史运行资料。商品库、后台用户数据、诊断报告、客户截图、登录会话、API 密钥、签名私钥和安装包均不随仓库分发。测试目录保留构造数据和模拟凭据；类目目录是程序所需的静态定义，不是客户商品库。

**交给 Claude 时先阅读 [CLAUDE.md](CLAUDE.md)、[1.4.100 改动与验收](docs/release-1.4.100.md) 和 [完整开发交接](docs/claude-handoff-1.4.98.md)。** 已有部分真实消费电子链路验证；本次重名 SKU 修复有客户诊断重放和浏览器模拟证据，玩具及医疗类目的真实发布和回读仍有验收缺口，不能把本分支理解为所有客户问题已经解决。

1.4.100 按来源选项编号恢复名称相同但实际不同的规格，避免旧版按名称覆盖后报“SKU 转换后出现重复规格组合”。所有 SKU 的价格、库存、编码和图片分别保留，采集、历史资料重开及发布均使用同一规则；详见 [本次修复及限制](docs/release-1.4.100.md)。

2026-11-09 源码补丁补充了批量引用期间的服务响应、空闲状态读取的桌面桥接阻塞修复、进度轮询恢复、自定义属性长名称修复，以及受限账号的详情格式兼容、视频素材库入口识别和透明图片白底上传。详见 [本地服务检查](docs/local-service-reliability-2026-11-09.md)、[长名称修复](docs/custom-attribute-name-2026-11-09.md) 与 [详情和媒体实测](docs/description-compatibility-2026-11-09.md)。这些修改尚未纳入此前交付的 1.4.98 安装包；不要用同一版本号覆盖旧包。

## 目录

1. [系统能力](#系统能力)
2. [架构与目录](#架构与目录)
3. [开发环境与启动](#开发环境与启动)
4. [配置与数据位置](#配置与数据位置)
5. [采集到上架的完整链路](#采集到上架的完整链路)
6. [规则模式与 AI 辅助](#规则模式与-ai-辅助)
7. [本地接口](#本地接口)
8. [授权后台与官网](#授权后台与官网)
9. [测试与真实验收](#测试与真实验收)
10. [打包和在线更新](#打包和在线更新)
11. [故障排查](#故障排查)
12. [维护约束](#维护约束)

## 系统能力

- 从国际站店铺、单个详情页及以图搜品结果链接采集；另有 1688、速卖通、中国制造网适配，各平台可读字段和能力不同。
- 保留原始来源快照，编辑标题、类目、属性、规格、SKU、价格、库存、包装、物流、图文和视频；支持分组、批量修改、水印、文字替换和模板。
- 按当前国际站叶类目及真实发布表单映射属性，处理新旧详情、主图、规格图、图集、FAQ、视频、价格和交期。
- 保存草稿、正式提交、暂停/继续任务、失败项重试及引用成功商品资料。提交成功与平台审核通过分别记录。
- 默认规则处理，可选 DeepSeek 或 OpenAI 辅助资料整理和属性映射。
- 独立后台提供账号授权、批量续期/减期/停用、公告、更新包管理和客户诊断报告管理。

## 架构与目录

```text
React 工作台 (src/)
    │ 本机 HTTP API / Electron preload IPC
Electron 主进程 (electron/)
    ├─ 登录、授权租约、加密凭据、验证码、在线更新
    └─ 本地服务进程 (electron/local-service.js)
          └─ Express API (server/index.js)
               ├─ JsonStore / 原始快照 / 媒体 / 任务断点
               ├─ 采集、编辑、类目映射、引用资料
               └─ Playwright + Chromium → 国际站发布表单

独立 Linux 服务 (auth-server/)
    ├─ Express + PostgreSQL：账号、授权、管理员、审计
    ├─ 文件目录：更新包、公告图片、诊断报告
    └─ Nginx HTTPS ← 桌面客户端与官网 (website/)
```

| 路径 | 职责 |
| --- | --- |
| `src/App.jsx` | 工作台入口、页面切换、状态读取、任务和设置 |
| `src/ProductEditor.jsx`、`src/product-editor-model.js` | 商品编辑与模型 |
| `src/PublishPageView.jsx`、`src/ReferenceDialog.jsx` | 上架状态、失败反馈、引用预览和保存 |
| `src/local-api.js`、`src/state-refresh.js` | 超时、连接状态、并发刷新与旧响应处理 |
| `server/index.js` | 本地 API、任务调度和模块组合 |
| `server/collector.js`、`server/alibaba-source-data.js` | 列表采集、详情解析及来源信息 |
| `server/product-model.js`、`server/store.js` | 原始快照、编辑数据、持久化与任务状态 |
| `server/publisher.js` | 国际站发布主流程、字段填写和结果核验 |
| `server/category-*.js`、`server/attribute-*.js` | 类目路由、实时字段定义、属性映射及转移核验 |
| `server/sku-*.js` | 规格维度、引用映射和逐 SKU 商务资料 |
| `server/structured-description*.js`、`server/native-description-fields.js` | 新版详情、图集、原生模型与接收校验 |
| `server/description-mode.js`、`server/description-compatibility.js` | 来源格式优先、无新版入口时的完整图文兼容、提交模型核验 |
| `server/posting-*.js` | 点击、语言、物流、销售单位、视频等发布控件 |
| `server/ai-*.js`、`server/secure-settings.js` | 模型辅助、服务可用性与密钥保存 |
| `electron/main.js`、`electron/preload.cjs` | 桌面入口、IPC、登录和本地服务生命周期 |
| `auth-server/` | 独立后台、管理网页、SQL、Dockerfile 和部署脚本 |
| `website/` | 官网源码、公开品牌素材及部署配置 |
| `tools/` | 构建、签名、隐私检查、离线及真实账号验收工具 |
| `test/` | Node 测试及本地浏览器夹具 |
| `build/SetupBootstrap.cs`、`build/installer.nsh` | 安装引导器和 NSIS **源码**，构建必须保留 |
| `assets/`、`public/` | 程序图标、品牌资源 |

`dist/`、`dist-website/`、`.packaged/`、`release*/`、`vendor/chromium/`、`node_modules/` 是生成或下载内容，不进入源码分支。

## 开发环境与启动

推荐 Windows x64、Node.js **22.18 或更新的 22 LTS 版本**及 npm。发行保护加载器依赖较新的 Node 模块 API。实际依赖以 `package-lock.json` 为准，接手时不要直接整体升级 Electron、Playwright 或 Vite。

```powershell
git clone --branch codex/1.4.100 --single-branch git@github.com:chentao6306/alibaba-international-product-workbench.git
cd alibaba-international-product-workbench
npm ci
node node_modules/playwright-core/cli.js install chromium
npm run prepare:chromium
```

`playwright-core` 不会在 `npm ci` 后自动下载浏览器。`prepare:chromium` 从对应版本缓存复制到 `vendor/chromium/`，会替换该目标目录；不要让它指向唯一的运行资料或其它项目目录。

依赖下载需要访问锁文件中的 npm 镜像、SheetJS CDN 和 Electron 下载源。2026-11-07 交接时独立安装遇到 SheetJS 下载连接中断，随后使用本机已有且直接依赖版本与锁文件一致的环境完成构建和专项验证；不把这次检查记为全新网络安装成功。遇到同类错误先检查下载连接，不随意改用旧版 `xlsx` 或删除锁文件。

浏览器开发：

```powershell
npm run dev
```

Vite 默认 `http://127.0.0.1:5173`，本地 API 默认 `http://127.0.0.1:8787`；Vite 将 `/api` 代理给 API。开发数据默认在仓库 `.data/`，不会自动带入客户资料。

Electron 桌面：

```powershell
npm run build
npm run desktop
```

桌面登录、Windows 凭据加密、验证码和 IPC 需要 Electron 环境。`npm run desktop:dev` 同时启动开发服务与 Electron；桌面主进程有自己的本地服务及数据目录，不能假设它与浏览器开发窗口连接同一工作区。先构建 `dist/`，核对实际入口与端口。

本机授权后台预览见 [后台 README](auth-server/README.md#本机预览与测试)。未打包桌面可用 `KUA_YIPU_AUTH_URL=http://127.0.0.1:8790` 指向本机后台；正式客户端采用源码中的固定 HTTPS 入口。

| 操作 | 命令 |
| --- | --- |
| 工作台构建 / 已构建网页服务 | `npm run build` / `npm start` |
| 桌面启动 | `npm run desktop` |
| 完整串行回归 | `npm test -- --test-concurrency=1` |
| 官网开发 / 构建 / 预览 | `npm run website:dev` / `npm run website:build` / `npm run website:preview` |
| Windows 完整安装包 | `npm run dist:win:installer` |
| Windows 便携包 | `npm run dist:win:portable` |

## 配置与数据位置

| 配置 | 用途与边界 |
| --- | --- |
| `DATA_DIR` | 独立本地 API 工作区；默认 `.data/`，测试使用隔离目录 |
| `PORT` | 独立本地 API 默认 8787，授权后台默认 8790，分终端配置 |
| `KUA_YIPU_AUTH_URL` | 未打包桌面授权服务覆盖，生产包不接受任意覆盖 |
| `KUA_YIPU_CHROMIUM_SOURCE` | 构建时 Chromium 来源目录 |
| `CHAODEKUAI_RELEASE_DIR` | 完整安装器输出，默认 `release-installer/` |
| `CHAODEKUAI_UPDATE_SIGNING_KEY` | 更新私钥文件路径，由维护者私下提供 |
| `TEMP` / `TMP` | 测试和打包临时目录，可指向空间充足的磁盘 |

Electron 业务数据位于 `app.getPath('userData')/.data/`，Windows 常见位置是 `%APPDATA%/alibaba-international-product-workbench/.data/`。卖家会话及加密登录文件在 `userData` 内，更新缓存位于 `updates/`。开发服务和安装版数据不能直接互相覆盖。

本地使用 JSON 持久化，PostgreSQL 只用于独立授权后台。`workspace.json`、媒体、任务、模板和原始快照需要一起维护。密钥、会话使用专用安全存储，不放进商品 JSON 或 Git。Windows 加密凭据不保证跨用户、跨电脑可恢复。

默认服务地址见 `server/auth-endpoint.js`；改变部署目标还需核对后台、官网同源路由、TLS、公钥和已安装客户端兼容性。

## 采集到上架的完整链路

1. **入口和列表**：识别平台与链接，建立分组任务，保存发现的商品和分页断点。
2. **详情读取**：正式采集入口处理语言和验证恢复，保留原始属性 ID、原文、规格、图文、媒体及公开商务资料。没有公开逐 SKU 价格/库存时标记不可用。
3. **保存和编辑**：原始 `source` 与编辑模型分离，保存后重开保留用户编辑；发布准备不覆盖原始资料。
4. **目标类目**：按精确叶类目和实时表单识别字段类型、选项、必填、单位及依赖；账号经营类目限制单独报告。
5. **填写和核验**：属性、自定义字段、规格、SKU 商务值、图片、详情、物流和视频分别处理，依赖控件变化后重新读取实际值。
6. **草稿和提交**：只有平台回执才能确定结果；操作结果未知、连接中断和审核中不等于可以重复提交。
7. **持久化回读**：重新打开草稿或已发布商品核对保存内容。填写、保存、提交、审核通过、内容完整是不同阶段。

引用资料流程是“选择来源 → 选择范围 → 预览差异 → 引用并保存”。预览与保存必须针对同一输入；改来源或目标后重新预览。完整模板会改变规格组合，不可把其它商品的型号、用途或物流当成本商品事实。实现见 `reference-workflow.js`、`publish-reference.js`、`sku-reference.js` 和 `src/reference-request.js`。

新旧详情按来源和当前表单能力处理。不能为了通过校验悄悄删除 FAQ、图片或第二段视频，也不能在无入口时把丢失内容记成成功。

## 规则模式与 AI 辅助

默认配置在 `server/ai-product-settings.js`：`mode: 'rules'`，提供商默认 DeepSeek；当前源码模型默认值为 `deepseek-flash` 和 `gpt-4o-mini`，可在设置中修改，实际可用性由服务决定。

设置页可切换规则/辅助模式，分别启用采集资料整理与发布属性映射。DeepSeek、OpenAI 密钥分开保存，自动测试用模拟服务。

AI 必须基于来源证据和当前叶类目选项，不能创造产地、重量、用途、医疗功能、认证或价格；结果仍经规则和真实控件回读检查。鉴权、额度、网络或模型故障与商品缺资料分开处理，已有失败退避避免逐字段重复等待。默认规则流程必须独立可用，开启 AI 不能代替修复共同链路。

## 本地接口

这些是本机接口，不应直接开放公网。桌面进程设置访问校验和授权上下文；请求结构以 `server/index.js` 和相邻测试为准。

| 接口 | 用途 |
| --- | --- |
| `GET /health` | 本地 API 存活 |
| `GET /api/state`、`GET /api/products/:id` | 状态摘要、商品详情 |
| `POST /api/collect/links` | 单商品采集 |
| `PATCH /api/products/:id`、`POST /api/products/batch-update` | 编辑、批量修改 |
| `POST /api/products/:id/refresh-detail` | 主动重新采集详情 |
| `GET/POST /api/publish/plan` | 类目与任务计划 |
| `POST /api/publish` | 创建草稿或提交任务 |
| `POST /api/jobs/:id/pause`、`resume`、`cancel` | 暂停、继续、取消 |
| `POST /api/products/reference/preview`、`POST /api/products/reference` | 引用预览、应用 |
| `GET/PATCH /api/settings/ai-products` | 模型配置 |
| `POST /api/settings/ai-products/test` | 测试已保存连接 |

## 授权后台与官网

后台全部可维护源码在 `auth-server/`。它与桌面的 `server/` 是两个不同服务；更新桌面不会自动更新远端后台。

| 模块 | 用途 |
| --- | --- |
| `index.js` / `dev.js` | PostgreSQL 生产入口 / 本机 JSON 预览 |
| `schema.sql` / `bootstrap-admin.js` | 数据库结构 / 首次管理员初始化或显式重置 |
| `admin.html`、`admin.js`、`admin-*.js` | 管理页面 |
| `security.js`、`http-security.js`、`policy.js`、`admin-account.js` | 授权、安全与管理员账号 |
| `bulk-licenses.js` | 批量授权预览与应用 |
| `diagnostics.js`、`diagnostic-schema.js`、`diagnostic-evidence.js` | 报告接收、脱敏、证据 |
| `updates.js`、`update-protocol.js`、`update-key.js` | 签名更新包、分块上传、发布管理 |
| `announcement-images.js`、`announcement-content.js` | 公告图文 |

后台依赖由根包和锁文件管理。生产需 PostgreSQL、私有签名密钥、HTTPS 和持久目录。`.env.example` 只给格式，程序不自动加载 `.env`，应通过系统环境或 systemd 配置。

安装、迁移、Docker、备份、诊断和批量授权见 [后台 README](auth-server/README.md)。部署脚本含固定路径和服务名，应按环境审阅；`bootstrap-admin.js` 会重设同名管理员密码，例行更新不要执行。

官网独立构建到 `dist-website/`，部署于 `/website/`，从后台公开接口获取版本和安装包，详见 [官网 README](website/README.md)。源码提交不执行生产部署或客户更新发布。

## 测试与真实验收

```powershell
npm test -- --test-concurrency=1
node --test test/publish-late-receipt.test.js test/posting-interaction.test.js test/structured-upload-entry.test.js
node --test test/cross-category-attributes.test.js test/sku-dimensions.test.js test/attribute-transfer.test.js
node --test test/local-service.test.js test/reference-scale.test.js test/state-refresh.test.js
```

使用 Node 内置 `node:test` 和 `assert/strict`，部分测试启动 Chromium、Electron 或临时服务。资源有限时串行运行，完整回归可能超过半小时。PostgreSQL 集成测试只使用 `AUTH_TEST_DATABASE_URL` 指向名称为 `auth_qa_` 前缀的隔离库，不能用生产库。

**1.4.100 当前改动与验收见 [版本记录](docs/release-1.4.100.md)。以下为 1.4.98 历史验证基线（2026-11-06）：**

| 项目 | 结果与范围 |
| --- | --- |
| 最终完整源码回归 | 986/986 通过，无失败、取消或跳过，约 34 分钟 |
| 实际保护归档 | 116 个不同用例通过，包含其它组 109 项及延迟接收组复跑 7 项 |
| 构建和安装器 | 构建、实际 EXE 启动、载荷、签名、归档及隐私检查通过 |
| 跨类目故障注入 | 医疗、消费电子、文具、塑料瓶、服装、灯具、鲜花共用控件隔离通过 |
| 真实消费电子 | 采集、保存/重开、编辑、草稿及草稿回读通过；一次正式提交获回执，最后检查仍在审核中 |
| 真实医疗 | 属性、规格、自定义属性、主图控件检查通过；账号类目权限限制，草稿/提交/回读未完成 |
| 双视频等媒体全链路 | 本轮真实消费电子测试关闭视频，不能作为双视频验收 |

首轮并行/包内测试曾出现时序超时，最终串行和相关组复跑通过，详见 [交接说明](docs/claude-handoff-1.4.98.md)。含客户资料的原始报告私下保管，不上传源码。

### 真实验收工具

`tools/` 部分程序会真实发布、部署或清理数据，**不要遍历执行全部工具**。先检查注释、环境参数、目标和副作用。

| 工具 | 阶段 |
| --- | --- |
| `product-source-fidelity-qa.mjs` | 正式采集入口与来源记录 |
| `source-persistence-chain-qa.mjs` | 来源副本保存、编辑、重开 |
| `publish-performance-live-qa.mjs` | 草稿及阶段耗时 |
| `draft-readback-live-qa.mjs` | 只读重开已确认草稿 |
| `batch-publication-live-qa.mjs` | 依赖验证草稿的真实提交 |
| `batch-readback-live-qa.mjs` | 提交后的只读回查 |
| `medical-unsaved-form-qa.mjs` | 拦截保存/提交的医疗控件探针，不代表发布验收 |
| `live-desktop-qa.cjs` | 提供 Electron 本机安全存储环境 |

上述文件均在 `tools/`。参数可能包含 `QA_OUTPUT_DIR`、`QA_DESKTOP_USER_DATA_DIR`、`QA_EXPECTED_ACCOUNT`、`QA_SOURCE_IDS`、`QA_DRAFT_DIR`，以各脚本为准。真实输出在仓库外，每次新建证据目录，未知结果先回查，审核中不重复提交。

## 打包和在线更新

完整 Windows 安装器需要 Chromium、Electron、Windows C# 编译器和现有更新签名私钥；源码不含私钥。

```powershell
$env:CHAODEKUAI_RELEASE_DIR='D:/builds/chaodekuai-1.4.100'
$env:CHAODEKUAI_UPDATE_SIGNING_KEY='D:/private/update-signing-key.pem'
npm run dist:win:installer
node tools/desktop-package-qa.mjs D:/builds/chaodekuai-1.4.100
node tools/protected-package-qa.mjs D:/builds/chaodekuai-1.4.100/win-unpacked
```

对外文件为 `chaodekuai-1.4.100-setup.exe` 与同次构建的 `.exe.update.json`。`inner.exe`、`win-unpacked/`、`.packaged/` 是中间产物，不作为客户更新组合。签名与 EXE 必须匹配，更换现有签名密钥会使已安装客户端拒绝更新。

打包会保护业务模块并混淆前端入口，源码测试不能替代包内测试。详见 [源码保护](docs/source-protection.md) 与 [在线更新](docs/software-updates.md)。同一正式版本不能替换另一份 EXE，修复后需提升版本号。

后台上传两文件并保存草稿，验收完成后再正式发布。**1.4.100 仍为候选版，尚未完成各客户类目的真实验收。**

## 故障排查

| 现象 | 优先检查 |
| --- | --- |
| 本地服务停止/超时 | 主进程和服务进程、端口、诊断、磁盘、工作区规模和请求耗时；网络正常不代表本地服务正常 |
| 引用预览后不能保存 | 预览响应、目标集合变化、校验 token、旧响应覆盖及实际差异；不要取消预览校验 |
| 属性缺失/未完整接收 | 来源 ID/原值、实时叶类目、控件类型/单位/依赖、原生和自定义值，区分未采到与未填入 |
| “类型”结果未知 | 点击是否派发、同一控件是否出现目标值、是否重挂载；不要连续补点击 |
| 图片控件超时 | 主图/规格/详情/公司图集具体阶段、FileList 或图集回执、尺寸体积、已接收数量；不要整组无条件重传 |
| 页面操作未完成 | 阶段和错误码；保存/提交未知时先回查，不能只看简短客户提示 |
| FAQ/新版详情失败 | 来源结构、当前模式、编辑器加载、原始文本和容量 |
| AI 慢或不可用 | 鉴权/额度/模型、阶段耗时、调用次数、退避，并对照规则流程 |
| 安装访问被拒绝 | 权限、旧进程占用、空间、恢复副本和安装日志，保留商品资料 |
| 类目不在线上经营范围 | 用具备该叶类目权限的账号验收，不能错类目发布 |

诊断入口在 `server/runtime-diagnostics.js`、`server/publish-diagnostics.js`、`electron/diagnostics.js`、`auth-server/diagnostics.js`。上传日志会含排障用商品资料，只在授权后台处理，不复制到源码或公开 issue。

## 维护约束

- 阅读 [AGENTS.md](AGENTS.md)，沿用 ES modules、两空格缩进及附近风格；没有额外 formatter/linter。
- 跨类目修改必须验证来源、编辑、映射、原生接收和平台持久化。消费电子通过不能替代医疗等其它品类。
- 不删除资料、不替换真实值、不改错类目、不吞掉错误来提高成功率；无来源证据的事实不编造。
- 超时不证明操作未生效。先读已有结果，避免重复新增属性、重复上传和重复提交。
- `.gitignore` 之外仍需审阅实际提交清单；保留源码、测试、锁文件，排除运行资料与凭据。
- 接手顺序及待办见 [交接说明](docs/claude-handoff-1.4.98.md)，归档范围见 [源码记录](docs/release-1.4.98-source.md)，数据恢复见 [备份与恢复](docs/stable-backup.md)。
