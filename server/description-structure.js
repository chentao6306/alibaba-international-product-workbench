import { createHash } from 'node:crypto';
import { load } from 'cheerio';

const text = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
export const descriptionSourceHash = html => createHash('sha256').update(String(html || '')).digest('hex');

// Read the native module identities before description sanitization removes
// classes. A decorated page containing a single text module is NOT evidence
// that the original highlights, company galleries and FAQ were transferred.
export function extractDescriptionStructure(html) {
  const $ = load(html || '', null, false);
  const sections = $('[data-module-name^="module_structure_descption_"]').toArray();
  if (sections.length) {
    const modules = [];
    for (const node of sections) {
      const root = $(node), name = root.attr('data-module-name');
      if (name.endsWith('_faqInfo')) {
        modules.push({ type: 'faq', title: text(root.find('[data-testid="product-detail-title"]').first().text()),
          items: root.find('[data-testid="product-detail-qa"]').children().toArray().map(row => ({
            question: text($(row).children().eq(0).text()), answer: text($(row).children().eq(1).text()),
          })) });
        continue;
      }
      if (!name.endsWith('_productDescription') && !name.endsWith('_companyInfo')) {
        if (text(root.text()) || root.find('img,table').length) modules.push({ type: 'html', html: root.html() });
        continue;
      }
      const company = name.endsWith('_companyInfo');
      let gallery = null, highlights = null, heading = '';
      const items = root.find('[data-testid="product-detail-title"], [data-testid="product-detail-text"], [data-testid="product-detail-text-sort"], [data-testid="product-detail-image-simple"]').toArray();
      for (const item of items) {
        const entry = $(item), kind = entry.attr('data-testid');
        if (kind === 'product-detail-title') { heading = text(entry.text()); gallery = null; }
        else if (kind === 'product-detail-text-sort') {
          if (!highlights) { highlights = { type: 'highlights', title: 'Highlights at a glance', items: [] }; modules.push(highlights); }
          highlights.items.push(text(entry.text()));
          heading = '';
        } else if (kind === 'product-detail-text') {
          if (company && !modules.some(m => m.type === 'company')) modules.push({ type: 'company', title: heading, text: text(entry.text()) });
          else modules.push({ type: 'html', html: entry.html() });
          heading = ''; gallery = null;
        } else {
          if (!gallery) { gallery = { type: 'gallery', title: heading, scope: company ? 'company' : 'product', images: [] }; modules.push(gallery); }
          entry.find('img').each((_, image) => gallery.images.push({ url: $(image).attr('src') || '', caption: '' }));
        }
      }
    }
    if (modules.length) return { version: 1, source: 'alibaba-structured-sections', sourceHtmlHash: descriptionSourceHash(html), modules };
  }
  const roots = $('[module-name*="detailStructured"]').toArray()
    .filter(node => !$(node).parents('[module-name*="detailStructured"]').length);
  if (!roots.length) return null;
  const modules = [];
  let gallery;
  for (const node of roots) {
    const root = $(node);
    const group = root.closest('[data-component-group-name]').attr('data-component-group-name') || '';
    const title = selector => text(root.find(selector).first().text());
    if (root.find('.comp-highlights-list').length) {
      gallery = null;
      const list = root.find('.comp-highlights-list li').toArray().map(n => text($(n).text())).filter(Boolean);
      modules.push({ type: 'highlights', title: title('.comp-highlights-title'), items: list.length ? list : [title('.comp-highlights-list')].filter(Boolean) });
    } else if (root.find('.comp-companyintroduction-text').length) {
      gallery = null;
      modules.push({ type: 'company', title: title('.comp-companyintroduction-title'), text: title('.comp-companyintroduction-text') });
    } else if (root.find('.comp-faq-card').length) {
      gallery = null;
      modules.push({ type: 'faq', title: title('.comp-faq-title'), items: root.find('.comp-faq-card').toArray().map(n => ({
        question: text($(n).find('.comp-faq-question').text()), answer: text($(n).find('.comp-faq-answer').text()),
      })) });
    } else if (root.find('.comp-navigation-sib').length) {
      gallery = { type: 'gallery', title: title('.comp-navigation-sib'), scope: group.startsWith('company-gallery@_@') ? 'company' : 'product', images: [] };
      modules.push(gallery);
    } else if (root.find('.comp-singleimg-img').length) {
      if (!gallery) {
        gallery = { type: 'gallery', title: '', scope: group.startsWith('company-gallery@_@') ? 'company' : 'product', images: [] };
        modules.push(gallery);
      }
      for (const image of root.find('.comp-singleimg-img').toArray()) {
        const url = $(image).attr('data-src') || $(image).attr('src') || '';
        gallery.images.push({ url, caption: title('.comp-singleimg-text') });
      }
    } else if (root.find('video').length || /@_@(?:VideoShow|themeConfig|divider)$/.test(group)
      || root.find('.comp-divider-no-line,.comp-divider-line').length) {
      // Videos have their own upload/association workflow. Theme/divider rows
      // are presentation, not invented product or supplier facts.
      continue;
    } else {
      gallery = null;
      const content = root.find('.comp-singletext-text');
      const value = content.length ? content.html() : root.html();
      if (text(root.text()) || root.find('img,table').length) modules.push({ type: 'html', html: value });
    }
  }
  if (!modules.some(module => ['highlights', 'company', 'faq', 'gallery'].includes(module.type))) return null;
  return { version: 1, source: 'alibaba-native-description', sourceHtmlHash: descriptionSourceHash(html), modules };
}

