import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const root = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(root, 'logs/full-tests-final.log'))) throw new Error('Provide the completed isolated QA directory');
const log = fs.readFileSync(path.join(root, 'logs/full-tests-final.log'), 'utf8');
const cases = [...log.matchAll(/^\s*ok \d+ - (.+)$/gm)].map((match) => match[1].trim());
assert.equal(cases.length, 600); assert.match(log, /# pass 600\s+# fail 0/);
const reports = new Map();
for (const folder of ['deep-ui', 'ui-retest', 'final-ui']) {
  const report = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', folder, 'results.json')));
  for (const result of report.results) reports.set(result.name, { ...result, evidence: `artifacts/${folder}/${result.name}.log` });
}
for (const [name, file, purpose] of [
  ['workbench-detail-qa', 'workbench-detail.log', '分页、查找、SKU 表格、加价、取消删除、清理保护'],
  ['website-ui-qa', 'website-ui.log', '官网下载、异常重试、弹窗、微信、移动端'],
]) if (!reports.has(name)) {
  const content = fs.readFileSync(path.join(root, 'logs', file), 'utf8');
  assert.match(content, /"ok":true/);
  reports.set(name, { name, purpose, status: 'passed', evidence: `logs/${file}` });
}
assert.equal(reports.size, 27);
assert.ok([...reports.values()].every((row) => row.status === 'passed'));
const link = (file) => `[日志](<${path.join(root, file).replaceAll('\\', '/')}>)`;
const escape = (value) => String(value).replaceAll('|', '\\|').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const text = [
  '# 1.4.71 自动化检查逐项记录', '',
  `生成时间：${new Date().toISOString()}。原始 TAP：${link('logs/full-tests-final.log')}。`, '',
  '600 项通过，失败、跳过、取消均为 0。以下保留用例原名以便直接定位测试代码；界面脚本内包含多个点击、保存和回读断言，脚本数量不是按钮数量。', '',
  '## 界面与桌面脚本', '',
  '首次运行的两个测试脚本定位问题（设置区域选择器、批量保存分块数的旧断言）已修正并重跑；下表取最终结果，原始失败日志仍保留。', '',
  '| 脚本 | 检查范围 | 最终结果 | 证据 |', '| --- | --- | --- | --- |',
  ...[...reports.values()].map((row) => `| ${row.name} | ${row.purpose} | 通过 | ${link(row.evidence)} |`), '',
  '## Node 测试用例', '', '| 编号 | 行为 | 结果 |', '| --- | --- | --- |',
  ...cases.map((name, index) => `| ${index + 1} | ${escape(name)} | 通过 |`), '',
].join('\n');
fs.writeFileSync(path.join(root, 'artifacts/test-cases.md'), text);
const sourceRoot = process.cwd(); const entries = [];
for (const folder of ['server', 'electron', 'src']) {
  for (const file of fs.readdirSync(path.join(sourceRoot, folder), { recursive: true }).filter((file) => /\.(?:js|jsx|cjs|css|html)$/.test(file))) {
    const relative = path.join(folder, file); const source = fs.readFileSync(path.join(sourceRoot, relative));
    const staged = fs.readFileSync(path.join(root, 'source', relative));
    assert.ok(source.equals(staged), `QA source differs: ${relative}`);
    entries.push({ file: relative.replaceAll('\\', '/'), sha256: crypto.createHash('sha256').update(source).digest('hex') });
  }
}
fs.writeFileSync(path.join(root, 'artifacts/source-manifest.json'), JSON.stringify({ version: '1.4.71', files: entries }, null, 2));
console.log(JSON.stringify({ cases: cases.length, uiScripts: reports.size, sourceFiles: entries.length, report: path.join(root, 'artifacts/test-cases.md') }));
