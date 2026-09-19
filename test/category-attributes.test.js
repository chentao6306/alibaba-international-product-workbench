import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { extractAlibabaAttributes, mergeSourceAttributes, needsSourceAttributeRefresh, packagingFromAttributes, readAlibabaAttributeRows, readPostingAttributeSchema, sourceAttributeForField, SOURCE_ATTRIBUTE_SCHEMA_VERSION } from '../server/category-attributes.js';
import { auditProduct, mergeSourceDataForPublish } from '../server/product-model.js';
import { attributeOptionMatchScore, emptyRequiredSpecificationLabels, fillCategoryAttributes, preparePublishProduct, recoverRequiredAttributes, requiredAttributeFailure, validateProductData } from '../server/publisher.js';

test('collects arbitrary structured properties with IDs, multiple options and false values while excluding recommendations', () => {
  assert.deepEqual(extractAlibabaAttributes(null), []);
  assert.deepEqual(extractAlibabaAttributes({ nodeMap: { module_attribute: null, module_packaging: null } }), []);
  const attributes = extractAlibabaAttributes({ nodeMap: {
    module_attribute: { privateData: { groups: [{ title: 'Key attributes', attributes: [
      { propertyId: 41, propertyName: 'Age Range', values: [{ id: 7, name: '3 to 6 years' }, { id: 8, name: '7 to 12 years' }] },
      { attributeId: 42, attributeName: 'Is Customized', attributeValue: false, valueId: 2 },
      { id: 43, name: 'Novel Category Property', value: 'Original' },
    ] }], recommendations: [{ name: 'Unrelated', value: 'Wrong' }] } },
    module_recommended_attributes: { privateData: [{ name: 'Wrong', value: 'Wrong' }] },
  }, globalData: { product: { properties: [{ name: 'Place of Origin', value: 'Guangdong, China' }] } } });
  assert.equal(attributes.length, 4);
  assert.deepEqual(attributes[0].value, ['3 to 6 years', '7 to 12 years']);
  assert.deepEqual(attributes[0].valueIds, { '3 to 6 years': '7', '7 to 12 years': '8' });
  assert.equal(attributes[1].value, 'false');
  assert.equal(sourceAttributeForField({ attributes }, { id: '43', label: '未列入词典的属性' }).value, 'Original');
  assert.equal(sourceAttributeForField({ attributes }, { label: '原产地' }).value, 'Guangdong, China');
  const merged = mergeSourceAttributes(attributes, [{ name: '年龄范围', value: '3 to 6 years, 7 to 12 years', source: 'dom' }]);
  assert.deepEqual(merged, attributes);
  assert.deepEqual(mergeSourceAttributes([{ id: 1, name: 'Feature', value: 'Sound' }, { id: 1, name: 'Feature', value: 'Light' }])[0].value, ['Sound', 'Light']);
});

test('extracts packaging in kilograms and centimeters without guessing absent or ambiguous measurements', () => {
  assert.deepEqual(packagingFromAttributes([
    { name: 'Single gross weight', value: '750 g' }, { name: 'Single package size', value: '120x80x40 mm' },
  ]), { weight: '0.75', length: '12', width: '8', height: '4' });
  assert.deepEqual(packagingFromAttributes([{ name: '包装重量', value: '1.5 千克' }]), { weight: '1.5' });
  assert.deepEqual(packagingFromAttributes([{ name: 'Gross weight', value: '2 lbs' }]), { weight: '0.907185' });
  assert.deepEqual(packagingFromAttributes([{ name: 'Gross weight', value: '1-2kg' }, { name: 'Weight', value: '100 g' }]), {});
  const product = preparePublishProduct({ title: 'Toy', price: 10, mainImages: [1, 2, 3, 4].map((n) => `https://example.test/${n}.jpg`), detailImages: ['https://example.test/detail.jpg'], description: 'Actual toy description',
    attributes: [{ name: '原产地', value: 'Guangdong, China' }], packaging: {} });
  assert.equal(product.origin, 'China');
  assert.deepEqual(validateProductData(product), []);
  assert.equal(auditProduct(product).issues.find((issue) => issue.code === 'logistics.weight.missing').severity, 'warning');
  assert.equal(attributeOptionMatchScore('3-6 years', '3-6岁'), 100);
  assert.equal(attributeOptionMatchScore('3-6 months', '3-6岁'), 0);
  assert.equal(attributeOptionMatchScore('6+', '6'), 0);
  assert.equal(attributeOptionMatchScore(false, '否'), 100);
  assert.equal(attributeOptionMatchScore('20 m', '20 cm'), 0);
  assert.equal(attributeOptionMatchScore('5 kg', '5 g'), 0);
  assert.equal(attributeOptionMatchScore('5 W', '5 kW'), 0);
});

