// Apply only explicitly configured options, then verify the committed form values.
import { ORIGIN_COUNTRIES, originCountry } from './origin-country.js';
import { clickPostingControl } from './posting-interaction.js';
import { usesSkuPricing } from './sku-reference.js';
import { requiredAttributeKey } from './publish-reference.js';
import { customizationGroups, customizationProblems } from './product-services.js';

const absent = (value) => value == null || String(value).trim() === '';
const unavailable = (field, reason) => Object.assign(new Error(`${field}未完成：${reason}；已停止提交，未忽略此项设置`), { code: 'PUBLISH_FIELD_NOT_READY', fieldName: field });
const escaped = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function customizationFormModel(root) {
  return root.evaluate(node => {
    let fiber = node[Object.keys(node).find(key => key.startsWith('__reactFiber'))];
    for (let depth = 0; fiber && depth < 14; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps || {};
      if (!['newCustomizedServices', 'lightCustomizedServices'].includes(props.id)) continue;
      try {
        const value = typeof props.value === 'string' ? JSON.parse(props.value) : props.value;
        if (value?.customContent) return value.customContent;
      } catch { /* A temporarily incomplete form value is not a receipt. */ }
    }
    return [];
  });
}

export function regionalPriceRows(product) {
  const settings = product.regionalPricing || {};
  const rows = settings.rows || (settings.country ? [{ country: settings.country, value: settings.price }] : []);
  const mode = settings.mode || 'fixed';
  if (!['fixed', 'amount', 'percent'].includes(mode)) throw unavailable('地区价格', '未知定价方式');
  const seen = new Set();
  return rows.map((row) => {
    const country = ORIGIN_COUNTRIES.find((item) => item.name === originCountry(row.country));
    const value = Number(row.value);
    if (!country || absent(row.value) || !Number.isFinite(value) || (mode === 'fixed' && value < 0.01) || (mode === 'percent' && value <= -100)) {
      throw unavailable('地区价格', `请填写有效国家和价格（${row.country || '未选择国家'}）`);
    }
    if (seen.has(country.code)) throw unavailable('地区价格', `国家重复：${country.label}`);
    seen.add(country.code);
    return { ...country, value, mode };
  });
}

async function chooseLabel(page, root, expression, type) {
  const label = root.locator('label').filter({ hasText: expression }).filter({ visible: true });
  if (await label.count() !== 1) throw unavailable('发布选项', `未找到唯一选项 ${expression}`);
  const input = label.locator(`input[type="${type}"]`);
  if (await input.count() !== 1) throw unavailable('发布选项', '控件结构发生变化');
  if (!await input.isChecked()) await clickPostingControl(page, label);
  if (!await input.isChecked()) throw unavailable('发布选项', '平台未接受选项');
}

