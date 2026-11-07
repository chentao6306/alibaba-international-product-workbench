import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { JsonStore } from '../server/store.js';
import { syncProductModel, createPublishSnapshot } from '../server/product-model.js';
import { preparePublishProduct, fillCategoryAttributes, requireCategoryAttributes } from '../server/publisher.js';

const baseline = process.argv.includes('--baseline');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-attributes-qa-'));
process.env.DATA_DIR = root; process.env.PORT = '0'; process.env.KUA_YIPU_AUTH_URL = 'http://127.0.0.1:1';
const server = await import('../server/index.js');
const listener = await server.serverReady;
const store = new JsonStore(path.join(root, 'workspace.json'));
const product = { id: 'target', sourceId: 'attribute-qa', collectionFolderId: 'qa', sourcePlatform: 'alibaba.com',
  title: 'Christmas Holiday Supplies', categoryId: 'qa-holiday', categoryPath: ['Gifts', 'Holiday Supplies'], selected: true,
  attributes: [{ name: 'Type', value: 'Christmas Holiday Supplies' }, { id: 'model', name: 'Model Number', value: 'OLD-MODEL', valueId: 'old-model-id', required: true },
    { name: 'Brand Name', value: 'Old Company' }, { name: 'Private Mold', value: 'No' }, { name: 'Material', value: ['Wood'], valueIds: { Wood: 'old-wood' }, options: ['Wood', 'Plastic'] },
    { name: 'Packing', value: 'Bag', options: ['Box', 'Bag'] }],
  postingRequirements: { categoryId: 'qa-holiday', fields: [
    { id: 'application', label: '应用领域', required: true, controlType: 'input' },
    { id: 'notes', label: '使用说明', required: false, controlType: 'input' },
    { id: 'model', label: '型号', required: true, controlType: 'input' },
    { id: 'season', label: '适用季节', required: true, controlType: 'select', options: ['Winter', 'Summer'] },
    { id: 'features', label: '功能', required: false, controlType: 'checkbox', options: ['Reusable', 'Handmade'] },
  ] },
};
syncProductModel(product);
const originalSource = structuredClone(product.source);
store.update((state) => { state.collectionFolders = [{ id: 'qa', name: '属性验收' }]; state.settings.activeCollectionFolderId = 'qa'; state.products = [product]; });
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
const pane = page.locator('.pe-attributes');
const errors = [], results = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/announcements**', (route) => route.fulfill({ json: [] }));
async function type(label, text) {
  const input = pane.getByLabel(label, { exact: true });
  await input.fill(''); await input.pressSequentially(text);
  const value = await input.inputValue();
  const focused = await input.evaluate((node) => document.activeElement === node);
  results.push({ label, expected: text, value, focused, ok: value === text && focused });
}
try {
  await page.goto(`http://127.0.0.1:${listener.address().port}`);
  await page.getByLabel('采集分组', { exact: true }).selectOption('qa');
  await page.locator('.sidebar nav button').filter({ hasText: '商品工作台' }).click();
  const open = async () => { await page.getByTitle('编辑完整资料').first().click(); await page.getByRole('tab', { name: '商品属性', exact: true }).click(); };
  await open();
  await type('应用领域', 'Christmas decorations');
  await type('使用说明', 'Indoor use only');
  await type('型号', 'QA Model 25');
  await type('类型', 'Christmas Holiday Supplies');
  await type('品牌名称', 'Our Company');
  await pane.getByLabel('私模', { exact: true }).selectOption('Yes');
  await pane.getByLabel('Packing', { exact: true }).selectOption('Box');
  await pane.getByRole('group', { name: '材质', exact: true }).getByLabel('Plastic', { exact: true }).check();
  await pane.getByRole('group', { name: '材质', exact: true }).getByLabel('Wood', { exact: true }).uncheck();
  const season = pane.getByLabel('适用季节', { exact: true });
  const seasonSelect = await season.evaluate((node) => node.tagName === 'SELECT');
  results.push({ label: '适用季节', ok: seasonSelect, control: seasonSelect ? 'select' : 'input' });
  if (seasonSelect) await season.selectOption('Winter');
  const features = pane.getByRole('group', { name: '功能', exact: true });
  const featureCheckbox = await features.count() > 0 && await features.getByLabel('Reusable', { exact: true }).count() > 0;
  results.push({ label: '功能', ok: featureCheckbox });
  if (featureCheckbox) await features.getByLabel('Reusable', { exact: true }).check();
  await page.screenshot({ path: path.join(root, 'attributes.png') });
  if (!baseline) {
    assert.ok(results.every((item) => item.ok), JSON.stringify(results));
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('dialog', { name: '编辑产品', exact: true }).waitFor({ state: 'hidden' });
    const saved = store.read().products[0];
    const byName = (name) => saved.attributes.find((item) => item.name === name)?.value;
    assert.equal(byName('应用领域'), 'Christmas decorations');
    assert.equal(byName('使用说明'), 'Indoor use only');
    assert.equal(byName('Model Number'), 'QA Model 25');
    assert.equal(byName('Brand Name'), 'Our Company');
    assert.deepEqual(byName('Material'), ['Plastic']);
    assert.equal(byName('适用季节'), 'Winter');
    assert.deepEqual(byName('功能'), ['Reusable']);
    assert.deepEqual(saved.source, originalSource, 'old values remain only in the collected snapshot');
    assert.equal(saved.attributes.find((item) => item.id === 'model').valueId, undefined);
    assert.equal(saved.attributes.find((item) => item.name === 'Material').valueIds, undefined);
    // Run the actual publishing preparation and attribute filling against a
    // controlled page already populated with old data; never submit a listing.
    const prepared = preparePublishProduct(saved);
    assert.deepEqual(createPublishSnapshot(prepared).data.attributes, saved.attributes);
    const posting = await browser.newPage();
    try {
      await posting.setContent('<div class="sell-catProp-item"><label class="label required">应用领域</label><input value="OLD APPLICATION"></div>'
        + '<div class="sell-catProp-item"><label class="label">使用说明</label><input value="OLD NOTES"></div>'
        + '<div class="sell-catProp-item" data-attribute-id="model"><label class="label required">型号</label><input value="OLD-MODEL"></div>'
        + '<div class="sell-catProp-item"><label class="label">品牌名称</label><input value="Old Company"></div>'
        + '<div class="sell-catProp-item"><label class="label">私模</label><select><option>No</option><option>Yes</option></select></div>'
        + '<div class="sell-catProp-item"><label class="label">Packing</label><select><option>Bag</option><option>Box</option></select></div>'
        + '<div class="sell-catProp-item"><label class="label">材质</label><select multiple><option value="new-wood" selected>Wood</option><option value="new-plastic">Plastic</option></select></div>'
        + '<div class="sell-catProp-item" data-attribute-id="season"><label class="label required">适用季节</label><select><option>Summer</option><option>Winter</option></select></div>'
        + '<div class="sell-catProp-item" data-attribute-id="features"><label class="label">功能</label><label><input type="checkbox" value="reuse">Reusable</label><label><input type="checkbox" value="hand">Handmade</label></div>');
      await fillCategoryAttributes(posting, prepared);
      await requireCategoryAttributes(posting, prepared);
      const values = await posting.locator('.sell-catProp-item').evaluateAll((rows) => rows.map((row) => {
        const controls = [...row.querySelectorAll('input,select')];
        return controls.flatMap((node) => node.tagName === 'SELECT' ? [...node.selectedOptions].map((o) => o.textContent)
          : node.type === 'checkbox' ? node.checked ? [node.closest('label').textContent] : [] : [node.value]);
      }));
      assert.deepEqual(values, [['Christmas decorations'], ['Indoor use only'], ['QA Model 25'], ['Our Company'], ['Yes'], ['Box'], ['Plastic'], ['Winter'], ['Reusable']]);
      await posting.screenshot({ path: path.join(root, 'publish-saved-attributes.png') });
      results.push({ label: '发布页填写保存后的属性，替换旧值', ok: true });
    } finally { await posting.close(); }
    await open();
    assert.equal(await pane.getByLabel('应用领域', { exact: true }).inputValue(), 'Christmas decorations');
    assert.equal(await season.inputValue(), 'Winter');
    assert.ok(await features.getByLabel('Reusable', { exact: true }).isChecked());
    await type('应用领域', 'New application');
    await page.setViewportSize({ width: 430, height: 950 });
    assert.ok(await page.locator('.pe-window').evaluate((node) => node.scrollWidth <= node.clientWidth));
    await page.screenshot({ path: path.join(root, 'attributes-mobile.png') });
    assert.deepEqual(errors, []);
  }
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ baseline, results, errors }, null, 2));
  console.log(JSON.stringify({ root, baseline, results, errors }));
} catch (error) { await page.screenshot({ path: path.join(root, 'failure.png') }); console.error(JSON.stringify({ root, results, errors })); throw error; }
finally { await browser.close(); await server.shutdownServer(); }
