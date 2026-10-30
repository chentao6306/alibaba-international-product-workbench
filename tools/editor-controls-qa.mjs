// Isolated, real UI/API checks for the small editor controls and round trips.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { JsonStore } from '../server/store.js';
import { syncProductModel, verifySourceIntegrity } from '../server/product-model.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-controls-qa-'));
process.env.DATA_DIR = root; process.env.PORT = '0'; process.env.KUA_YIPU_AUTH_URL = 'http://127.0.0.1:1';
const server = await import('../server/index.js'); const listener = await server.serverReady;
const store = new JsonStore(path.join(root, 'workspace.json'));
const image = path.join(root, 'media', 'fixture.png');
await sharp({ create: { width: 150, height: 120, channels: 3, background: '#247766' } }).png().toFile(image);
store.update((state) => {
  state.collectionFolders = [{ id: 'controls', name: 'Controls QA' }]; state.settings.activeCollectionFolderId = 'controls';
  state.products = [syncProductModel({ id: 'editor-controls', title: 'Control QA Product', sourceId: 'qa-source', sourcePlatform: 'alibaba.com',
    collectionFolderId: 'controls',
    sourceUrl: 'https://example.com/product', status: 'ready', selected: true, price: 5, stock: 15, currencySymbol: '$', categoryId: '202063712',
    attributes: [{ name: 'Place of Origin', value: 'China' }, { name: 'Brand Name', value: 'QA' }, { name: 'Private Mold', value: 'No' }, { name: 'Material', value: ['ABS'], options: ['ABS', 'Metal'] }],
    variantGroups: [{ name: 'Color', options: ['Red'], optionImages: {} }], skus: [{ id: 'red', attributes: { Color: 'Red' }, price: 5, stock: 15 }],
    mainImages: ['/media/fixture.png'], detailImages: ['/media/fixture.png'], descriptionHtml: '<p>Original description</p>',
  })];
});
const original = store.read((s) => s.products[0].source);
const browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1550, height: 1000 } });
page.setDefaultTimeout(12000);
const errors = [], checks = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/announcements**', (route) => route.fulfill({ json: [] }));
await page.route('**/api/seller/product-groups?*', (route) => route.fulfill({ json: { groups: [{ id: '12345', name: 'QA group', path: 'QA / group' }] } }));
const log = (name) => { checks.push(name); fs.writeFileSync(path.join(root, 'checks.json'), JSON.stringify({ checks, errors }, null, 2)); };
const editor = page.getByRole('dialog', { name: '编辑产品', exact: true });
const tab = (name) => editor.getByRole('tab', { name, exact: true }).click();
const click = async (name, scope = editor) => { await scope.getByRole('button', { name, exact: true }).click(); log(`点击：${name}`); };
const fill = async (name, value, scope = editor) => { const field = scope.getByLabel(name, { exact: true }).filter({ visible: true }); await field.fill(value); assert.equal(await field.inputValue(), value); log(`输入并回读：${name}`); };
const choose = async (name, value) => { const field = editor.getByLabel(name, { exact: true }); await field.selectOption(value); assert.equal(await field.inputValue(), value); log(`选择并回读：${name}=${value}`); };
const current = () => store.read((s) => s.products[0]);
async function saveReopen() {
  await click('保存'); await editor.waitFor({ state: 'hidden' });
  assert.deepEqual(current().source, original); assert.equal(verifySourceIntegrity(current()).valid, true);
  await page.getByTitle('编辑完整资料').click(); await editor.waitFor(); log('保存并重开，原始来源完整');
}
try {
  await page.goto(`http://127.0.0.1:${listener.address().port}`);
  await page.locator('.sidebar nav button').filter({ hasText: '商品工作台' }).click();
  await page.getByTitle('编辑完整资料').click();
  await click('最大化窗口'); assert.ok(await editor.evaluate((node) => node.classList.contains('pe-maximized')));
  await click('还原窗口'); await click('来源与修改记录');
  await editor.locator('.pe-audit summary').click(); assert.match(await editor.locator('.pe-audit pre').innerText(), /Control QA Product/); await click('返回编辑');
  await fill('副标题', 'Subtitle QA'); await fill('商品关键词', 'first keyword\nsecond keyword');
  await click('加载商品分组列表'); await choose('国际站商品分组', '12345');
  const main = editor.locator('.pe-media[aria-label="主图"]');
  await main.locator('input[type=file]').setInputFiles(image); await main.locator('.pe-thumbnail').nth(1).waitFor(); log('本地主图上传');
  await click('前移主图2'); await click('后移主图1');
  await editor.getByLabel('选择主图2', { exact: true }).check(); await click('删除选中图片', main); assert.equal(await main.locator('.pe-thumbnail').count(), 1);
  await click('添加图片地址', main); await fill('主图地址', 'https://example.com/qa.png'); await click('添加', main); assert.equal(await main.locator('.pe-thumbnail').count(), 2);
  await click('恢复来源图片', main); assert.equal(await main.locator('.pe-thumbnail').count(), 1);
  await fill('主图视频地址', 'https://example.com/main.mp4'); await fill('详情视频地址', 'https://example.com/detail.mp4');
  await click('删除主图视频'); await fill('主图视频地址', 'https://example.com/main2.mp4');
  await tab('商品属性'); await choose('产地国家', 'Vietnam'); await choose('品牌选项', 'Other'); await fill('品牌名称', 'Control Brand'); await choose('私模', 'Yes');
  const material = editor.getByRole('group', { name: '材质', exact: true });
  await material.getByLabel('Metal', { exact: true }).check(); await material.getByLabel('ABS', { exact: true }).uncheck();
  await fill('材质自定义值', 'QA Composite'); await material.locator('xpath=..').getByRole('button', { name: '添加', exact: true }).click(); log('多值属性勾选、取消、自定义添加');
  await fill('新增属性名称', 'QA Extra'); await editor.getByLabel('新增属性名称').locator('xpath=..').getByRole('button', { name: '添加', exact: true }).click();
  await fill('QA Extra', 'extra'); await click('删除属性 QA Extra');
  await tab('自定义属性'); await fill('自定义属性 1 名称', 'Feature'); await fill('自定义属性 1 值', 'Value');
  await fill('自定义属性 2 名称', 'Discard'); await fill('自定义属性 2 值', 'Delete'); await click('清除自定义属性 2');
  await tab('产品规格'); await fill('规格 1 新选项', 'Blue');
  await editor.getByLabel('规格 1 新选项').locator('xpath=..').getByRole('button', { name: '添加', exact: true }).click();
  await editor.locator('.pe-spec-option').filter({ hasText: 'Red' }).getByRole('button', { name: '选取图片', exact: true }).click(); await fill('Red 规格图片地址', '/media/fixture.png');
  await fill('新增规格名称', 'Size'); await editor.getByLabel('新增规格名称').locator('xpath=..').getByRole('button', { name: '添加', exact: true }).click();
  await fill('规格 2 新选项', 'S'); await editor.getByLabel('规格 2 新选项').locator('xpath=..').getByRole('button', { name: '添加', exact: true }).click();
  await click('移除 Size S'); await click('删除规格 Size'); await click('更新规格组合');
  assert.equal(await editor.locator('.pe-skus tbody tr').count(), 2);
  for (let index = 1; index <= 2; index++) {
    await fill(`SKU ${index} 编码`, `code-${index}`); await fill(`SKU ${index} 价格`, String(5 + index)); await fill(`SKU ${index} 库存`, String(index - 1)); await fill(`SKU ${index} 图片`, '/media/fixture.png');
  }
  await editor.locator('.pe-skus tbody tr').nth(1).getByLabel('启用').uncheck(); log('停用第二个 SKU');
  await tab('交易信息'); await choose('计量单位', 'Pair'); await fill('付款方式', 'T/T'); await fill('基准销售价', '6'); await fill('默认库存', '0'); await fill('最小起订量', '10');
  for (const mode of ['根据数量设置阶梯价', 'FOB 阶梯价']) {
    await editor.getByLabel(mode, { exact: true }).check();
    await fill('阶梯 1 起订量', '10'); await fill('阶梯 1 最大数量', '99'); await fill('阶梯 1 价格', '6');
    await fill('阶梯 2 起订量', '100'); await fill('阶梯 2 价格', '5'); await click('删除价格档 2'); log(`价格模式：${mode}`);
  }
  await editor.getByLabel('单一 FOB 区间价格', { exact: true }).check(); await fill('FOB 最低价', '5'); await fill('FOB 最高价', '7');
  await editor.getByLabel('根据规格设置价格', { exact: true }).check(); await click('编辑 SKU 价格');
  assert.equal(await editor.getByRole('tab', { name: '产品规格', exact: true }).getAttribute('aria-selected'), 'true'); await tab('交易信息');
  await fill('交期 1 数量', '1 - 100'); await fill('交期 1 天数', '7'); await fill('交期 2 数量', '101 - 500'); await fill('交期 2 天数', '15'); await click('删除交期 2');
  await tab('物流信息');
  for (const [name, value] of [['包装毛重', '1.2'], ['包装长', '30'], ['包装宽', '20'], ['包装高', '10'], ['包装说明', 'QA carton'], ['运费模板', 'QA shipping'], ['物流属性', 'General cargo\nNo battery'], ['物流备注', 'QA notes']]) await fill(name, value);
  for (const value of ['一箱一件', '一箱多件', '智能托管']) await choose('箱规', value);
  for (const value of ['支持', '不支持', '']) await choose('半托管服务', value);
  await saveReopen();
  assert.equal(current().subtitle, 'Subtitle QA'); assert.equal(current().sellerGroup.id, '12345'); assert.equal(current().stock, 0);
  assert.equal(current().skus[1].enabled, false); assert.equal(current().skus[0].stock, 0); assert.equal(Number(current().packaging.weight), 1.2);
  assert.equal(current().videos.length, 2); assert.deepEqual(current().logisticsAttributes, ['General cargo', 'No battery']);
  await tab('商品服务与证书');
  await editor.getByRole('group', { name: '轻定制服务', exact: true }).getByLabel('Packaging').check();
  await editor.getByRole('group', { name: '深度定制', exact: true }).getByLabel('Color', { exact: true }).check();
  await click('添加关联证书'); await fill('证书 1 编号', 'QA-001'); await fill('证书 1 名称', 'QA certificate');
  await click('添加关联证书'); await click('删除证书 2');
  const serviceKeys = ['sample', 'afterSales', 'localShowroom', 'productionVisualization', 'ecommerce', 'dropshipping', 'remoteWarranty'];
  for (const [index, expected] of [[1, true], [2, false], [0, null]]) {
    await tab('商品服务与证书');
    for (const key of serviceKeys) { await editor.locator(`input[name="service-${key}"]`).nth(index).check(); log(`服务 ${key}=${expected}`); }
    await saveReopen();
    for (const key of serviceKeys) assert.equal(current().services[key] ?? null, expected);
  }
  await tab('商品服务与证书'); await editor.getByRole('group', { name: '出图出样服务', exact: true }).getByLabel('三天出图').check(); await editor.getByRole('group', { name: '出图出样服务', exact: true }).getByLabel('七天出样').check();
  await tab('国家/地区差异设置'); await click('选取国家/地区'); await choose('定价国家 1', 'United States');
  for (const [label, value] of [['直接设置价格', '8'], ['基础价加减金额', '-2'], ['基础价调整比例', '10']]) {
    await editor.getByLabel(label, { exact: true }).check(); await fill('地区价格 1', value); await saveReopen();
    assert.equal(Number(current().regionalPricing.rows[0].value), Number(value)); await tab('国家/地区差异设置'); log(`地区定价保存：${label}`);
  }
  await click('选取国家/地区'); await choose('定价国家 2', 'Canada'); await fill('地区价格 2', '5'); await click('删除地区 2');
  await tab('商品描述'); const details = editor.locator('.pe-media[aria-label="详情图"]');
  await details.locator('input[type=file]').setInputFiles(image); await details.locator('.pe-thumbnail').nth(1).waitFor();
  await click('前移详情图2'); await click('后移详情图1'); await editor.getByLabel('选择详情图2', { exact: true }).check(); await click('删除选中图片', details); await click('恢复来源图片', details);
  await fill('商品卖点', 'First point\nSecond point'); await click('HTML 源码');
  await fill('详情 HTML', '<p>QA HTML</p><table><tbody><tr><td>Cell</td></tr></tbody></table><script>window.QA_BAD=true</script>');
  await click('HTML 源码'); assert.equal(await editor.locator('.pe-richtext script').count(), 0); assert.equal(await page.evaluate(() => window.QA_BAD), undefined);
  const rich = editor.getByRole('textbox', { name: '商品详情编辑', exact: true }); await rich.fill('Formatted text'); await rich.press('Control+a');
  await click('粗体'); assert.match(await rich.innerHTML(), /<(?:b|strong)>/); await rich.press('Control+a'); await click('斜体'); assert.match(await rich.innerHTML(), /<(?:i|em)>/);
  await click('项目列表'); assert.equal(await rich.locator('ul').count(), 1); await click('撤销'); log('详情富文本、源码、安全过滤、格式化、撤销');
  await saveReopen(); assert.equal(current().certificates[0].number, 'QA-001'); assert.equal(current().certificates.length, 1); assert.equal(current().regionalPricing.rows.length, 1);
  assert.deepEqual(current().services.drawingSample, ['三天出图', '七天出样']);
  await tab('基础信息'); await fill('商品名称', ''); await tab('物流信息'); await click('保存');
  assert.equal(await editor.getByRole('tab', { name: '基础信息', exact: true }).getAttribute('aria-selected'), 'true'); assert.equal(current().title, 'Control QA Product');
  await fill('商品名称', 'Unsaved change'); await click('关闭编辑'); await page.getByRole('alertdialog').getByRole('button', { name: '继续编辑', exact: true }).click();
  await click('返回'); await page.getByRole('alertdialog').getByRole('button', { name: '放弃修改并返回', exact: true }).click(); assert.equal(current().title, 'Control QA Product');
  assert.deepEqual(errors, []); log('跨页必填跳转、继续编辑、放弃关闭均不误保存');
  console.log(JSON.stringify({ ok: true, root, controlsAndChecks: checks.length }));
} catch (error) { await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }); console.error(JSON.stringify({ root, lastChecks: checks.slice(-5) })); throw error; }
finally { await browser.close(); await server.shutdownServer(); }
