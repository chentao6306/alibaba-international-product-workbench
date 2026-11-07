// Native publishing fields are the source of the platform's structured
// highlights/company/FAQ layout. Never substitute a rich-text blob for them.
const clean = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
// The native English FAQ validator rejects typographic apostrophes even
// though the rich-text editor accepts them. Keep the original source intact.
export const nativeDescriptionText = value => String(value || '').replace(/[\u2018\u2019]/g, "'");
const problem = (message, stage) => Object.assign(new Error(`新版结构化详情：${message}`), {
  code: 'PUBLISH_DESCRIPTION_STRUCTURE_MISMATCH', diagnostics: { reason: 'native-description-fields', stage },
});

export function compileNativeDescription(structure, schemas) {
  const result = { textDesc: '', companyDesc: '', companyFaqDesc: [], galleries: [] };
  const modules = structure?.modules || [];
  const unsupported = modules.filter(module => !['highlights', 'company', 'faq', 'gallery'].includes(module.type));
  if (unsupported.length) throw problem('原详情包含额外模块，不能将其合并成普通正文或丢弃', 'unsupported-module');
  for (const type of ['highlights', 'company', 'faq']) {
    if (modules.filter(module => module.type === type).length > 1) throw problem(`原详情有多个 ${type} 模块，不能合并后冒充原结构`, 'module-count');
  }
  result.textDesc = nativeDescriptionText(modules.find(module => module.type === 'highlights')?.items.join('\n'));
  result.companyDesc = nativeDescriptionText(modules.find(module => module.type === 'company')?.text);
  result.companyFaqDesc = (modules.find(module => module.type === 'faq')?.items || []).map(item => ({ question: nativeDescriptionText(item.question), answers: nativeDescriptionText(item.answer) }));
  for (const id of ['textDesc', 'companyDesc']) {
    if (result[id] && (!schemas[id] || !(Number(schemas[id].maxLength) > 0))) throw problem(`未取得 ${id} 的当前字段限制`, 'field-schema');
    if (result[id].length > Number(schemas[id]?.maxLength)) throw problem(`${id} 超出当前平台 ${schemas[id].maxLength} 字符限制`, 'text-limit');
  }
  const faq = schemas.companyFaqDesc;
  if (result.companyFaqDesc.length && (!faq || !faq.maxItem || !faq.questionLength || !faq.answerLength)) throw problem('未取得 FAQ 当前字段限制', 'field-schema');
  if (result.companyFaqDesc.length > Number(faq?.maxItem)) throw problem(`FAQ 超出当前平台 ${faq.maxItem} 条限制`, 'faq-limit');
  for (const item of result.companyFaqDesc) {
    if (!clean(item.question) || !clean(item.answers)) throw problem('原 FAQ 的问题或答案不完整', 'faq-source');
    if (item.question.length > faq.questionLength || item.answers.length > faq.answerLength) throw problem('FAQ 问题或答案超过当前平台长度限制', 'faq-limit');
  }
  for (const module of modules.filter(item => item.type === 'gallery')) {
    if (!module.images.length) continue;
    const rootId = module.scope === 'company' ? 'companyImage' : 'detailImage';
    const schema = schemas[rootId];
    if (!schema?.dataSource?.length) throw problem(`未取得 ${rootId} 的当前图集选项`, 'gallery-schema');
    // Older saved HTML can contain an empty company gallery heading after
    // sanitization. Use only the live form's generic gallery in that scope;
    // never infer a factory/certification category from the image itself.
    const unnamed = !clean(module.title);
    const name = clean(module.title) || (rootId === 'detailImage' ? 'Other product images' : 'Extended company profile');
    const matches = schema.dataSource.filter(item => [item.enName, item.cnName].some(value => clean(value).toLowerCase() === name.toLowerCase()));
    if (matches.length > 1 || matches[0]?.disabled) throw problem(`当前表单无法唯一匹配图集“${name}”`, 'gallery-mapping');
    if (unnamed && !matches.length) throw problem(`原${rootId === 'companyImage' ? '公司' : '商品'}图集未提供名称，当前表单也未提供可用的“${name}”图集；原图已保留`, 'gallery-mapping');
    const custom = matches.length === 0;
    if (custom && (!schema.supportCustomGallery || !name || name.length > schema.maxGalleryNameLength || /[^\x20-\x7e]/.test(name))) {
      throw problem(`当前表单无法唯一匹配图集“${name}”`, 'gallery-mapping');
    }
    const option = matches[0] || { value: null, enName: name };
    if (module.images.some(image => clean(image.caption))) throw problem(`图集“${name}”包含图片文字，尚未核对对应文字控件`, 'gallery-caption');
    if (result.galleries.some(item => item.rootId === rootId && item.name === option.enName)) throw problem(`原详情存在重复图集“${name}”，不能合并`, 'gallery-duplicate');
    result.galleries.push({ rootId, value: option.value, name: option.enName, custom, images: module.images });
  }
  for (const rootId of ['detailImage', 'companyImage']) {
    const groups = result.galleries.filter(item => item.rootId === rootId);
    if (!groups.length) continue;
    const schema = schemas[rootId];
    // maxGalleryItem is not passed to the current native gallery component.
    // Built-in options can all be selected; only total images and CUSTOM
    // gallery count are validated. Treating it as a total rejects valid groups.
    if (!schema.maxImageItem) throw problem(`未取得 ${rootId} 的图片数量限制`, 'gallery-schema');
    const count = groups.reduce((total, item) => total + item.images.length, 0);
    if (count > Number(schema.maxImageItem)) {
      throw problem(`${rootId} 共 ${count} 张图片，超过当前表单 ${schema.maxImageItem} 张限制；原图已保留`, 'gallery-limit');
    }
    if (groups.filter(group => group.custom).length > Number(schema.maxCustomGalleryItem || 0)) throw problem(`${rootId} 自定义图集数量超出当前表单限制`, 'gallery-limit');
  }
  return result;
}