export async function fillRegionalPrices(page, product, fill) {
  const rows = regionalPriceRows(product);
  if (!rows.length) return [];
  const countries = page.locator('#struct-icbuCountryRegion');
  if (!await countries.isVisible().catch(() => false)) throw unavailable('地区价格', '当前类目或销售方式未开放国家选择');
  const missing = [];
  for (const row of rows) if (!await countries.locator(`input[type="checkbox"][value="${row.code}"]`).count()) missing.push(row);
  if (missing.length) {
    const entry = countries.locator('.editBtn');
    if (await entry.count() !== 1) throw unavailable('地区价格', `无法添加国家/地区：${missing.map(row => row.label).join('、')}`);
    await clickPostingControl(page, entry);
    const iframe = page.locator('.icbu-dialog-selector iframe');
    await iframe.waitFor({ timeout: 10000 });
    const frame = await iframe.elementHandle().then(node => node.contentFrame());
    if (!frame) throw unavailable('地区价格', '国家选择器未加载');
    await frame.locator('input[type="checkbox"]').first().waitFor({ state: 'attached', timeout: 15000 });
    for (const row of missing) {
      const input = frame.locator(`input[type="checkbox"][value="${row.code}"]`).filter({ visible: true });
      const tabs = frame.getByRole('tab');
      for (let index = 0; !await input.count() && index < await tabs.count(); index++) await clickPostingControl(page, tabs.nth(index));
      if (await input.count() !== 1) throw unavailable('地区价格', `平台国家列表中没有${row.label}`);
      if (!await input.isChecked()) await clickPostingControl(page, input.locator('xpath=ancestor::label[1]'));
      if (!await input.isChecked()) throw unavailable('地区价格', `${row.label}未被选择器接受`);
    }
    await clickPostingControl(page, frame.getByRole('button', { name: /^(?:Determine|确定|确认)$/i }));
    await iframe.waitFor({ state: 'hidden', timeout: 10000 });
  }
  for (const row of rows) {
    const input = countries.locator(`input[type="checkbox"][value="${row.code}"]`);
    if (await input.count() !== 1) throw unavailable('地区价格', `请在国际站添加国家/地区：${row.label}`);
    if (!await input.isChecked()) await clickPostingControl(page, input.locator('xpath=ancestor::label[1]'));
    if (!await input.isChecked()) throw unavailable('地区价格', `${row.label}未选中`);
  }
  // Clear countries left by an earlier attempt, only inside the pricing control.
  for (const input of await countries.locator('input[type="checkbox"]:checked').all()) {
    const code = await input.getAttribute('value');
    if (!rows.some((row) => row.code === code)) await clickPostingControl(page, input.locator('xpath=ancestor::label[1]'));
  }
  const root = page.locator('#struct-countryLadderPrice:visible, #struct-countrySku:visible').filter({ has: page.locator('input[type="radio"]') }).first();
  await root.waitFor({ timeout: 10000 }).catch(() => { throw unavailable('地区价格', '定价表尚未就绪'); });
  const labels = { fixed: /^(?:直接设置价格|Set price directly)$/i, amount: /^(?:基础价加减金额|Adjust by amount)$/i, percent: /^(?:基础价调整比例|Adjust by percentage)$/i };
  await chooseLabel(page, root, labels[rows[0].mode], 'radio');
  const checks = [];
  for (const row of rows) {
    const headers = root.locator('th .next-table-cell-wrapper[data-next-table-col]').filter({ hasText: new RegExp(`^(?:${escaped(row.label)}|${escaped(row.name)})(?:售价| price|\\s)`, 'i') }).filter({ visible: true });
    if (await headers.count() !== 1) throw unavailable('地区价格', `未找到${row.label}的唯一价格列`);
    const column = await headers.getAttribute('data-next-table-col');
    if (!/^\d+$/.test(column || '')) throw unavailable('地区价格', '无法识别价格列');
    const cells = root.locator(`tbody td[data-next-table-col="${column}"]`).filter({ visible: true });
    if (!await cells.count()) throw unavailable('地区价格', `${row.label}价格行为空`);
    if (usesSkuPricing(product) && await cells.count() !== product.skus.filter((sku) => sku.enabled !== false).length) {
      throw unavailable('地区价格', `${row.label}的规格价格行未完整展开，请在平台核对全部规格价格`);
    }
    for (let index = 0; index < await cells.count(); index++) {
      const cell = cells.nth(index);
      if (row.mode !== 'fixed') {
        const sign = row.value < 0 ? '-' : '+';
        const select = cell.locator('.subtract-change-price .next-select, .super-price-direction');
        if (await select.count() !== 1) throw unavailable('地区价格', '加减方向控件未就绪');
        if ((await select.locator('em').innerText()).trim() !== sign) {
          await clickPostingControl(page, select);
          const option = page.locator('[role="option"]:visible, .next-menu-item:visible').filter({ hasText: new RegExp(`^\\s*${escaped(sign)}\\s*$`) }).first();
          await clickPostingControl(page, option);
        }
        if ((await select.locator('em').innerText()).trim() !== sign) throw unavailable('地区价格', '加减方向未生效');
      }
      const input = cell.locator('input:not([readonly]):not([type="checkbox"]):not([type="radio"])');
      if (await input.count() !== 1) throw unavailable('地区价格', '价格输入框不唯一');
      const value = row.mode === 'fixed' ? row.value : Math.abs(row.value);
      await fill(input, value, `${row.label}地区价格`);
      const preview = cell.locator('.price-preview, .super-price-value');
      if (await preview.count()) {
        const text = await preview.innerText();
        const price = Number(text.replace(/[^\d.\-]/g, ''));
        if (!Number.isFinite(price) || price < 0.01) throw unavailable('地区价格', `${row.label}调整后的售价无效`);
      }
      checks.push({ input, value, country: row.code });
    }
  }
  for (const check of checks) if (Number(await check.input.inputValue()) !== check.value) throw unavailable('地区价格', '后续重绘丢失已填价格');
  return rows.map(({ code, value, mode }) => ({ code, value, mode }));
}

const SERVICE_LABELS = {
  sample: ['样品服务', 'Sample service'], afterSales: ['售后服务', 'After-sales service'],
  localShowroom: ['样品间服务', 'Local showroom'], productionVisualization: ['生产可视化服务', 'Production visualization'],
  ecommerce: ['电商一站式服务', 'E-commerce service'], dropshipping: ['一件代发服务', 'Dropshipping'], remoteWarranty: ['一年远程质保服务', 'Remote warranty'],
};

