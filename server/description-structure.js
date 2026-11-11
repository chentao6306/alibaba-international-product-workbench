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

// Old collection cleanup removed whole FAQ spans containing "contact us" but
// retained their text in the structured snapshot. Materialize only that proven
// loss in the detached legacy conversion, after checking the real source hash,
// every FAQ row and the current module. Never fill arbitrary blank user edits.
export function materializeLegacyFaqHtml(product, html, current = currentDescriptionStructure(product)) {
  const source = product.source, snapshot = source?.snapshot;
  if (product.descriptionTemplate || !current || !snapshot || source.snapshotHashVersion !== 2
    || source.snapshotHash !== descriptionSourceHash(JSON.stringify(snapshot))) return html;
  if (product.sourceId && snapshot.sourceId && String(product.sourceId) !== String(snapshot.sourceId)) return html;
  const original = snapshot.structuredDescription;
  if (original?.version !== 1 || original.sourceHtmlHash !== descriptionSourceHash(snapshot.descriptionHtml || '')) return html;
  const faqItems = structure => {
    const modules = (structure?.modules || []).filter(module => module.type === 'faq');
    return modules.length === 1 && Array.isArray(modules[0].items)
      ? modules[0].items.map(item => ({ question: text(item.question), answer: text(item.answer) })) : null;
  };
  const expected = faqItems(original), baseline = faqItems(extractDescriptionStructure(snapshot.descriptionHtml));
  const active = faqItems(current), currentHtml = faqItems(extractDescriptionStructure(product.descriptionHtml));
  if (!expected?.length || !baseline || expected.length !== baseline.length
    || JSON.stringify(active) !== JSON.stringify(expected) || JSON.stringify(currentHtml) !== JSON.stringify(baseline)) return html;
  const repairs = [];
  for (const [index, item] of expected.entries()) {
    // At least one surviving field must identify each repaired row.
    if (!baseline[index].question && !baseline[index].answer) return html;
    for (const field of ['question', 'answer']) {
      if (item[field] === baseline[index][field]) continue;
      if (baseline[index][field] || !/\bcontact us\b/i.test(item[field])
        || /@|\b(?:tel(?:ephone)?|phone)\b\s*[:：]?\s*\+?\d[\d ()-]{5,}\d\b|\b(?:whats?app|wechat|skype)\b\s*(?:[:：]|(?:id|account|number)\s*[:：]?)\s*[+\w@.-]{4,}/i.test(item[field])) return html;
      repairs.push({ index, field, value: item[field] });
    }
  }
  if (!repairs.length) return html;
  const $ = load(html || '', null, false);
  const roots = $('[data-testid="product-detail-qa"]');
  if (roots.length !== 1) return html;
  const rows = roots.children().toArray();
  if (rows.length !== baseline.length || rows.some(row => $(row).children().length !== 2)) return html;
  const actual = rows.map(row => ({ question: text($(row).children().eq(0).text()), answer: text($(row).children().eq(1).text()) }));
  if (JSON.stringify(actual) !== JSON.stringify(baseline)) return html;
  for (const repair of repairs) {
    const cell = $(rows[repair.index]).children().eq(repair.field === 'question' ? 0 : 1);
    // Empty text around media/table content is not an empty FAQ field.
    if (cell.find('img,video,table,[data-workbench-source-image]').length) return html;
  }
  for (const repair of repairs) $(rows[repair.index]).children().eq(repair.field === 'question' ? 0 : 1).text(repair.value);
  return $.root().html() || '';
}

// Image edits change the working galleries as well as HTML. Keep native module
// identity and text; the immutable source may supply gallery membership only
// for explicitly restored URLs, never overwrite the current description text.
export function syncStructuredDescriptionImages(product, { beforeImages, detailImages, html, restoreStructure = null }) {
  const current = currentDescriptionStructure(product);
  if (!current) return null;
  const selected = new Set(detailImages);
  const remaining = new Map();
  detailImages.forEach(url => remaining.set(url, (remaining.get(url) || 0) + 1));
  const take = url => {
    if (!remaining.get(url)) return false;
    remaining.set(url, remaining.get(url) - 1);
    return true;
  };
  const position = new Map(detailImages.map((url, index) => [url, index]));
  const sourceGalleries = (restoreStructure?.modules || []).filter(module => module.type === 'gallery');
  const sourceUrls = new Set(sourceGalleries.flatMap(module => module.images.map(image => image.url)));
  const insertGallery = (gallery, source = null) => {
    const sourceModules = restoreStructure?.modules || [];
    const following = source ? sourceModules.slice(sourceModules.indexOf(source) + 1) : [];
    const successor = following.map(module => current.modules.findIndex(candidate => candidate.type === module.type
      && (module.type !== 'gallery' || candidate.scope === module.scope && candidate.title === module.title))).find(index => index >= 0);
    const boundary = current.modules.findIndex(module => gallery.scope === 'company' ? module.type === 'faq'
      : module.type === 'company' || module.type === 'faq' || module.type === 'gallery' && module.scope === 'company');
    current.modules.splice(successor ?? (boundary < 0 ? current.modules.length : boundary), 0, gallery);
  };
  for (const module of current.modules.filter(module => module.type === 'gallery')) {
    module.images = module.images.flatMap(image => {
      const index = beforeImages.indexOf(image.url);
      const replacement = beforeImages.length === detailImages.length && index >= 0 ? detailImages[index] : '';
      const url = selected.has(image.url) ? image.url
        : replacement && !beforeImages.includes(replacement) && !sourceUrls.has(replacement) ? replacement : '';
      if (!url || !take(url)) return [];
      return [{ ...image, url }];
    }).sort((left, right) => position.get(left.url) - position.get(right.url));
  }
  for (const source of sourceGalleries) {
    const restored = source.images.filter(image => take(image.url));
    if (!restored.length) continue;
    let gallery = current.modules.find(module => module.type === 'gallery' && module.scope === source.scope && module.title === source.title);
    if (!gallery) {
      gallery = { ...structuredClone(source), images: [] };
      insertGallery(gallery, source);
    }
    gallery.images.push(...structuredClone(restored));
  }
  const added = detailImages.filter(take);
  if (added.length) {
    let gallery = current.modules.find(module => module.type === 'gallery' && module.scope !== 'company' && module.title === 'Other product images');
    if (!gallery) {
      gallery = { type: 'gallery', scope: 'product', title: 'Other product images', images: [] };
      insertGallery(gallery);
    }
    gallery.images.push(...added.map(url => ({ url, caption: '' })));
  }
  current.modules = current.modules.filter(module => module.type !== 'gallery' || module.images.length);
  for (const module of current.modules.filter(module => module.type === 'gallery')) {
    module.images.sort((left, right) => position.get(left.url) - position.get(right.url));
  }
  return { ...current, sourceHtmlHash: descriptionSourceHash(html), images: [...detailImages], html };
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
