import { load } from 'cheerio';

const receipts = new WeakMap();

// Alibaba's legacy editor rejects the square-metre compatibility character.
// Its Unicode compatibility spelling is exactly m2. Restrict this conversion
// to text nodes: URLs, attributes, markup and all other Unicode stay intact.
export function prepareLegacyDescriptionText(html) {
  const original = String(html || '');
  if (!original.includes('㎡') && !/&#(?:x0*33a1|0*13217);/i.test(original)) return { html: original, conversions: [] };
  const $ = load(original, null, false);
  let count = 0;
  const visit = nodes => {
    for (const node of nodes) {
      if (node.type === 'text') {
        node.data = node.data.replace(/㎡/g, () => { count++; return 'm2'; });
      } else if (node.children && !['script', 'style'].includes(node.tagName)) visit(node.children);
    }
  };
  visit($.root()[0].children);
  return { html: count ? $.root().html() : original,
    conversions: count ? [{ from: '㎡', to: 'm2', count, reason: 'legacy-editor-unit-compatibility' }] : [] };
}

export function recordLegacyDescriptionText(page, conversions) {
  receipts.set(page, { url: page.url(), conversions: conversions.map(item => ({ ...item })) });
}

export function legacyDescriptionTextConversions(page) {
  const receipt = receipts.get(page);
  return receipt?.url === page.url() ? receipt.conversions.map(item => ({ ...item })) : [];
}