export async function linkProductCertificates(page, certificates = []) {
  const requested = certificates.filter((item) => item.source === 'manual');
  if (!requested.length) return;
  if (requested.some((item) => absent(item.number))) throw unavailable('关联商品证书', '请填写国际站证书库中的编号');
  const root = page.locator('#struct-certificate');
  if (!await root.isVisible().catch(() => false)) throw unavailable('关联商品证书', '当前类目未开放证书关联');
  const accepted = async (number) => root.locator('tbody tr').filter({ has: page.locator('td').first().filter({ hasText: new RegExp(`^\\s*${escaped(number)}\\s*$`) }) }).count();
  for (const certificate of requested) {
    const number = String(certificate.number).trim();
    if (await accepted(number) === 1) continue;
    const entry = root.locator('a').filter({ hasText: /^(?:去关联|关联证书|关联|Associate|Link certificates?)$/i }).filter({ visible: true }).first();
    if (!await entry.count()) throw unavailable('关联商品证书', '未找到证书库入口');
    await clickPostingControl(page, entry);
    const dialog = page.locator('.posting-field-certificate-dialog:visible');
    await dialog.waitFor({ timeout: 10000 });
    try {
      await dialog.locator('.next-loading.next-open').waitFor({ state: 'hidden', timeout: 20000 });
      const search = dialog.locator('input[role="searchbox"]');
      await search.fill(number);
      await clickPostingControl(page, dialog.locator('button.next-search-btn'));
      await page.waitForTimeout(300);
      await dialog.locator('.next-loading.next-open').waitFor({ state: 'hidden', timeout: 20000 });
      const row = dialog.locator('tbody tr').filter({ has: page.locator('td').nth(1).filter({ hasText: new RegExp(`^\\s*${escaped(number)}\\s*$`) }) });
      if (await row.count() !== 1) throw unavailable('关联商品证书', `证书库未找到唯一且属于当前类目的证书 ${number}，请先在国际站核验并关联类目`);
      const input = row.locator('input[type="checkbox"]');
      if (await input.count() !== 1 || await input.isDisabled()) throw unavailable('关联商品证书', `${number}不可选或尚未通过平台验真`);
      if (!await input.isChecked()) await clickPostingControl(page, input.locator('xpath=ancestor::label[1]'));
      if (!await input.isChecked()) throw unavailable('关联商品证书', `${number}未勾选成功`);
      await clickPostingControl(page, dialog.locator('button[role="btn-ok"]'));
      await dialog.waitFor({ state: 'hidden', timeout: 10000 });
      if (await accepted(number) !== 1) throw unavailable('关联商品证书', `${number}未进入商品的已关联列表`);
    } catch (error) {
      const cancel = dialog.locator('button[role="btn-cancel"]');
      if (await cancel.isVisible().catch(() => false)) await clickPostingControl(page, cancel).catch(() => {});
      throw error;
    }
  }
}

