import { sourcePlatform } from './source-platform.js';

const BUILTIN_CATEGORY_IDS = new Map([
  ['drones accessories', '201346401']
]);

export function normalizeCategoryId(value) {
  const match = String(value ?? '').match(/\d{4,}/);
  return match?.[0] || '';
}

export function categoryIdFromUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return normalizeCategoryId(
      url.searchParams.get('catId')
      || url.searchParams.get('categoryId')
      || url.pathname.match(/(?:cid|category)[-_]?(\d{4,})/i)?.[1]
    );
  } catch {
    return normalizeCategoryId(String(value || '').match(/(?:catId|categoryId)=([^&#]+)/i)?.[1]);
  }
}

export function normalizedCategoryPath(value) {
  const parts = Array.isArray(value)
    ? value
    : String(value || '').split(/\s*(?:>>|>|\/|\\)\s*/);
  return parts.map((part) => String(part || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

export function canonicalCategoryPart(value) {
  const normalized = String(value || '').toLowerCase().replace(/[,&._-]/g, ' ').replace(/\s+/g, ' ').trim();
  return ({
    '无人机配件': 'drones accessories',
    'drones accessories': 'drones accessories',
    '相机照片配件': 'camera photo accessories',
    'camera photo accessories': 'camera photo accessories',
    '其他消费电子产品': 'other consumer electronics',
    'other consumer electronics': 'other consumer electronics',
    '坚固型手机': 'rugged phone',
    'rugged phone': 'rugged phone',
    '电机控制器': 'motor controllers',
    'motor controller': 'motor controllers',
    'motor controllers': 'motor controllers',
    '电池充电器': 'battery chargers',
    'battery charger': 'battery chargers',
    'battery chargers': 'battery chargers'
  })[normalized] || normalized;
}

export function categoryPathKey(value) {
  return normalizedCategoryPath(value).map(canonicalCategoryPart).join(' > ');
}

export function categoryLeafKey(value) {
  const parts = normalizedCategoryPath(value);
  return parts.length ? canonicalCategoryPart(parts.at(-1)) : '';
}

export function productCategory(product = {}) {
  const international = sourcePlatform(product) === 'alibaba.com';
  let path = normalizedCategoryPath(
    product.categoryPath?.length ? product.categoryPath : international ? product.sourceCategoryPath : []
  );
  const snapshot = product.source?.snapshot || {};
  let id = normalizeCategoryId(
    product.categoryId
    || (international && (product.sourceCategoryId || snapshot.categoryId || snapshot.sourceCategoryId))
  );
  // A previous reference-template operation could have copied a drone leaf
  // onto a phone product. Prefer the immutable source taxonomy in that one
  // unambiguous case so existing workspaces recover without manual edits.
  const sourcePath = normalizedCategoryPath(product.sourceCategoryPath);
  const phoneTitle = /\b(?:smartphone|mobile\s+phone|cell\s+phone|iphone|android\s+phone|phone\s+1[0-9])\b/i.test(String(product.title || ''));
  if (international && phoneTitle && categoryLeafKey(path) === 'drones accessories'
    && categoryLeafKey(sourcePath) && categoryLeafKey(sourcePath) !== 'drones accessories') {
    path = sourcePath;
    id = normalizeCategoryId(product.sourceCategoryId || snapshot.sourceCategoryId);
  }
  if (!id && path.length) id = BUILTIN_CATEGORY_IDS.get(canonicalCategoryPart(path.at(-1))) || '';
  return { id, path, pathText: path.join(' >> '), pathKey: categoryPathKey(path) };
}

export function buildAlibabaPublishUrl(categoryId) {
  const id = normalizeCategoryId(categoryId);
  return id ? `https://post.alibaba.com/product/publish.htm?from=common&catId=${encodeURIComponent(id)}` : '';
}

function normalizedBinding(binding = {}) {
  const categoryId = normalizeCategoryId(binding.categoryId || categoryIdFromUrl(binding.url));
  const category = normalizedCategoryPath(binding.category || binding.categoryPath).join(' >> ');
  const url = String(binding.url || '').trim();
  if (!url) return null;
  return {
    categoryId,
    category,
    url,
    verifiedAt: binding.verifiedAt || '',
    source: binding.source || 'cached'
  };
}

export function publishBindings(settings = {}) {
  const bindings = [];
  const configured = settings.publishBindings;
  if (Array.isArray(configured)) bindings.push(...configured);
  else if (configured && typeof configured === 'object') bindings.push(...Object.values(configured));
  if (settings.publishPageUrl) {
    bindings.push({
      url: settings.publishPageUrl,
      category: settings.publishCategory || '',
      categoryId: categoryIdFromUrl(settings.publishPageUrl),
      source: 'legacy'
    });
  }
  return bindings.map(normalizedBinding).filter(Boolean);
}

export function resolvePublishRoute(product, settings = {}) {
  const category = productCategory(product);
  const bindings = publishBindings(settings);
  let binding = category.id
    ? bindings.find((item) => item.categoryId === category.id)
    : null;
  if (!category.id && !binding && category.pathKey) {
    binding = bindings.find((item) => categoryPathKey(item.category) === category.pathKey);
  }
  if (!category.id && !binding && category.path.length) {
    const leaf = categoryLeafKey(category.path);
    binding = bindings.find((item) => leaf && categoryLeafKey(item.category) === leaf);
  }
  if (binding) {
    return {
      ...binding,
      categoryId: binding.categoryId || category.id,
      category: binding.category || category.pathText,
      source: binding.source === 'legacy' ? 'legacy' : 'cached',
      automatic: binding.source !== 'legacy'
    };
  }
  if (category.id) {
    return {
      categoryId: category.id,
      category: category.pathText,
      url: buildAlibabaPublishUrl(category.id),
      source: 'generated',
      automatic: true,
      verifiedAt: ''
    };
  }
  return {
    categoryId: '', category: category.pathText, url: '', source: 'unresolved', automatic: false,
    error: category.pathText
      ? `类目“${category.pathText}”缺少国际站叶子类目 ID，请补采详情或选择目标类目`
      : '商品没有具体类目，请先选择目标类目'
  };
}

export function createPublishPlan(products = [], settings = {}) {
  const groups = new Map();
  for (const product of products) {
    const route = resolvePublishRoute(product, settings);
    const platform = sourcePlatform(product);
    const routeKey = route.categoryId ? `id:${route.categoryId}` : `path:${categoryPathKey(route.category) || product.id}`;
    const key = platform === 'alibaba.com' ? routeKey : `${platform}:${routeKey}`;
    const group = groups.get(key) || {
      key,
      sourcePlatform: platform,
      categoryId: route.categoryId,
      category: route.category,
      url: route.url,
      source: route.source,
      automatic: route.automatic,
      error: route.error || '',
      products: []
    };
    group.products.push(product);
    if (!group.error && route.error) group.error = route.error;
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function rememberPublishBinding(settings, binding) {
  const normalized = normalizedBinding(binding);
  if (!normalized) return null;
  settings.publishBindings = settings.publishBindings && typeof settings.publishBindings === 'object' && !Array.isArray(settings.publishBindings)
    ? settings.publishBindings
    : {};
  const key = normalized.categoryId ? `id:${normalized.categoryId}` : `path:${categoryPathKey(normalized.category)}`;
  settings.publishBindings[key] = { ...normalized, source: binding.source || 'verified' };
  settings.publishPageUrl = normalized.url;
  settings.publishCategory = normalized.category;
  return settings.publishBindings[key];
}
