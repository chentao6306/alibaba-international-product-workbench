// Run only in an isolated source checkout: some older QA scripts write .data there.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

if (!process.env.QA_ISOLATED_CHECKOUT || path.resolve(process.env.QA_ISOLATED_CHECKOUT).toLowerCase() !== process.cwd().toLowerCase()) {
  throw new Error('QA_ISOLATED_CHECKOUT must explicitly name this disposable source checkout.');
}
const output = path.resolve(process.env.QA_REPORT_DIR || '../artifacts/deep-ui');
fs.mkdirSync(output, { recursive: true });
const checks = [
  ['admin-qa', '授权、设备、权限、后台管理'],
  ['announcement-media-qa', '图文公告、草稿、发布、每次进入弹窗'],
  ['updates-ui-qa', '安装包分块上传、恢复、签名、发布、撤回'],
  ['desktop-auth-qa', '桌面登录、授权、断线、撤销、进程恢复'],
  ['activation-persistence-qa', '激活、重启、凭据加密'],
  ['settings-desktop-qa', '设置、密钥、重启持久化'],
  ['collection-folders-qa', '店铺、分组、采集、平台隔离'],
  ['image-search-controls-qa', '以图搜品参数边界、重复任务、暂停继续取消、分组归属'],
  ['group-origin-ui-qa', '商品来源与分组筛选'],
  ['category-picker-qa', '类目搜索、选择、异步切换'],
  ['product-attributes-qa', '属性、语言、必填、多值'],
  ['product-editor-qa', '商品各页签编辑、保存、校验'],
  ['editor-controls-qa', '编辑器 164 项控件操作、保存回读、来源保护'],
  ['workbench-detail-qa', '分页、查找、SKU 表格、加价、取消删除、清理保护'],
  ['reference-ui-qa', '成功商品引用、目标数据保留'],
  ['product-image-qa', '图片增删、排序、保存'],
  ['image-watermark-qa', '水印、撤销、还原、来源保护'],
  ['batch-edit-qa', '500 件水印与详情、失败定位及重试'],
  ['batch-input-desktop-qa', '六种水印组合、连续两批、焦点恢复'],
  ['description-template-qa', '详情模板编辑、预览、批量应用'],
  ['local-connection-qa', '本地服务断线、重连、写入保护'],
  ['publish-continuation-qa', '发布任务暂停、恢复、失败延续'],
  ['publish-delay-qa', '发布间隔、暂停、重复提交保护'],
  ['publish-status-qa', '发布状态、错误、历史记录'],
  ['update-recovery-qa', 'Windows 更新中断恢复'],
  ['website-ui-qa', '官网下载、异常重试、弹窗、微信、移动端'],
  ['seller-session-qa', '卖家会话加密、账号隔离', 'electron'],
  ['source-window-qa', '来源窗口跳转、异常恢复', 'electron'],
  ['verification-window-qa', '验证码、静音、图标、暂停', 'electron'],
];
const requested = process.argv.slice(2);
const selected = requested.length ? checks.filter(([name]) => requested.includes(name)) : checks;
if (requested.some((name) => !checks.some(([check]) => check === name))) throw new Error('Unknown QA check');
const report = { version: JSON.parse(fs.readFileSync('package.json')).version, startedAt: new Date().toISOString(), isolated: true, results: [] };
for (const [name, purpose, runtime] of selected) {
  const started = Date.now();
  const log = path.join(output, `${name}.log`);
  const fd = fs.openSync(log, 'w');
  console.log(`START ${name}: ${purpose}`);
  const args = [...(runtime === 'electron' ? ['node_modules/electron/cli.js'] : []), `tools/${name}.mjs`];
  const child = spawn(process.execPath, args, { windowsHide: true, env: process.env, stdio: ['ignore', fd, fd] });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGTERM');
  }, 12 * 60 * 1000);
  const result = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ status: 'failed', error: error.message }));
    child.once('exit', (code, signal) => resolve({ status: code === 0 && !timedOut ? 'passed' : 'failed', code, signal, timedOut }));
  });
  clearTimeout(timer); fs.closeSync(fd);
  report.results.push({ name, purpose, ...result, durationMs: Date.now() - started, log });
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(`${result.status.toUpperCase()} ${name} ${Date.now() - started}ms`);
}
report.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
if (report.results.some((result) => result.status !== 'passed')) process.exitCode = 1;
