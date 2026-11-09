# 1.4.98 开发交接

日期：2026-11-07。交接代码与已知证据，不含客户原始资料、日志、登录账号或商品清单。发行状态仍为候选版。

2026-11-09 源码增量：修复空闲轮询时同步等待桌面状态阻塞 API、批量引用同步处理阻塞本地 API、IPC 状态查询无期限等待导致轮询无法恢复，以及一个已确认的超长自定义属性名称。见 [服务与引用验证](local-service-reliability-2026-11-09.md) 和 [长名称验证](custom-attribute-name-2026-11-09.md)。当次授权检查不使用缓存许可；异步引用仍校验完整预览令牌，使用乐观事务保留并发更新，持久化成功后才返回；这些源码补丁尚未进入此前的候选安装包。

## 用户目标与现状

客户经营医疗、消费电子、文具、塑料瓶、服装、鲜花、灯具等类目，主要使用规则模式。目标是保留资料并稳定发布，不能以少传字段、减少图片或改变类目换取表面成功率。

最新客户 1.4.97 的腕式血压计截图显示图片上传控件超时和“类型”操作未确认，该次没有新日志。历史医疗问题还涉及 Usage 新增行、FAQ、同名规格维度和慢速操作。1.4.98 补充共用控件延迟结果确认。

## 1.4.98 改动

| 模块 | 行为及约束 |
| --- | --- |
| `server/posting-interaction.js` | 点击已派发后遇超时/脱离，允许调用者提供有界只读 `confirmResult`；精确确认才继续，不额外点击，取消/其它错误传播 |
| `server/publisher.js` 的 `fillChoice` | 打开菜单核对同一输入，选择选项核对同一控件目标值，勾选核对 checked；其它字段同名值不算回执 |
| `server/structured-description.js` 的 `assignStructuredImageFiles` | 赋值超时核对 FileList 文件名/大小或当前图集的同名平台图片回执；不接受其它图集记录 |
| `server/publish-recovery.js` | 结果未知不因文案带“必填/图片”进入自动修复或再次提交 |
| `test/publish-late-receipt.test.js` | 真实动作后注入超时、延迟接收、取消、无回执、重挂载、七类目隔离及不重复派发 |

图片派发确认不等于平台完整接收，后续数量、身份、顺序、尺寸和原生模型核验仍保留。普通保存/提交按钮没有默认成功假设。

分支包含 1.4.97 及之前全部实现：FAQ 原文、Usage 新增行、同名不同 ID 规格、AI 服务失败退避、大工作区/本地服务处理、批量引用、新旧详情和视频工具。不要仅迁移上表文件而漏掉新增模块。

## 证据与限制

- 最终源码回归 986/986 通过，0 失败/取消/跳过，约 34 分钟。
- 实际加密归档其它 14 组 109 项通过，延迟结果组复跑 7 项通过，共 116 个不同用例。
- 首轮并行源码回归有两个浏览器时序失败和一个取消；原失败文件复跑 29/29，最终全量串行通过，不能把首轮写成全通过。
- 七类目连续故障注入包内首次超过测试总预算 30 秒，改为 90 秒后通过。未改变生产超时或断言。
- 构建、EXE 启动、本地 API、安装器载荷、签名、ASAR 和隐私检查通过，Vite 大资源提示仍存在。
- 正式采集医疗/消费电子样本的保存、重开、编辑保留、发布准备通过；来源没有逐 SKU 精确价格/库存时保留不可用标记。
- 消费电子草稿及重开核对通过：标题、主图、属性、SKU、阶梯价、详情图顺序、正文/表格/链接。一次正式提交取得回执，最后回查仍审核中，最终发布内容验收未完成。
- 2026-11-09 补充：上述消费电子商品已可打开发布后编辑页，只读核验标题、6 张主图、两种颜色、三档价格/起订量、必填属性及 11 张详情图通过；没有重复保存或提交。仅覆盖这一商品的旧版详情和测试明确列出的字段，不能扩展为医疗/双视频或所有图片像素验收。
- 医疗表单属性、规格、自定义属性、主图检查通过；账号没有医疗类目权限，受限表单缺少所需新版详情入口，未保存或发布，也未改为其它类目。
- 本轮真实消费电子测试关闭视频，不构成双视频验收。