export async function fillCustomizationServices(page, product, controls = {}) {
  const groups = customizationGroups(product.services);
  for (const group of groups) {
    const problems = customizationProblems(group);
    if (problems.length) throw unavailable('定制服务', problems.join('、'));
    if (!controls.fill || !controls.choose) throw unavailable('定制服务', '定制控件未就绪');
    const root = page.locator(group.kind === 'lightCustomization' ? '#lightCustomizedServices' : '#newCustomizedServices');
    if (!await root.isVisible().catch(() => false)) throw unavailable(group.name, '当前类目未开放此项定制');
    const aliases = /^(?:Logo\/graphic design|Logo\/图案)$/i.test(group.name) ? ['Logo/图案', 'Logo/graphic design']
      : /^(?:Packaging|包装)$/i.test(group.name) ? ['包装', 'Packaging'] : [group.name];
    const normalize = text => requiredAttributeKey(String(text).replace(/轻定制|\(\d+\/\d+\)/g, '').trim());
    const labels = root.locator('.next-checkbox-wrapper').filter({ visible: true });
    const options = await labels.evaluateAll(nodes => nodes.map(node => ({ label: node.textContent, id: node.querySelector('input')?.value })));
    const attribute = (product.attributes || []).find(row => row.name === group.name);
    const matches = options.map((option, index) => ({ ...option, index })).filter(option => (attribute?.id && option.id === String(attribute.id)) || aliases.some(alias => normalize(alias) === normalize(option.label)));
    if (matches.length !== 1) throw unavailable(group.name, '未找到唯一对应的定制属性');
    const input = labels.nth(matches[0].index).locator('input[type="checkbox"]');
    if (!await input.isChecked()) await clickPostingControl(page, labels.nth(matches[0].index));
    if (!await input.isChecked()) throw unavailable(group.name, '定制属性未选中');
    const wanted = normalize(matches[0].label);
    const lists = root.locator('.itemList').filter({ visible: true });
    const titles = await lists.locator('.itemList-title').allTextContents();
    const model = await customizationFormModel(root);
    const record = model.find(row => String(row.customPropId) === String(matches[0].id));
    const at = titles.findIndex(title => normalize(title) === wanted || (record?.customPropText && normalize(title) === normalize(record.customPropText)));
    if (at < 0) throw unavailable(group.name, '定制条件未展开');
    const section = lists.nth(at);
    const cards = section.locator('.cardItem');
    while (await cards.count() < group.rows.length) {
      const before = await cards.count();
      await clickPostingControl(page, section.locator('.itemList-cardList-icon-container'));
      if (await cards.count() <= before) throw unavailable(group.name, '未能添加定制值');
    }
    if (await cards.count() !== group.rows.length) throw unavailable(group.name, '已选定制值与本次设置数量不一致');
    for (const [index, setting] of group.rows.entries()) {
      const card = cards.nth(index);
      const valueInput = card.locator('input[role="combobox"]');
      // This is Alibaba's free-text autocomplete, not its enum-only attribute
      // selector. Blur commits new values that are absent from the suggestion list.
      const autocomplete = await valueInput.evaluate(node => Boolean(node.closest('.next-select-auto-complete')));
      if (autocomplete) await controls.fill(valueInput, setting.value, `${group.name}定制值`);
      else if (!await controls.choose(page, valueInput, setting.value, { allowCustomCombo: true })) throw unavailable(group.name, `定制值 ${setting.value} 未被接受`);
      const numeric = card.locator('input[minimum]');
      if (await numeric.count() !== 2) throw unavailable(group.name, '定制价格或起订量结构变化');
      await controls.fill(numeric.nth(0), setting.surcharge ?? '', `${group.name}加价`);
      await controls.fill(numeric.nth(1), setting.moq, `${group.name}起订量`);
      if (setting.image) {
        if (!controls.uploadImage) throw unavailable(group.name, '示例图上传未就绪');
        await controls.uploadImage(card, setting.image);
      }
    }
    if (group.baseImage) {
      if (!controls.fillHotspot) throw unavailable(group.name, '需要完成商品底图和定制区域设置');
      await controls.fillHotspot(section, group);
    }
    const errors = await root.locator('.sell-error-message:visible, .next-form-item-help:visible').allTextContents();
    if (errors.some(text => /必填|不能为空|错误|失败|required|invalid/i.test(text))) throw unavailable(group.name, errors.join('；'));
  }
  return groups.map(group => ({ name: group.name, kind: group.kind, count: group.rows.length }));
}

export async function fillOptionalServices(page, product, controls = {}) {
  const services = product.services || {};
  for (const [key, names] of Object.entries(SERVICE_LABELS)) {
    if (services[key] == null) continue;
    if (typeof services[key] !== 'boolean') throw unavailable(names[0], '设置不是支持/不支持');
    const field = page.locator('.sell-o-addon').filter({ has: page.locator('.sell-o-addon-label').filter({ hasText: new RegExp(`^\\s*(?:${names.map(escaped).join('|')})\\s*$`, 'i') }) }).filter({ visible: true });
    if (await field.count() !== 1) throw unavailable(names[0], '当前账号或类目未提供对应服务控件');
    await chooseLabel(page, field, services[key] ? /^(?:支持|Yes|Supported)$/i : /^(?:不支持|No|Not supported)$/i, 'radio');
  }
  await fillCustomizationServices(page, product, controls);
  if (services.drawingSample?.length) {
    const root = page.locator('#struct-designAndSampleService');
    if (!await root.isVisible().catch(() => false)) throw unavailable('出图出样服务', '当前账号或类目未开放此服务');
    for (const name of services.drawingSample) await chooseLabel(page, root, new RegExp(`^${escaped(name)}$`, 'i'), 'checkbox');
  }
  await linkProductCertificates(page, product.certificates);
  return ((product.certificates || []).some((item) => item.source !== 'manual') || services.customizations?.length || services.sourceTexts?.length)
    ? ['来源证书和服务说明仅保留为来源资料，未作为当前店铺已验真的证书或服务承诺提交'] : [];
}
