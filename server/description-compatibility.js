import { load } from 'cheerio';
import { currentDescriptionStructure, descriptionSourceHash, materializeLegacyFaqHtml } from './description-structure.js';
import { descriptionFingerprint } from './structured-description.js';

const receipts = new WeakMap();
const normalize = value => String(value || '').normalize('NFKC').replace(/\s+/g, '');
const failure = stage => Object.assign(new Error('详情兼容转换未能完整保留正文、表格或图片，已保留原始资料，尚未提交商品'), {
  code: 'PUBLISH_DESCRIPTION_COMPATIBILITY_INCOMPLETE', diagnostics: { stage },
});

export function compatibleDescriptionFingerprint(html) {
  const $ = load(html || '', null, false);
  // TinyMCE trims text at block edges. Block boundaries still separate words;
  // whitespace within inline text remains significant and is not discarded.
  $('p,div,section,h1,h2,h3,h4,h5,h6,li,ul,ol,table,thead,tbody,tfoot,tr,td,th,blockquote').each((_, node) => {
    $(node).prepend(' ').append(' ');
  });
  $('br,hr').replaceWith(' ');
  return descriptionFingerprint($.root().html());
}

function requireMatch(expected, actual, stage) {
  const left = compatibleDescriptionFingerprint(expected), right = compatibleDescriptionFingerprint(actual);
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    const error = failure(stage);
    error.diagnostics.differences = Object.keys(left).filter(key => JSON.stringify(left[key]) !== JSON.stringify(right[key]));
    // Available to the isolated QA recorder, omitted from normal diagnostics.
    Object.defineProperty(error, 'descriptionComparison', { value: { expected, actual } });
    throw error;
  }
}

export function descriptionCompatibilityKey(product) {
  return descriptionSourceHash(JSON.stringify([product.descriptionHtml, currentDescriptionStructure(product), product.detailImages]));
}

// Start with all current HTML, including content outside native modules. Never
// rebuild only a subset of modules or resurrect a stale original snapshot.
export function compatibleLegacyDescriptionHtml(product, html) {
  const structure = currentDescriptionStructure(product);
  if (!structure?.modules?.length) throw failure('source-modules');
  const $ = load(materializeLegacyFaqHtml(product, html, structure) || '', null, false);
  const text = normalize($.root().text());
  const urls = [...new Set(product.detailImages || [])];
  for (const module of structure.modules) {
    let facts, anchor;
    if (module.type === 'highlights') facts = module.items;
    else if (module.type === 'company') facts = [module.text];
    else if (module.type === 'faq') facts = module.items.flatMap(item => [item.question, item.answer]);
    else if (module.type === 'html') {
      const content = load(module.html || '', null, false);
      facts = [content.text()];
      // Tables must keep cell boundaries and spans, not just concatenated text.
      for (const table of content('table').toArray()) {
        const tableText = normalize(content(table).text());
        const actual = $('table').toArray().find(node => normalize($(node).text()) === tableText);
        if (!actual) throw failure('source-table');
        if (JSON.stringify(descriptionFingerprint(content(table).toString()).tables)
          !== JSON.stringify(descriptionFingerprint($(actual).toString()).tables)) throw failure('source-table-cells');
      }
    } else if (module.type === 'gallery') {
      facts = module.images.map(image => image.caption).filter(Boolean);
      for (const image of module.images) {
        const index = urls.indexOf(image.url);
        const slot = $(`[data-workbench-source-image="${index}"]`);
        if (index < 0 || !slot.length) throw failure('source-image');
        anchor ||= slot.first();
      }
    } else throw failure('unsupported-module');
    if (facts.some(value => normalize(value) && !text.includes(normalize(value)))) throw failure(`source-${module.type}`);
    if (module.title && !$('*').toArray().some(node => normalize($(node).text()) === normalize(module.title))) {
      const first = facts.find(value => normalize(value));
      anchor ||= first && $('*').filter((_, node) => normalize($(node).text()).includes(normalize(first))).last();
      if (!anchor?.length) throw failure('module-title');
      anchor.before($('<h3>').text(module.title));
    }
  }
  return $.root().html() || '';
}

async function readLegacyContent(page) {
  const model = await page.evaluate(() => {
    const value = window.GlobalStore?.engine?.getModels()?.formValues?.superText;
    const editor = [...(window.tinymce?.editors || []), ...(window.tinyMCE?.editors || [])].find(item => item && !item.hidden);
    return { model: typeof value === 'string' ? value : value?.value, editor: editor?.getContent?.() };
  });
  for (const frame of page.frames()) {
    const body = frame.locator('body.mce-content-body, body[contenteditable="true"]').first();
    if (await body.isVisible().catch(() => false)) return { ...model, html: await body.innerHTML() };
  }
  throw failure('editor-missing');
}

export async function acceptCompatibleLegacyDescription(page, product, html) {
  const $ = load(html, null, false);
  const urls = $('img').toArray().map(node => $(node).attr('src'));
  if ($('[data-workbench-source-image]').length || urls.length < new Set(product.detailImages || []).size
    || urls.some(url => !/^(?:https?:)?\/\/(?:[\w-]+\.)*alicdn\.com\//i.test(url))) throw failure('uploaded-image-address');
  const expected = html;
  const deadline = Date.now() + 2500;
  for (;;) {
    const actual = await readLegacyContent(page);
    requireMatch(expected, actual.html, 'compatibility-editor');
    if (typeof actual.editor === 'string') requireMatch(expected, actual.editor, 'compatibility-editor-model');
    try { if (typeof actual.model === 'string') requireMatch(expected, actual.model, 'compatibility-form-model'); }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await page.waitForTimeout(100);
      continue;
    }
    break;
  }
  receipts.set(page, { url: page.url(), key: descriptionCompatibilityKey(product), html: expected });
}

export async function requireCompatibleLegacyDescription(page, product) {
  const receipt = receipts.get(page);
  if (!receipt || receipt.url !== page.url() || receipt.key !== descriptionCompatibilityKey(product)) throw failure('receipt-missing');
  const actual = await readLegacyContent(page);
  requireMatch(receipt.html, actual.html, 'compatibility-before-submit');
  if (typeof actual.editor === 'string') requireMatch(receipt.html, actual.editor, 'compatibility-editor-model');
  if (typeof actual.model === 'string') requireMatch(receipt.html, actual.model, 'compatibility-form-model');
}