原始输出和回执由项目所有者私下保管。本分支提供程序和不含业务资料的验证结论。

## 下一步优先顺序

1. 用具备医疗叶类目权限的账号和原失败商品，定位超时具体发生于主图、规格图、详情或公司图集。
2. 保存医疗草稿并重开核对 Type、Usage、全部规格、商务资料和结构化详情，再按授权正式提交和回读。
3. 运行跨类目回归，关注单选/多选、自定义容量、单位、`None` 与空值的区别。
4. 补齐双视频、主图/详情视频真实关联验收，记录平台容量和选择规则，不悄悄丢弃来源。
5. 检查千级工作区引用预览→保存、状态读取、服务停止/超时、暂停继续和重启恢复；未知结果不重试提交。
6. 生产代码修改后跑相关及完整回归，构建候选并检查包内；正式分发后不得同版本替换 EXE。

## 错误定位

无前缀的业务文件在 `server/`，测试在 `test/`。

| 问题 | 入口 / 测试 |
| --- | --- |
| 属性缺失、同名冲突 | `category-attributes.js`、`attribute-transfer.js`、`custom-attributes.js` / `attribute-transfer.test.js`、`custom-attribute-capacity.test.js` |
| 规格/颜色/SKU | `publisher.js`、`sku-dimensions.js`、`sku-reference.js` / `color-spec-enablement.test.js`、`spec-token-commit.test.js` |
| `None` 原产地 | `origin-country.js`、`attribute-values.js` / `origin-literal.test.js` |
| 塑料瓶具体用途 | `packaging-use-evidence.js`、`category-readiness.js` / 包装证据、包装属性测试 |
| 灯具重量/材料 | `attribute-values.js`、`attribute-transfer.js` / `lighting-weight.test.js`、`lighting-attributes.test.js` |
| FAQ/图集/新详情 | `description-structure.js`、`native-description-fields.js`、`structured-description.js` / 对应 FAQ、图集和结构化详情测试 |
| 图片接收 | `description-image-upload.js`、`structured-description-images.js`、`image-repair.js` / `structured-upload-entry.test.js`、`publish-late-receipt.test.js` |
| 视频 | `posting-video.js`、`posting-video-bank.js`、`published-video-retry.js` / 对应视频测试 |
| 交期/物流 | `posting-logistics.js`、`publish-policy.js` / `delivery-sheet-regression.test.js`、`logistics-policy.test.js` |
| 引用预览循环 | `reference-workflow.js`、`src/reference-request.js` / `reference-request.test.js`、`reference-scale.test.js` |
| 本地服务和旧状态 | `electron/local-service.js`、`workspace-reader.js`、`workspace-clone.js`、`src/local-api.js`、`src/state-refresh.js` / 大工作区和状态测试 |
| AI 慢或不可用 | `ai-product-assistance.js`、`ai-publishing.js` / `ai-service-availability.test.js` |

## 工具注意事项

必须使用正式采集入口。探针曾直接调用底层读取，继承卖家的中文偏好，出现中文自定义名映射问题；改为 `enrichSourceProducts` 后正式语言流程正确，不能把探针差异记成生产故障。

草稿回读工具曾重复生成图片占位使数量翻倍，已修正。旧 HTML 保存时平台会规范化块边界空白和冗余 span；工具为块边界加入渲染分隔，仍核对行内空格、表格、链接和图片顺序。这些是 QA 修正，没有为迁就测试改生产正文。

需要 Electron 安全存储的工具使用 `node node_modules/electron/cli.js tools/live-desktop-qa.cjs <脚本路径>`，环境参数按各脚本开头检查。输出到仓库外新目录，保留回执，不把 Cookie、截图、商品 JSON 或日志提交到 GitHub。真实发布、部署和清理工具不自动遍历执行。CAPTCHA 人工完成。

## 服务端交接

授权后台与本地发布服务独立。远端健康接口的 `1.4.53` 是现有服务标识，并非客户端版本，不能据此判断客户端源码过旧。

后台包含批量授权、私有管理员入口、诊断证据、更新分块上传和公告媒体。私有环境、PostgreSQL 内容及持久目录不在仓库中。部署步骤见 [后台 README](../auth-server/README.md)。本次没有部署服务器、重置管理员或调整客户授权。