test('matches translated popup values by option ID and recognizes committed readonly selections', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="sell-catProp-item" id="struct-p-123">
      <div class="label required">场景</div><span class="next-select"><span class="next-select-values"></span><input readonly role="combobox"></span>
      </div><div class="sell-o-select-options" style="display:none"><div class="options-item" data-value="456">室外</div></div>
      <div class="sell-catProp-item"><div class="label required">原产地</div><input readonly role="combobox" value="China"></div>
      <div class="sell-catProp-item"><div class="label required">未提交搜索值</div><input role="combobox" value="pending"></div>
      <script>
      const input=document.querySelector('#struct-p-123 input'), menu=document.querySelector('.sell-o-select-options');
      input.onclick=()=>menu.style.display='block';
      menu.firstElementChild.onclick=()=>{const tag=document.createElement('em');tag.textContent='室外';document.querySelector('.next-select-values').append(tag);menu.style.display='none';};
      </script>`);
    assert.deepEqual(await fillCategoryAttributes(page, { attributes: [{ id: '123', name: 'Scene', value: 'Outdoor', valueIds: { Outdoor: '456' } }] }), ['Scene']);
    assert.equal(await page.locator('.next-select-values').textContent(), '室外');
    assert.deepEqual(await emptyRequiredSpecificationLabels(page, true), ['未提交搜索值']);
  } finally { await browser.close(); }
});

test('enrichment merges missing attributes and packaging without overwriting edits or a referenced category', () => {
  const target = { sourceId: '1', attributes: [{ name: 'Animal', value: 'Bee' }], packaging: { weight: '', length: '20' } };
  const source = { sourceId: '1', attributes: [{ id: '10', name: 'Animal', value: 'Cat' }, { id: '11', name: 'Age Range', value: '6+' }],
    packaging: { weight: '0.75', length: '10', width: '5', height: '2' } };
  const merged = mergeSourceDataForPublish(target, source);
  assert.equal(merged.attributes[0].value, 'Bee');
  assert.equal(merged.attributes[1].value, '6+');
  assert.deepEqual(merged.packaging, { weight: '0.75', length: '20', width: '5', height: '2' });
  assert.deepEqual(mergeSourceDataForPublish({ ...target, categoryReference: { id: 'ref' } }, source).attributes, target.attributes);
  assert.equal(target.packaging.weight, '');
  const failed = { ...target, publishResult: { message: '国际站必填属性或规格未填写：年龄段、原产地' } };
  assert.equal(needsSourceAttributeRefresh(failed), true);
  assert.equal(needsSourceAttributeRefresh({ ...failed, categoryReference: { id: 'ref' } }), false);
  const refreshed = mergeSourceDataForPublish(failed, { ...source, sourceAttributeSchemaVersion: SOURCE_ATTRIBUTE_SCHEMA_VERSION });
  assert.equal(needsSourceAttributeRefresh(refreshed), false);
  assert.equal(needsSourceAttributeRefresh(target), false);
});

test('combines modern, legacy and anonymous attribute rows even after collecting two fields', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div data-testid="module-attribute-group">
      <div data-testid="module-attribute-row"><span data-testid="module-attribute-name">Place of Origin</span><span data-testid="module-attribute-value">China</span></div>
      <div data-testid="module-attribute-row"><span data-testid="module-attribute-name">Material</span><span data-testid="module-attribute-value">Plastic</span></div>
      <div><span>Animal</span><span>Bee</span></div>
      </div><table><tr><td>Age Range</td><td>3-6 years</td></tr></table>
      <dl><dt>Single gross weight</dt><dd>250 g</dd></dl>
      <div data-module-name="module_recommend"><table><tr><td>Animal</td><td>Cat</td></tr></table></div>`);
    const attributes = mergeSourceAttributes(await page.evaluate(readAlibabaAttributeRows));
    assert.equal(attributes.length, 5);
    assert.equal(attributes.find((item) => item.name === 'Animal').value, 'Bee');
    assert.equal(attributes.find((item) => item.name === 'Age Range').value, '3-6 years');
    assert.deepEqual(packagingFromAttributes(attributes), { weight: '0.25' });
  } finally { await browser.close(); }
});

