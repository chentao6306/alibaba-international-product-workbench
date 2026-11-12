import path from 'node:path';
import fs from 'node:fs';
import { load } from 'cheerio';
import { alibabaKeywordText } from './product-keywords.js';
import { currentDescriptionStructure, descriptionStructureFingerprint } from './description-structure.js';
import { compileNativeDescription, nativeDescriptionSchemas, fillNativeDescriptionText, waitForNativeDescriptionFields, resolveNativeGallery } from './native-description-fields.js';
import { prepareStructuredDescriptionImages } from './structured-description-images.js';
import { revealDescriptionSection } from './posting-readiness.js';

const editorSelector = 'iframe[name="decorateDetailEditor"]';
const textSelector = '.comp-singletext-text [contenteditable="true"]';
const acceptedDescriptions = new WeakMap();
const failure = (message, stage) => Object.assign(new Error(`新版详情未完成：${message}`), {
  code: 'PUBLISH_EDITOR_NOT_READY', diagnostics: { reason: 'new-description-editor', stage, automaticDowngrade: false },
});

// Choosing a native gallery can replace its DOM during the next render. Only
// scrolling and overlay preparation may be replayed here; the caller dispatches
// its actual edit/upload separately and must verify its own committed receipt.
export async function prepareStructuredInteraction(page, target, { clearOverlays = async () => {}, timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let cause;
  do {
    try {
      const count = await target.count();
      if (count > 1) throw Object.assign(failure('新版详情控件匹配到多个位置，未执行修改', 'control-identity'), {
        diagnostics: { reason: 'new-description-editor', stage: 'control-identity', target: String(target).slice(0, 500), matches: count, dispatched: false },
      });
      if (count === 1) {
        await target.scrollIntoViewIfNeeded({ timeout: Math.min(2000, Math.max(1, deadline - Date.now())) });
        await clearOverlays();
        // Resolve the locator again after overlays/React rendering. A detached
        // element handle must not be carried into the actual upload operation.
        if (await target.count() === 1 && await target.evaluate(node => node.isConnected && Boolean(node.getClientRects().length), undefined, { timeout: 1000 })) return;
      }
    } catch (error) {
      if (error.code || /Target.*closed|browser has been closed/i.test(error.message)
        || (error.name !== 'TimeoutError' && !/detached|not attached/i.test(error.message))) throw error;
      cause = error;
    }
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  throw Object.assign(failure('新版详情控件重绘后仍未就绪，未执行本次修改或上传', 'control-rerender'), {
    cause, diagnostics: { reason: 'new-description-editor', stage: 'control-rerender',
      target: String(target).slice(0, 500), dispatched: false },
  });
}

async function until(page, check, message, stage, timeout = 30000) {
  const end = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await page.waitForTimeout(250);
  } while (Date.now() < end);
  throw failure(message, stage);
}

export async function hasStructuredDescription(page) {
  return Boolean(await page.locator('#textDesc, #detailImage').filter({ visible: true }).count());
}

export function structuredHighlightText(product) {
  const structure = currentDescriptionStructure(product);
  if (structure) return structure.modules.filter(module => module.type === 'highlights').flatMap(module => module.items).join('\n');
  return [...new Set([String(product.subtitle || '').trim(), ...alibabaKeywordText(product).split('\n')].filter(Boolean))].join('\n');
}

async function savedDescriptionIdentity(page) {
  return page.evaluate(() => {
    const values = window.GlobalStore?.engine?.getModels()?.formValues;
    return values ? JSON.stringify([values.productDescType, values.magicEditor, values.textDesc, values.companyDesc, values.companyFaqDesc, values.detailImage, values.companyImage]) : '';
  });
}

export async function acceptedStructuredHighlights(page, product) {
  const accepted = acceptedDescriptions.get(page);
  const expected = [String(product.subtitle || '').trim(), ...alibabaKeywordText(product).split('\n')].filter(Boolean);
  return Boolean(accepted && expected.every(value => accepted.highlights.split('\n').includes(value))
    && accepted.url === page.url() && accepted.highlights === structuredHighlightText(product)
    && accepted.identity && accepted.identity === await savedDescriptionIdentity(page));
}

export async function requireAcceptedNativeDescription(page, product) {
  const structure = currentDescriptionStructure(product);
  if (!structure) return;
  const accepted = acceptedDescriptions.get(page);
  if (!accepted?.nativePlan || accepted.url !== page.url() || accepted.structure !== JSON.stringify(descriptionStructureFingerprint(structure))) throw failure('原生详情模块尚未完成校验', 'native-receipt');
  await waitForNativeDescriptionFields(page, accepted.nativePlan);
  const mode = await page.evaluate(() => window.GlobalStore?.engine?.getModels()?.formValues?.productDescType?.value);
  if (mode !== 4) throw failure('详情已切换到装修编辑器，原生结构化字段未确认生效', 'native-mode');
}

export function restoreStructuredImages(html, urls) {
  const $ = load(html, null, false);
  const used = new Set();
  $('[data-workbench-source-image], [data-workbench-image-slot]').each((_, node) => {
    const index = Number($(node).attr('data-workbench-source-image') ?? $(node).attr('data-workbench-image-slot'));
    const url = urls[index];
    if (!url || !/^https:\/\/(?:[\w-]+\.)*alicdn\.com\//i.test(url)) throw failure('详情图片未取得有效的图片银行地址', 'image-layout');
    $(node).replaceWith($('<img>').attr('src', url).attr('style', 'max-width:100%;height:auto'));
    used.add(index);
  });
  if (used.size !== urls.length) throw failure('图片与原文占位数量不一致，未提交不完整详情', 'image-layout');
  return $.root().html() || '';
}

// Compare semantic content after the platform rerenders. HTML serialization
// may add tbody or change attribute order, while text, tables and media may not.
export function descriptionFingerprint(html) {
  const $ = load(html || '', null, false);
  const normalize = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const flow = []; let text = '';
  const flush = () => { if (normalize(text)) flow.push({ text: normalize(text) }); text = ''; };
  const visit = nodes => { for (const node of nodes) {
    if (node.type === 'text') text += node.data;
    else if (node.tagName === 'img') { flush(); flow.push({ image: $(node).attr('src') }); }
    else if (node.children) visit(node.children);
  } };
  visit($.root()[0].children); flush();
  return {
    text: normalize($.root().text()),
    flow,
    tables: $('table').toArray().map(table => $(table).find('tr').toArray().map(row => $(row).children('th,td').toArray().map(cell => ({
      text: normalize($(cell).text()), colspan: $(cell).attr('colspan') || '1', rowspan: $(cell).attr('rowspan') || '1',
    })))),
    images: $('img').toArray().map(node => $(node).attr('src')),
    links: $('a[href]').toArray().map(node => $(node).attr('href')),
  };
}

export function requireDescriptionMatch(expected, actual, stage = 'content-readback') {
  if (JSON.stringify(descriptionFingerprint(expected)) !== JSON.stringify(descriptionFingerprint(actual))) {
    throw failure('平台保存后的正文、表格或图片与待发布内容不一致，已停止提交', stage);
  }
}

async function setGalleryChecked(page, checkbox, checked) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await checkbox.isChecked()) { if (checked) return; }
    else if (!checked) return;
    await checkbox.setChecked(checked).catch(error => {
      if (!/did not change its state/i.test(error.message)) throw error;
    });
    const deadline = Date.now() + 2000;
    do {
      if (await checkbox.isChecked() === checked) return;
      await page.waitForTimeout(100);
    } while (Date.now() < deadline);
  }
  throw failure('图集选择未被平台接收，请重试', 'gallery-selection');
}