export async function resolveNativeGallery(page, gallery, beforeInteraction = async () => {}) {
  if (!gallery.custom) return;
  const root = page.locator(`#${gallery.rootId}`);
  const label = root.locator('label.gallery-names-checkbox').filter({ has: page.locator('.gallery-names-checkbox-en-name').filter({ hasText: new RegExp(`^${gallery.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
  if (!await label.count()) {
    const add = root.locator('.add-custom-gallery-name-btn');
    await beforeInteraction(add); await add.click();
    const input = root.locator('.custom-input input');
    await input.fill(gallery.name); await input.press('Tab');
    await label.waitFor({ state: 'visible', timeout: 10000 });
  }
  if (await label.count() !== 1) throw problem(`自定义图集“${gallery.name}”不唯一`, 'gallery-mapping');
  gallery.value = await label.locator('input[type="checkbox"]').getAttribute('value');
  if (gallery.value == null) throw problem(`自定义图集“${gallery.name}”未取得有效标识`, 'gallery-mapping');
}

export async function readNativeDescriptionFields(page) {
  return page.evaluate(() => {
    const values = window.GlobalStore?.engine?.getModels()?.formValues;
    if (!values) return null;
    return Object.fromEntries(['textDesc', 'companyDesc', 'companyFaqDesc', 'detailImage', 'companyImage'].map(key => [key, values[key]]));
  });
}

export function requireNativeDescriptionFields(plan, fields) {
  if (!fields) throw problem('无法读取平台实际保存字段', 'field-readback');
  for (const key of ['textDesc', 'companyDesc']) {
    if (clean(fields[key]) !== clean(plan[key])) throw problem(`${key} 与原文不一致`, 'field-readback');
  }
  const normalizeFaq = items => (items || []).map(item => ({ question: clean(item.question), answers: clean(item.answers) }));
  if (JSON.stringify(normalizeFaq(fields.companyFaqDesc)) !== JSON.stringify(normalizeFaq(plan.companyFaqDesc))) throw problem('FAQ 的问题、答案或顺序未保留', 'faq-readback');
  for (const rootId of ['detailImage', 'companyImage']) {
    const expected = plan.galleries.filter(group => group.rootId === rootId).map(group => ({ value: String(group.value), name: group.name, urls: group.urls }));
    const actual = (fields[rootId] || []).map(group => ({ value: String(group.value), name: group.enName, urls: (group.imageList || []).map(image => image.imgURL) }));
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw problem(`${rootId} 的图片、图集分类或排列未保留`, 'gallery-readback');
  }
  return true;
}

export async function waitForNativeDescriptionFields(page, plan, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let since = 0, lastError;
  while (Date.now() < deadline) {
    try {
      requireNativeDescriptionFields(plan, await readNativeDescriptionFields(page));
      if (!since) since = Date.now();
      if (Date.now() - since >= 650) { await requireNativeDescriptionAccepted(page); return true; }
    } catch (error) { since = 0; lastError = error; }
    await page.waitForTimeout(150);
  }
  throw lastError || problem('原生详情字段尚未稳定保存', 'field-readback');
}

export async function requireNativeDescriptionAccepted(page, { includeGalleries = true } = {}) {
  const ids = ['textDesc', 'companyDesc', 'companyFaqDesc', ...(includeGalleries ? ['detailImage', 'companyImage'] : [])];
  for (const id of ids) {
    const errors = await page.locator(`#${id} .sell-error-message:visible, #${id} .next-form-item-help:visible, #${id} .image-gallery-error-item .msg-text > span:first-child:visible`).allTextContents();
    const message = [...new Set(errors.map(clean).filter(Boolean))].join('；');
    if (message) throw problem(`${id} 未通过平台校验：${message}`, 'field-validation');
  }
}

async function waitCommitted(page, read, expected, stage, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  // Require the value to survive a subsequent render, not just the input event.
  let since = 0;
  while (Date.now() < deadline) {
    if (JSON.stringify(await read()) === JSON.stringify(expected)) {
      if (!since) since = Date.now();
      if (Date.now() - since >= 650) return;
    } else since = 0;
    await page.waitForTimeout(150);
  }
  throw problem(`${stage} 未被平台完整保留，已停止提交`, stage);
}

async function commitText(page, locator, value, read, stage, beforeInteraction, prepare = async () => {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await prepare();
      await beforeInteraction(locator);
      await locator.fill(value, { timeout: 5000 });
      await locator.press('Tab', { timeout: 5000 });
      await waitCommitted(page, read, value, stage);
      return;
    } catch (error) {
      // Text replacement is idempotent; submission, row creation and deletion
      // are not retried here. Never swallow pauses, overlays or closed pages.
      const transient = !error.code && !/Target.*closed|browser has been closed/i.test(error.message)
        && (error.name === 'TimeoutError' || /element is not attached|Execution context was destroyed/i.test(error.message));
      const uncommitted = error.code === 'PUBLISH_DESCRIPTION_STRUCTURE_MISMATCH' && error.diagnostics?.stage === stage;
      if (!transient && !uncommitted) throw error;
      if (attempt === 2) {
        if (!transient) throw error;
        const label = stage === 'companyDesc' ? '公司介绍' : stage === 'textDesc' ? '商品卖点' : 'FAQ';
        throw Object.assign(problem(`${label}输入框刷新后仍未就绪，尚未提交；请重试该商品`, 'field-control'), {
          diagnostics: { reason: 'native-description-fields', stage: 'field-control', field: stage, attempts: 3 }, cause: error,
        });
      }
      await page.waitForTimeout(200);
    }
  }
}

export async function fillNativeDescriptionText(page, plan, { beforeInteraction = async () => {}, onProgress = () => {} } = {}) {
  for (const [id, selector] of [['textDesc', '[contenteditable="true"]'], ['companyDesc', 'textarea[data-real="true"]']]) {
    const root = page.locator(`#${id}`);
    const input = page.locator(`#${id} ${selector}`).filter({ visible: true });
    if (!await root.count()) {
      if (plan[id]) throw problem(`当前表单缺少 ${id} 控件`, 'field-missing');
      continue;
    }
    onProgress(`填写新版详情：${id === 'companyDesc' ? '公司介绍' : '商品卖点'}`);
    await commitText(page, input, plan[id], async () => String((await readNativeDescriptionFields(page))?.[id] || ''), id, beforeInteraction,
      async () => {
        // Image processing and a text commit can remount an auto-growing
        // textarea. Revisit its section before resolving the visible editor.
        await beforeInteraction(root);
        await input.waitFor({ state: 'visible', timeout: 5000 });
      });
  }
  const root = page.locator('#companyFaqDesc');
  if (!await root.count()) {
    if (plan.companyFaqDesc.length) throw problem('当前表单缺少 FAQ 控件', 'field-missing');
    await requireNativeDescriptionAccepted(page, { includeGalleries: false });
    return;
  }
  onProgress('填写新版详情：FAQ 问答');
  await beforeInteraction(root);
  const rows = root.locator('.company-faq-desc > div > .item');
  // Saved FAQ controls restore their previous values after a blank edit.
  // Update retained rows in place and use the native delete action only for
  // surplus rows. Never clear and recreate an already accepted whole FAQ.
  for (let index = await rows.count() - 1; index >= plan.companyFaqDesc.length; index--) {
    const row = rows.nth(index);
    if (!await row.locator('.question input').inputValue() && !await row.locator('.answers textarea[data-real="true"]').inputValue()) continue;
    const previous = (await readNativeDescriptionFields(page))?.companyFaqDesc || [];
    const remove = row.locator('.faq-handle .handle-item > .iconfont:not(.handle-drag)');
    if (await remove.count() === 1) {
      await beforeInteraction(remove);
      await remove.click({ timeout: 10000 });
      await waitCommitted(page, async () => (await readNativeDescriptionFields(page))?.companyFaqDesc || [], previous.slice(0, -1), 'faq-remove');
      continue;
    }
    // Older forms without a delete handle accept clearing a trailing row.
    // Clear its answer first so the question keeps the model index stable.
    for (const [selector, key] of [['.answers textarea[data-real="true"]', 'answers'], ['.question input', 'question']]) {
      const input = row.locator(selector);
      if (!await input.inputValue()) continue;
      await beforeInteraction(input);
      await input.fill(''); await input.press('Tab');
      await page.waitForTimeout(700);
      if (await input.inputValue()) throw problem('旧 FAQ 未清除', `faq-reset-${key}`);
    }
    await waitCommitted(page, async () => (await readNativeDescriptionFields(page))?.companyFaqDesc || [], previous.slice(0, -1), 'faq-remove');
  }
  for (let index = 0; index < plan.companyFaqDesc.length; index++) {
    if (await rows.count() <= index) {
      await beforeInteraction(root.locator('.add-items'));
      await root.locator('.add-items').click();
      await rows.nth(index).waitFor({ timeout: 10000 });
    }
    for (const [selector, key] of [['.question input', 'question'], ['.answers textarea[data-real="true"]', 'answers']]) {
      await commitText(page, rows.nth(index).locator(selector), plan.companyFaqDesc[index][key],
        async () => String((await readNativeDescriptionFields(page))?.companyFaqDesc?.[index]?.[key] || ''), `faq-${index + 1}-${key}`, beforeInteraction);
    }
  }
  await waitCommitted(page, async () => (await readNativeDescriptionFields(page))?.companyFaqDesc || [], plan.companyFaqDesc, 'faq-readback');
  // Gallery replacement runs next; stale image errors must not block editing
  // text, but the complete native-description check still validates both.
  await requireNativeDescriptionAccepted(page, { includeGalleries: false });
}

export async function nativeDescriptionSchemas(page) {
  return page.evaluate(() => Object.fromEntries(['textDesc', 'companyDesc', 'companyFaqDesc', 'detailImage', 'companyImage']
    .map(key => [key, window.Json?.components?.[key]?.props || null])));
}