test('fills toy category controls by IDs or bilingual aliases and keeps unknown required values empty', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(2000);
    await page.setContent(`<div class="sell-catProp-item" id="struct-p-900"><div class="label required">陌生属性</div><select><option value="">请选择</option><option value="901">中文选项</option></select></div>
      <div class="sell-catProp-item" id="age"><div class="label required">年龄段</div><label><input type="checkbox">3-6岁</label><label><input type="checkbox">7-12岁</label><label><input type="checkbox">0-3岁</label></div>
      <div class="sell-catProp-item" id="origin"><div class="label required">原产地</div><select><option value="">请选择</option><option value="CN">中国</option></select></div>
      <div class="sell-catProp-item" id="custom"><div class="label required">是否可定制</div><label><input type="radio" name="custom" value="Y">是</label><label><input type="radio" name="custom" value="N">否</label></div>
      <div class="sell-catProp-item" id="distance"><div class="label required">远程距离</div><input></div>
      <div class="sell-catProp-item" id="missing"><div class="label required">组合产品数量</div><input></div>
      <div class="sell-catProp-item"><div class="label required">尚未加载的必填字段</div></div>`);
    const product = { attributes: [
      { id: '900', name: 'Unknown Category Property', value: 'English Option', valueIds: { 'English Option': '901' } },
      { name: 'Age Range', value: ['3-6 years', '7-12 years'] }, { name: 'Place of Origin', value: 'Guangdong, China' },
      { name: 'Is Customized', value: false }, { name: 'Remote Control Distance', value: '20 m' },
    ] };
    const mapped = await fillCategoryAttributes(page, product);
    assert.equal(mapped.length, 5, JSON.stringify({ mapped, fields: await page.evaluate(readPostingAttributeSchema) }));
    assert.equal(await page.locator('#struct-p-900 select').inputValue(), '901');
    assert.deepEqual(await page.locator('#age input').evaluateAll((nodes) => nodes.map((node) => node.checked)), [true, true, false]);
    assert.equal(await page.locator('#origin select').inputValue(), 'CN');
    assert.equal(await page.locator('#custom input:checked').inputValue(), 'N');
    assert.equal(await page.locator('#distance input').inputValue(), '20 m');
    assert.deepEqual(await emptyRequiredSpecificationLabels(page, true), ['组合产品数量', '尚未加载的必填字段']);
    await page.locator('#custom input[value="Y"]').check();
    assert.deepEqual(await recoverRequiredAttributes(page, product, ['是否可定制']), ['是否可定制']);
    assert.equal(await page.locator('#custom input:checked').inputValue(), 'N');
    const schema = await page.evaluate(readPostingAttributeSchema);
    assert.equal(schema[0].id, '900');
    assert.equal(schema.at(-1).inputIndex, -1);
    const failure = await requiredAttributeFailure(page, { attributes: [{ name: 'Number of Pieces', value: 73 }] }, ['组合产品数量', '尚未加载的必填字段']);
    assert.deepEqual(failure.missingSourceFields, ['尚未加载的必填字段']);
    assert.deepEqual(failure.unmatchedSourceFields, ['组合产品数量']);
    assert.deepEqual(failure.requiredFields, ['组合产品数量', '尚未加载的必填字段']);
    assert.match(failure.message, /已采集但发布页未接受/);
  } finally { await browser.close(); }
});