export async function resetStructuredGallery(page, rootId = 'detailImage') {
  const root = page.locator(`#${rootId}`);
  if (!await root.isVisible()) throw failure('未找到新版图集上传区', 'gallery');
  // A retry or an existing draft may contain earlier images. Replace only the
  // current product's form galleries after all source files have downloaded.
  for (let pass = 0; pass < 40; pass++) {
    const clear = root.getByText(/^(?:删除全部|Delete all)$/i).filter({ visible: true }).first();
    if (!await clear.count()) break;
    await clear.click();
    const dialog = page.locator('.next-dialog, [role="dialog"]').filter({ visible: true })
      .filter({ hasText: /确认删除全部图片|delete all (?:the )?images/i }).last();
    await dialog.getByRole('button', { name: /^(?:确认删除|Confirm deletion|Delete)$/i }).click({ timeout: 8000 });
    await dialog.waitFor({ state: 'hidden', timeout: 10000 });
  }
  if (await root.locator('.gallery-item-image img').count()) throw failure('旧图集尚未清理完成', 'gallery-reset');
  const selected = root.locator('input[type="checkbox"]:checked');
  for (let pass = 0; await selected.count() && pass < 40; pass++) {
    // Keep the identity after unchecking. A :checked locator would move to
    // the next gallery, or disappear while verifying the final selection.
    const value = await selected.first().getAttribute('value');
    const checkbox = value == null ? null : root.locator(`input[type="checkbox"][value=${JSON.stringify(value)}]`);
    if (!checkbox || await checkbox.count() !== 1) throw failure('原图集标识不唯一，无法确认清理结果', 'gallery-reset');
    await setGalleryChecked(page, checkbox, false);
  }
  if (await selected.count()) throw failure('原图集选择未清除', 'gallery-reset');
}