export function currentDescriptionStructure(product) {
  if (product.descriptionTemplate) return null;
  const html = product.descriptionHtml || '';
  const saved = product.structuredDescription;
  // Never resurrect the original module data after a manual rich-text edit.
  const current = saved?.version === 1 && saved.sourceHtmlHash === descriptionSourceHash(html)
    ? structuredClone(saved) : extractDescriptionStructure(html);
  return recoverSanitizedFaq(product, current);
}

function recoverSanitizedFaq(product, current) {
  const source = product.source;
  const snapshot = source?.snapshot;
  // The old sanitizer removed contact questions from HTML while keeping the
  // complete FAQ in the immutable structured snapshot. Repair only this proven
  // inconsistency, never fill arbitrary empty fields from a previous edit.
  if (!current || !snapshot || source.snapshotHashVersion !== 2 || !source.snapshotHash
    || source.snapshotHash !== descriptionSourceHash(JSON.stringify(snapshot))) return current;
  if (product.sourceId && snapshot.sourceId && String(product.sourceId) !== String(snapshot.sourceId)) return current;
  const original = snapshot.structuredDescription;
  if (original?.version !== 1 || original.sourceHtmlHash !== descriptionSourceHash(snapshot.descriptionHtml || '')) return current;
  const faqModules = structure => (structure?.modules || []).filter(module => module.type === 'faq');
  const originals = faqModules(original), baselines = faqModules(extractDescriptionStructure(snapshot.descriptionHtml)), active = faqModules(current);
  if (originals.length !== 1 || baselines.length !== 1 || active.length !== 1) return current;
  if (![originals[0], baselines[0], active[0]].every(module => Array.isArray(module.items))) return current;
  const normalize = items => items.map(item => ({ question: text(item.question), answer: text(item.answer) }));
  const expected = normalize(originals[0].items), baseline = normalize(baselines[0].items), actual = normalize(active[0].items);
  if (expected.length !== baseline.length || JSON.stringify(actual) !== JSON.stringify(baseline)) return current;
  const repaired = [];
  for (let index = 0; index < expected.length; index++) {
    if (JSON.stringify(expected[index]) === JSON.stringify(baseline[index])) continue;
    if (baseline[index].question || !baseline[index].answer || expected[index].answer !== baseline[index].answer
      || !/\bcontact us\b/i.test(expected[index].question)
      || /@|\d|\b(?:tel|phone|whatsapp|wechat|skype)\b/i.test(expected[index].question)) return current;
    repaired.push(index);
  }
  for (const index of repaired) active[0].items[index].question = originals[0].items[index].question;
  if (repaired.length) current.repairs = [...(current.repairs || []), {
    reason: 'legacy-faq-question-cleanup', source: 'source.snapshot.structuredDescription', rows: repaired.map(index => index + 1),
  }];
  return current;
}

// Video players may render their poster as an ordinary img in the description
// DOM. Keep that asset on the video, but do not treat it as an extra native
// gallery image. Only remove a confirmed poster absent from the saved modules;
// an edited image list or an image also used by a gallery remains authoritative.
export function nativeDescriptionImageUrls(product, structure = currentDescriptionStructure(product)) {
  const images = product.detailImages || [];
  if (!structure || product.imageEdits?.detail) return images;
  const galleryImages = new Set(structure.modules.filter(module => module.type === 'gallery')
    .flatMap(module => module.images.map(image => image.url)));
  const posters = new Set((product.videos || []).filter(video => video.role === 'detail' && video.url && video.poster)
    .map(video => video.poster));
  return images.filter(url => galleryImages.has(url) || !posters.has(url));
}

export function descriptionStructureFingerprint(structure) {
  return (structure?.modules || []).map(module => {
    if (module.type === 'highlights') return { type: module.type, title: text(module.title), items: module.items.map(text) };
    if (module.type === 'company') return { type: module.type, title: text(module.title), text: text(module.text) };
    if (module.type === 'faq') return { type: module.type, title: text(module.title), items: module.items.map(item => ({ question: text(item.question), answer: text(item.answer) })) };
    if (module.type === 'gallery') return { type: module.type, title: text(module.title), scope: module.scope,
      images: module.images.map(image => ({ url: image.url, caption: text(image.caption) })) };
    return { type: module.type, html: module.html };
  });
}

export function requireDescriptionStructure(expected, actual) {
  if (JSON.stringify(descriptionStructureFingerprint(expected)) !== JSON.stringify(descriptionStructureFingerprint(actual))) {
    throw Object.assign(new Error('新版详情的卖点、公司介绍、图集或 FAQ 模块未完整保存，已停止提交'), {
      code: 'PUBLISH_DESCRIPTION_STRUCTURE_MISMATCH', diagnostics: { reason: 'native-description-modules',
        expectedTypes: (expected?.modules || []).map(m => m.type), actualTypes: (actual?.modules || []).map(m => m.type) },
    });
  }
}
