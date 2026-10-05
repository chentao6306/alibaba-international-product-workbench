import { sourcePlatform } from './source-platform.js';

// Source category IDs belong to another taxonomy. Only a unique, descriptive
// leaf name may be mapped automatically; broader/fuzzy matches are suggestions.
const nameKey = (text) => String(text || '').normalize('NFKC').toLowerCase()
  .replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  .split(/\s+/).map((word) => word.length > 3 && !/ss$/.test(word) ? word.replace(/s$/, '') : word).join(' ');
const generic = /^(?:other(?:s)?|accessor(?:y|ies)|part|product|equipment|general|其他|配件)$/;

export function mapSourceCategory(product, catalog) {
  if (sourcePlatform(product) !== 'made-in-china' || product.categoryId || product.targetCategoryId || product.categoryReference) return {};
  const sourcePath = (product.sourceCategoryPath || []).filter(Boolean);
  const leaf = nameKey(sourcePath.at(-1));
  if (!leaf || generic.test(leaf)) return {};
  const leaves = [];
  const visit = (id = '0') => {
    for (const node of catalog.children(id)) {
      if (node.leaf) leaves.push(node);
      else if (!node.unavailable) visit(node.id);
    }
  };
  visit();
  const exactName = (key) => leaves.filter((node) => [node.name, node.nameZh].some((name) => nameKey(name) === key));
  const exact = exactName(leaf);
  const option = (node) => ({ id: node.id, path: catalog.path(node.id).map((part) => part.name) });
  for (const name of [...sourcePath].reverse()) {
    const key = nameKey(name);
    const matches = exactName(key);
    if (matches.length > 1) break;
    const specific = key.split(' ').length > 1 || /[\u3400-\u9fff]{3,}/.test(key);
    if (matches.length === 1 && specific && !generic.test(key)) {
      const match = option(matches[0]);
      return { categoryId: match.id, categoryPath: match.path,
        categoryMapping: { status: 'matched', sourcePath, matchedName: name, candidates: [match] } };
    }
  }
  const terms = leaf.split(' ').filter((term) => term.length > 1);
  const title = ` ${nameKey(product.title)} `;
  const suggestions = (exact.length ? exact : leaves.filter((node) => {
    const names = `${nameKey(node.name)} ${nameKey(node.nameZh)}`;
    return terms.length && terms.every((term) => names.includes(term));
  })).sort((a, b) => {
    const score = (node) => nameKey(node.name).split(' ').filter((word) => title.includes(` ${word} `)).length;
    return score(b) - score(a) || a.id.localeCompare(b.id);
  }).slice(0, 8).map(option);
  return { categoryMapping: { status: 'needs-confirmation', sourcePath, candidates: suggestions } };
}