export async function assignStructuredImageFiles(page, input, files, { gallery, label, onProgress = () => {}, beforeInteraction = async () => {}, timeoutMs = 30000, receiptTimeoutMs = 5000 } = {}) {
  const expected = files.map(file => ({ name: path.basename(file), size: fs.statSync(file).size }));
  await beforeInteraction(gallery);
  try {
    await input.setInputFiles(files, { timeout: timeoutMs });
  } catch (error) {
    if (/Target.*closed|browser has been closed/i.test(error.message)
      || !/timeout|detached|not attached/i.test(error.message) || error.code) throw error;
    onProgress(`正在核对${label}的图片接收结果，未重复上传`);
    const end = Date.now() + receiptTimeoutMs;
    do {
      // Receipt reads do not require scrolling. Repeating interaction setup
      // here can hide a valid upload behind a second transient DOM-detach error.
      // FileList confirms the dispatch only, not upload success. The caller
      // must still verify every image URL, identity, order and native model.
      const selected = await input.evaluate(node => [...(node.files || [])].map(file => ({ name: file.name, size: file.size })), undefined, { timeout: 1000 })
        .catch(readError => {
          if (/Target.*closed|browser has been closed/i.test(readError.message)) throw readError;
          return [];
        });
      if (JSON.stringify(selected) === JSON.stringify(expected)) return;
      // React may remove the file input after accepting files. Receipts must
      // belong to this gallery and these files, never another upload widget.
      const images = await gallery.locator('.gallery-item-image img').evaluateAll(nodes => nodes.map(node => ({ name: node.alt, url: node.getAttribute('src') })));
      if (expected.every(file => images.filter(image => image.name === file.name && /^https:\/\/(?:[\w-]+\.)*alicdn\.com\//i.test(image.url || '')).length === 1)) return;
      await page.waitForTimeout(150);
    } while (Date.now() < end);
    throw Object.assign(new Error(`${label}图片接收结果未确认，已停止重复上传；请核对该图集后重试`), {
      code: 'PUBLISH_IMAGE_RECEIPT_UNKNOWN', diagnostics: { section: 'structured-images', stage: 'file-receipt', gallery: label,
        expectedCount: files.length, repeatedUpload: false }, cause: error,
    });
  }
}

export async function uploadStructuredImages(page, files, onProgress = () => {}, options = {}) {
  if (files.length > 30) throw failure(`当前图集最多接收 30 张图片，商品有 ${files.length} 张；请调整后重试`, 'image-limit');
  const root = page.locator(`#${options.rootId || 'detailImage'}`);
  if (options.reset !== false) await resetStructuredGallery(page, options.rootId);
  if (!files.length) return [];
  const group = options.galleryValue != null
    ? root.locator('label').filter({ has: page.locator(`input[type="checkbox"][value=${JSON.stringify(String(options.galleryValue))}]`) }).first()
    : root.locator('label').filter({ hasText: /Other product images|其他商品图片/i }).first();
  if (!await group.count()) throw failure('当前类目未提供可识别的商品图集，未猜测图片分类', 'gallery-category');
  await setGalleryChecked(page, group.locator('input[type="checkbox"]'), true);
  const gallery = options.galleryName ? root.locator('.gallery-item-container').filter({ has: page.locator('.gallery-item-header-en-name').filter({ hasText: new RegExp(`^${options.galleryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }) : root;
  if (options.galleryName) await until(page, async () => {
    const count = await gallery.count();
    if (count > 1) throw failure(`未能唯一识别图集 ${options.galleryName}`, 'gallery-category');
    return count === 1;
  }, `图集 ${options.galleryName} 勾选后的上传区域仍未加载`, 'gallery-category');
  const galleryLabel = `${options.rootId === 'companyImage' ? '公司图片' : '详情图片'}${options.galleryName ? ` / ${options.galleryName}` : ''}`;
  onProgress(`准备上传${galleryLabel}，共 ${files.length} 张`);
  const input = gallery.locator('input[type="file"]');
  let ready = false, entryError;
  for (let attempt = 0; attempt < 3; attempt++) {
    await options.beforeInteraction?.(gallery);
    // The real input may already exist while the hover wrapper is hidden or
    // animating. Use that input directly; hovering does not upload a file.
    if (await input.count() === 1 && await input.isEnabled()) { ready = true; break; }
    if (await input.count() > 1) throw failure(`${galleryLabel}存在多个上传入口，无法唯一确认`, 'image-entry');
    const trigger = gallery.locator('.upload-button-container .image-upload-wrapper').filter({ visible: true }).last();
    try {
      if (await trigger.count()) {
        await options.beforeInteraction?.(trigger);
        await trigger.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
        await trigger.hover({ timeout: options.entryTimeoutMs || 4000 });
      }
      await input.waitFor({ state: 'attached', timeout: options.entryTimeoutMs || 4000 });
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      entryError = error;
    }
    // A hover timeout may still have mounted the native input. Read it before
    // another harmless hover, never repeat setInputFiles after uncertainty.
    if (await input.count() === 1 && await input.isEnabled()) { ready = true; break; }
  }
  if (!ready) throw Object.assign(failure(`${galleryLabel}上传入口未就绪，请重试该商品`, 'image-entry'), {
    cause: entryError, diagnostics: { reason: 'new-description-editor', stage: 'image-entry',
      rootId: options.rootId || 'detailImage', galleryName: options.galleryName || '', attempts: 3 },
  });
  const expected = files.map(file => path.basename(file));
  if (new Set(expected).size !== expected.length) throw failure('详情图片缓存名称重复，无法核对上传结果', 'image-identity');
  const assign = selected => assignStructuredImageFiles(page, input, selected, {
    gallery, label: galleryLabel, onProgress, beforeInteraction: options.beforeInteraction,
  });
  if (options.ordered) {
    // The native gallery appends images in completion order, unlike the rich
    // editor where HTML can restore their positions. Commit each upload before
    // starting the next so native model order is also the source order.
    for (const [index, file] of files.entries()) {
      await assign([file]);
      await until(page, async () => {
        const errors = await gallery.locator('.placeholder-error, .gallery-item-error').filter({ visible: true }).allTextContents();
        const rejected = errors.filter(text => text.trim() && !/勾选该图集后至少上传一张图片|at least one (?:image|picture)/i.test(text));
        if (rejected.length) throw failure(rejected.join('；'), 'image-upload');
        const names = await gallery.locator('.gallery-item-image img').evaluateAll(nodes => nodes.map(node => node.alt));
        onProgress(`上传新版详情图集 ${options.galleryName || ''} ${names.length}/${files.length}`);
        if (names.length !== index + 1 || await gallery.locator('.placeholder-uploading').count()) return false;
        if (JSON.stringify(names) !== JSON.stringify(expected.slice(0, index + 1))) throw failure('原生图集图片顺序与来源不同', 'image-order');
        return true;
      }, '等待原生图集图片接收超时', 'image-upload', 120000);
    }
  } else await assign(files);
  const uploaded = await until(page, async () => {
    const errors = await gallery.locator('.placeholder-error, .gallery-item-error, .sell-error-message').filter({ visible: true }).allTextContents();
    // Selecting an empty gallery validates it before React mounts the upload
    // placeholders. That stale required hint is not an upload rejection.
    const rejected = errors.filter(text => text.trim() && !/勾选该图集后至少上传一张图片|at least one (?:image|picture)/i.test(text));
    if (rejected.length) throw failure(rejected.join('；'), 'image-upload');
    const images = await gallery.locator('.gallery-item-image img').evaluateAll(nodes => nodes.map(node => ({ name: node.alt, url: node.getAttribute('src') })));
    onProgress(`上传${galleryLabel} ${images.length}/${files.length}`);
    // An empty rerender and a stale required hint do not prove an upload was
    // rejected. Keep reading the original dispatch; never send those files a
    // second time while the platform may still be processing the first upload.
    if (images.length !== files.length || await gallery.locator('.placeholder-uploading').count()) return false;
    return expected.map(name => {
      const found = images.filter(image => image.name === name);
      if (found.length !== 1) throw failure('平台返回的图片名称与待上传图片不一致', 'image-identity');
      return found[0].url;
    });
  }, '等待图片上传完成超时', 'image-upload', 120000);
  return uploaded;
}

async function editorFrame(page) {
  await page.locator(editorSelector).waitFor({ state: 'visible', timeout: 30000 });
  return until(page, () => page.locator(editorSelector).elementHandle().then(node => node?.contentFrame()), '详情编辑器尚未加载', 'frame');
}

export async function openStructuredEditor(page, { previewTimeout = 90000 } = {}) {
  if (!await page.locator(editorSelector).isVisible().catch(() => false)) {
    if (!await waitForStructuredEditorEntry(page)) throw failure('未找到可用的新版详情编辑入口', 'entry');
    const open = page.getByText(/^(?:AI详情编辑器|AI (?:Product )?Detail Editor)$/i).filter({ visible: true }).first();
    if (await open.count()) await open.click();
    else {
      const generate = page.getByText(/^(?:详描通用排版|General detail layout)$/i).filter({ visible: true }).first();
      if (!await generate.count()) throw failure('未找到可用的新版详情编辑入口', 'entry');
      await generate.click();
      await page.getByText(/^(?:通用排版|General layout)$/i, { exact: true }).click({ timeout: 8000 });
      await page.getByRole('button', { name: /^(?:开始生成|Start generating)$/i }).click({ timeout: 8000 });
    }
  }
  let frame = await editorFrame(page);
  let lastApply = 0, lastConfirmation = 0;
  const clickPreview = async control => {
    try { await control.click({ timeout: 1500 }); }
    catch (error) {
      // Applying the preview can replace its button before Playwright dispatches
      // the click. Re-read the resulting editor state; a click timeout alone
      // proves neither failure nor success. Never retry a save/publish here.
      if (page.isClosed() || !/Timeout.*exceeded|detached|Execution context was destroyed/i.test(error.message)) throw error;
    }
  };
  await until(page, async () => {
    if (frame.isDetached()) frame = await editorFrame(page);
    if (await frame.getByRole('button', { name: /^(?:Editing completed|编辑完成)$/ }).isVisible().catch(() => false)) return true;
    // The preview button can become enabled before the generated page arrives.
    // Applying too early is ignored by Alibaba; retry only this known preview.
    const confirmation = frame.getByRole('button', { name: /^(?:Confirmation of application|确认应用)$/ });
    if (await confirmation.isVisible().catch(() => false)) {
      if (Date.now() - lastConfirmation > 3500) {
        lastConfirmation = Date.now(); lastApply = lastConfirmation;
        await clickPreview(confirmation);
      }
      return false;
    }
    const apply = frame.getByRole('button', { name: /Confirm the application and go to Edit|确认应用.*编辑/i });
    const loading = frame.getByText(/^(?:Page loading, please wait|页面加载中.*)$/);
    if (Date.now() - lastApply > 3500 && await apply.isVisible().catch(() => false)
      && !await loading.isVisible().catch(() => false)) { lastApply = Date.now(); await clickPreview(apply); }
    return false;
  }, '新版详情生成预览未就绪', 'generated-preview', previewTimeout);
  await frame.locator('.editor-component-row').first().waitFor({ state: 'attached', timeout: 15000 });
  return frame;
}

export async function clearStructuredModules(page, frame) {
  // Remove through native controls so the editor's saved model changes as well
  // as its DOM. Navigation groups require a separate content-delete choice.
  for (let pass = 0; pass < 100; pass++) {
    const rows = frame.locator('.editor-component-row');
    const row = frame.locator('.editor-component-row:not([data-component-group-name$="@_@themeConfig"]):not([data-component-group-name$="@_@divider"])').first();
    if (!await row.count()) return;
    const before = await rows.count();
    await row.scrollIntoViewIfNeeded();
    await row.locator('[data-edit-type]').first().waitFor({ state: 'attached', timeout: 15000 });
    await row.click({ position: { x: 20, y: 20 }, timeout: 10000 });
    const buttons = frame.locator('.editor-component-row.active .editor-canvas-handler-btn');
    await buttons.last().click({ timeout: 5000 });
    const removeGroup = frame.getByRole('button', { name: /^(?:Delete navigation and (?:its )?content|删除导航(?:及其|及|和)内容)$/i });
    await until(page, async () => {
      if (await removeGroup.isVisible().catch(() => false)) await removeGroup.click();
      return await rows.count() < before;
    }, '模板内容删除后未生效', 'module-reset', 8000);
  }
  throw failure('模板模块过多，未能完成清理', 'module-reset');
}

export async function writeStructuredHtml(page, frame, html, highlights = '') {
  if (highlights.length > 2000) throw failure('商品卖点超过平台 2000 字符限制，请调整后重试', 'highlights-limit');
  await clearStructuredModules(page, frame);
  if (highlights) {
    const menu = frame.getByText('Product Highlights', { exact: true }).last();
    await (await menu.count() ? menu : frame.getByText('商品卖点', { exact: true }).last()).click();
    const field = frame.locator('.highlights-content-editor');
    await field.waitFor({ timeout: 15000 });
    await field.fill(highlights); await field.press('Tab');
    await until(page, async () => (await field.innerText()).trim() === highlights.trim(), '商品卖点未完整保存', 'highlights-write', 8000);
  }
  await frame.getByText(/^(?:Text|文本)$/, { exact: true }).last().click();
  await frame.locator('.menu-item-wrap-tag').filter({ has: frame.getByText(/^(?:Plain text|纯文本)$/, { exact: true }) })
    .locator('.manager__item-thumbnail').click({ timeout: 8000 });
  const target = frame.locator(textSelector);
  await target.waitFor({ state: 'visible', timeout: 20000 });
  await target.evaluate((node, value) => {
    node.focus();
    const selection = node.ownerDocument.getSelection();
    const range = node.ownerDocument.createRange();
    range.selectNodeContents(node); selection.removeAllRanges(); selection.addRange(range);
    node.ownerDocument.execCommand('insertHTML', false, value);
    node.blur();
  }, html);
  await frame.locator('.header-title').click();
  // Native blur replaces the contenteditable node and commits its rich HTML.
  await until(page, async () => {
    try { requireDescriptionMatch(html, await target.innerHTML()); return true; } catch { return false; }
  }, '编辑器未完整接收正文、表格或图片', 'content-write', 8000);
}

export async function finishStructuredEditor(page, frame) {
  await frame.getByRole('button', { name: /^(?:Editing completed|编辑完成)$/ }).click();
  await until(page, async () => {
    if (!await page.locator(editorSelector).isVisible().catch(() => false)) return true;
    const sync = frame.getByRole('button', { name: /^(?:Confirm synchronization|确认同步)$/i });
    if (await sync.isVisible().catch(() => false)) await sync.click();
    return false;
  }, '平台尚未保存详情或手机端同步未完成', 'save-and-sync', 45000);
}

export function imageOnlyNativeStructure(html, imageUrls, highlights = '') {
  const $ = load(html || '', null, false);
  if ($('table, a[href], video, iframe, svg').length || $.root().text().trim()) return null;
  const images = $('img, [data-workbench-source-image], [data-workbench-image-slot]').toArray();
  if (!images.length || images.length !== imageUrls.length) return null;
  const slots = images.map(node => Number($(node).attr('data-workbench-source-image') ?? $(node).attr('data-workbench-image-slot')));
  if (slots.some((slot, i) => slot !== i) || images.some(node => $(node).attr('title'))) return null;
  return { version: 1, source: 'image-only-description', modules: [
    ...(highlights ? [{ type: 'highlights', items: highlights.split('\n') }] : []),
    { type: 'gallery', scope: 'product', title: 'Other product images', images: imageUrls.map(url => ({ url, caption: '' })) },
  ] };
}

export async function waitForStructuredEditorEntry(page, timeoutMs = 10000) {
  const entry = page.getByText(/^(?:详描通用排版|General detail layout|AI详情编辑器|AI (?:Product )?Detail Editor)$/i).filter({ visible: true });
  if (await entry.count()) return true;
  await revealDescriptionSection(page);
  // The layout button is mounted below the native image/text fields. Merely
  // observing #detailImage does not mean the editor entry has loaded yet.
  const mode = await page.evaluate(() => window.GlobalStore?.engine?.getModels()?.formValues?.productDescType?.value);
  const anchors = mode === 5 ? ['#magicEditor', '#struct-magicEditor']
    : ['#companyFaqDesc', '#struct-companyFaqDesc', '#magicEditor', '#struct-magicEditor'];
  for (const selector of anchors) {
    const anchor = page.locator(selector).first();
    // Keep the required editor in view while it mounts. Scrolling through all
    // anchors moves a saved magic editor offscreen and cancels lazy loading.
    // An unmounted magic editor has width but zero height, so Playwright's
    // visible filter excludes the very placeholder that triggers its loading.
    if (await anchor.count() && await anchor.evaluate(node => node.getClientRects().length > 0
      && getComputedStyle(node).visibility !== 'hidden')) { await anchor.scrollIntoViewIfNeeded(); break; }
  }
  try { await entry.first().waitFor({ state: 'visible', timeout: timeoutMs }); return true; }
  catch (error) { if (page.isClosed() || !/Timeout/i.test(error.message)) throw error; return false; }
}

// Run before changing any product fields. A crashed/lazy editor can recover
// through the publisher's single form-navigation retry at this point without
// discarding edits or replaying a save/submit request.
export async function requireStructuredDescriptionReady(page, { html, structure, imageUrls = [], highlights = '', timeoutMs = 15000 }) {
  const mode = await page.evaluate(() => window.GlobalStore?.engine?.getModels()?.formValues?.productDescType?.value);
  if (![4, 5].includes(mode)) return;
  if (mode === 4 && (structure || imageOnlyNativeStructure(html, imageUrls, highlights))) return;
  if (await waitForStructuredEditorEntry(page, timeoutMs)) return;
  throw Object.assign(new Error('国际站新版详情编辑器未加载完成，尚未填写或提交商品'), {
    code: 'PUBLISH_FORM_NOT_READY', diagnostics: { reason: 'new-description-editor', stage: 'entry-before-fill', mode },
  });
}

export async function fillStructuredDescription(page, { html, files, highlights = '', onProgress = () => {}, structure, imageUrls = [], beforeInteraction = async () => {} }) {
  acceptedDescriptions.delete(page);
  if (!structure && highlights.length > 2000) throw failure('商品卖点超过平台 2000 字符限制，请调整后重试', 'highlights-limit');
  const preparation = await prepareStructuredDescriptionImages(files, onProgress);
  files = preparation.files;
  if (!structure && await page.evaluate(() => window.GlobalStore?.engine?.getModels()?.formValues?.productDescType?.value) === 4) {
    structure = imageOnlyNativeStructure(html, imageUrls, highlights);
  }
  if (structure) {
    const currentMode = await page.evaluate(() => window.GlobalStore?.engine?.getModels()?.formValues?.productDescType?.value);
    if (currentMode !== 4) throw failure('当前详情使用装修编辑器，请切回原生结构化详情后重试', 'native-mode');
    onProgress('检查新版详情：商品卖点、公司介绍和 FAQ');
    const plan = compileNativeDescription(structure, await nativeDescriptionSchemas(page));
    const indexes = plan.galleries.flatMap(group => group.images.map(image => imageUrls.indexOf(image.url)));
    if (indexes.some(index => index < 0 || !files[index]) || new Set(indexes).size !== files.length) {
      throw failure('原生图集与当前详情图片不一致，请检查图片编辑后重试', 'native-image-mapping');
    }
    await fillNativeDescriptionText(page, plan, { beforeInteraction, onProgress });
    for (const rootId of ['detailImage', 'companyImage']) {
      const root = page.locator(`#${rootId}`);
      if (await root.count()) { await beforeInteraction(root); await resetStructuredGallery(page, rootId); }
    }
    for (const gallery of plan.galleries) {
      await beforeInteraction(page.locator(`#${gallery.rootId}`));
      await resolveNativeGallery(page, gallery, beforeInteraction);
      gallery.urls = await uploadStructuredImages(page, gallery.images.map(image => files[imageUrls.indexOf(image.url)]), onProgress, {
        rootId: gallery.rootId, galleryValue: gallery.value, galleryName: gallery.name, reset: false, ordered: true, beforeInteraction,
      });
    }
    await waitForNativeDescriptionFields(page, plan);
    const mode = await page.evaluate(() => window.GlobalStore?.engine?.getModels()?.formValues?.productDescType?.value);
    if (mode !== 4) throw failure('当前详情使用装修编辑器，请切回原生结构化详情后重试', 'native-mode');
    acceptedDescriptions.set(page, { url: page.url(), highlights, nativePlan: plan,
      structure: JSON.stringify(descriptionStructureFingerprint(structure)), identity: await savedDescriptionIdentity(page) });
    return { native: true, plan, imageAdjustments: preparation.adjustments };
  }
  if (highlights.length > 2000) throw failure('商品卖点超过平台 2000 字符限制，请调整后重试', 'highlights-limit');
  // Validate the entry before changing existing form data.
  if (!await waitForStructuredEditorEntry(page)) {
    throw failure('未找到可用的新版详情编辑入口', 'entry');
  }
  const urls = await uploadStructuredImages(page, files, onProgress);
  const content = restoreStructuredImages(html, urls);
  const highlightsInput = page.locator('#textDesc [contenteditable="true"]').filter({ visible: true });
  if (highlights && await highlightsInput.count()) { await highlightsInput.fill(highlights); await highlightsInput.press('Tab'); }
  onProgress('填写新版详情并保留原文排版');
  const frame = await openStructuredEditor(page);
  await writeStructuredHtml(page, frame, content, highlights);
  await finishStructuredEditor(page, frame);
  onProgress('重新打开新版详情，核对实际保存内容');
  const reopened = await openStructuredEditor(page);
  await reopened.locator(textSelector).waitFor({ timeout: 25000 });
  requireDescriptionMatch(content, await reopened.locator(textSelector).innerHTML(), 'saved-readback');
  if (highlights) {
    await reopened.locator('.highlights-content-editor').waitFor({ timeout: 15000 });
    if ((await reopened.locator('.highlights-content-editor').innerText()).trim() !== highlights.trim()) throw failure('重新打开后商品卖点与原内容不一致', 'highlights-readback');
  }
  await finishStructuredEditor(page, reopened);
  acceptedDescriptions.set(page, { url: page.url(), highlights, identity: await savedDescriptionIdentity(page) });
  return { html: content, uploadedImages: urls, imageAdjustments: preparation.adjustments };
}
