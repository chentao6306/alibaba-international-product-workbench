import crypto from 'node:crypto';
import { crossPlatformPublishErrors, sourcePlatform } from './source-platform.js';
import { requiredAttributeKey } from './publish-reference.js';
import { attributeId } from './category-attributes.js';
import { synchronizeProductOrigin } from './origin-country.js';
import { stockValuesChanged } from './publish-policy.js';

export const PRODUCT_SCHEMA_VERSION = 5;

const nowIso = () => new Date().toISOString();
const list = (value) => Array.isArray(value) ? value : [];
const text = (value) => String(value ?? '').trim();
const positive = (value) => Number(value) > 0;

// These are editable text/data fields. Source identity, prices, media and
// publish state are intentionally excluded from find-and-replace operations.
const FIND_REPLACE_FIELDS = [
  'title', 'subtitle', 'keywords', 'attributes', 'customAttributes', 'categoryPath', 'categoryId',
  'origin', 'model', 'brand', 'productType', 'variantGroups', 'skus',
  'description', 'descriptionHtml', 'structuredDescription', 'services',
  'certificates', 'salesUnit', 'paymentMethod', 'freightTemplate', 'logisticsAttributes',
  'deliveryCountry', 'deliveryOptions', 'shipping', 'packaging', 'deliveryTime'
];

const isBlank = (value) => value == null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && value.length === 0);

function replaceTextValue(value, search, replacement, caseSensitive, path, matches) {
  if (typeof value === 'string') {
    const flags = caseSensitive ? 'g' : 'gi';
    const expression = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    const count = [...value.matchAll(expression)].length;
    if (!count) return { value, changed: false };
    matches.push({ field: path, count, before: value.slice(0, 180) });
    return { value: value.replace(expression, () => replacement), changed: true };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item, index) => {
      const result = replaceTextValue(item, search, replacement, caseSensitive, `${path}[${index}]`, matches);
      changed ||= result.changed;
      return result.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next = { ...value };
    for (const [key, item] of Object.entries(value)) {
      const result = replaceTextValue(item, search, replacement, caseSensitive, path ? `${path}.${key}` : key, matches);
      changed ||= result.changed;
      if (result.changed) next[key] = result.value;
    }
    return { value: changed ? next : value, changed };
  }
  return { value, changed: false };
}

export function findAndReplaceProduct(product, search, replacement, options = {}) {
  const needle = String(search ?? '');
  const replacementText = String(replacement ?? '');
  const caseSensitive = Boolean(options.caseSensitive);
  const matches = [];
  const patch = {};
  if (!needle) return { patch, matches, count: 0 };
  for (const field of FIND_REPLACE_FIELDS) {
    if (!Object.hasOwn(product, field)) continue;
    const result = replaceTextValue(product[field], needle, replacementText, caseSensitive, field, matches);
    if (result.changed) patch[field] = result.value;
  }
  return { patch, matches, count: matches.reduce((total, item) => total + item.count, 0) };
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

// Automatic preflight enrichment fills missing source material without
// replacing the user's prices or the specification/category template.
export function mergeSourceDataForPublish(target, source) {
  if (target.sourceId && source.sourceId && String(target.sourceId) !== String(source.sourceId)) {
    throw new Error('补全资料返回了不同的来源商品，已停止上架');
  }
  const next = { ...clone(source), ...clone(target) };
  const templateFields = new Set(['categoryId', 'categoryPath', 'attributes', 'origin', 'variantGroups', 'skus']);
  for (const field of ['sourceCategoryId', 'sourceCategoryPath', 'categoryId', 'categoryPath', 'attributes', 'origin',
    'description', 'descriptionHtml', 'structuredDescription', 'mainImage', 'mainImages', 'images', 'detailImages',
    'packaging', 'stock', 'price', 'variantGroups', 'skus']) {
    if (target.categoryReference && templateFields.has(field)) continue;
    if (isBlank(target[field]) && !isBlank(source[field])) next[field] = clone(source[field]);
  }
  // Recollection can add missing properties and their stable IDs. Keep
  // existing edits; never mix original category attributes into a reference.
  if (!target.categoryReference) {
    next.attributes = clone(target.attributes || []);
    for (const item of source.attributes || []) {
      const existing = next.attributes.find((row) => attributeId(row) && attributeId(item)
        ? attributeId(row) === attributeId(item) : requiredAttributeKey(row.name) === requiredAttributeKey(item.name));
      if (!existing) next.attributes.push(clone(item));
      else if (isBlank(existing.value)) Object.assign(existing, clone(item));
      else if (JSON.stringify(existing.value) === JSON.stringify(item.value)) {
        if (!attributeId(existing) && attributeId(item)) existing.id = attributeId(item);
        if (!existing.valueIds && item.valueIds) existing.valueIds = clone(item.valueIds);
      }
    }
    if (source.sourceAttributeSchemaVersion) next.sourceAttributeSchemaVersion = source.sourceAttributeSchemaVersion;
  }
  next.packaging = { ...(source.packaging || {}), ...(target.packaging || {}) };
  for (const [field, value] of Object.entries(source.packaging || {})) {
    if (isBlank(next.packaging[field])) next.packaging[field] = clone(value);
  }
  if ((target.mainImages || target.images || []).length < 4) {
    next.mainImages = [...new Set([...(target.mainImages || target.images || []), ...(source.mainImages || source.images || [])])];
    next.images = [...next.mainImages];
    next.mainImage = next.mainImages[0] || next.mainImage;
  }
  return next;
}

export function copyMissingProductData(target, reference) {
  const patch = {};
  const copyWhenBlank = ['origin', 'model', 'productType', 'deliveryTime', 'variantGroups', 'skus', 'salesUnit', 'freightTemplate', 'logisticsAttributes', 'services', 'certificates'];
  for (const field of copyWhenBlank) {
    if (isBlank(target?.[field]) && !isBlank(reference?.[field])) patch[field] = clone(reference[field]);
  }
  const targetPackaging = target?.packaging && typeof target.packaging === 'object' ? target.packaging : {};
  const referencePackaging = reference?.packaging && typeof reference.packaging === 'object' ? reference.packaging : {};
  const packaging = { ...targetPackaging };
  let packagingChanged = false;
  for (const [key, value] of Object.entries(referencePackaging)) {
    const targetValueMissing = isBlank(packaging[key]) || (['weight', 'length', 'width', 'height'].includes(key) && Number(packaging[key]) <= 0);
    if (targetValueMissing && !isBlank(value)) { packaging[key] = clone(value); packagingChanged = true; }
  }
  if (packagingChanged) patch.packaging = packaging;
  for (const field of ['attributes', 'customAttributes']) {
    const current = Array.isArray(target?.[field]) ? target[field].map((item) => ({ ...item })) : [];
    const source = Array.isArray(reference?.[field]) ? reference[field] : [];
    const known = new Map(current.map((item, index) => [String(item.name || '').trim().toLowerCase(), index]));
    let changed = false;
    for (const item of source) {
      const name = String(item?.name || '').trim();
      if (!name) continue;
      const index = known.get(name.toLowerCase());
      if (index == null) { current.push(clone(item)); known.set(name.toLowerCase(), current.length - 1); changed = true; continue; }
      if (isBlank(current[index].value) && !isBlank(item.value)) { current[index] = { ...current[index], value: clone(item.value) }; changed = true; }
    }
    if (changed) patch[field] = current;
  }
  const currentGroups = Array.isArray(target?.variantGroups) ? target.variantGroups.map((group) => ({ ...group, options: [...(group.options || [])] })) : [];
  const sourceGroups = Array.isArray(reference?.variantGroups) ? reference.variantGroups : [];
  let groupsChanged = false;
  for (const sourceGroup of sourceGroups) {
    const name = String(sourceGroup?.name || '').trim();
    if (!name) continue;
    const existing = currentGroups.find((group) => String(group.name || '').trim().toLowerCase() === name.toLowerCase());
    if (!existing) { currentGroups.push(clone(sourceGroup)); groupsChanged = true; continue; }
    if (!Array.isArray(existing.options) || !existing.options.length) {
      if (Array.isArray(sourceGroup.options) && sourceGroup.options.length) { existing.options = clone(sourceGroup.options); groupsChanged = true; }
    } else if (Array.isArray(sourceGroup.options)) {
      const knownOptions = new Set(existing.options.map((option) => String(option).trim().toLowerCase()));
      for (const option of sourceGroup.options) {
        if (!knownOptions.has(String(option).trim().toLowerCase())) { existing.options.push(clone(option)); knownOptions.add(String(option).trim().toLowerCase()); groupsChanged = true; }
      }
    }
  }
  if (groupsChanged) patch.variantGroups = currentGroups;
  return patch;
}

// Copy the publishable taxonomy/template from a product that has already
// passed the international-site submission flow. Commercial and source media
// fields stay attached to the target product so quoting a template cannot
// silently change what the customer collected or priced.
export function applyPublishedProductReference(target, reference, options = {}) {
  if (options.fullTemplate) {
    const patch = applyPublishedProductReference(target, reference);
    const missing = copyMissingProductData(target, reference);
    for (const field of ['packaging', 'services', 'certificates', 'deliveryTime', 'salesUnit', 'freightTemplate', 'logisticsAttributes']) {
      delete patch[field];
      if (missing[field] != null) patch[field] = missing[field];
    }
    // Explicit reference replaces the selected template sections, including
    // empty sections, so stale options from the former category cannot survive.
    for (const field of ['customAttributes', 'variantGroups', 'modelImages', 'colorImages', 'specifications',
      'platformAttributes', 'internationalAttributes', 'targetAttributes']) {
      patch[field] = clone(patch[field] ?? reference[field] ?? (field.endsWith('Images') ? {} : []));
    }
    for (const field of ['origin', 'province', 'brand', 'brandName', 'compatibleBrand', 'compatibleBrands',
      'privateMold', 'model', 'compatibleModel', 'compatibleModels', 'productType', 'type', 'color', 'material']) {
      patch[field] = clone(reference[field] ?? '');
    }
    patch.attributes = clone(patch.attributes || []);
    const referenceSkus = clone(reference.skus || []);
    if (!referenceSkus.length && patch.variantGroups.length) {
      let combinations = [{}];
      for (const group of patch.variantGroups) {
        if (!group.options?.length) continue;
        if (combinations.length * group.options.length > 5000) throw new Error('引用商品规格组合超过 5000 行，请先精简规格');
        combinations = combinations.flatMap((row) => group.options.map((value) => ({ ...row, [group.name]: value })));
      }
      for (const attributes of combinations) referenceSkus.push({ attributes, derived: true, source: 'reference', stock: target.stock ?? 100 });
    }
    const key = (sku) => JSON.stringify(Object.entries(sku.attributes || {}).map(([name, value]) => [requiredAttributeKey(name), value]).sort());
    const prices = new Map(list(target.skus).map((sku) => [key(sku), sku.price]));
    patch.skus = referenceSkus.map((sku, index) => ({ ...sku,
      id: `${target.sourceId || target.id || 'reference'}-sku-${index + 1}`,
      price: !isBlank(prices.get(key(sku))) ? prices.get(key(sku)) : !isBlank(target.price) ? target.price : '',
      image: sku.image || patch.variantGroups.map((group) => group.optionImages?.[sku.attributes?.[group.name]]).find(Boolean) || '',
    }));
    const categoryId = reference.categoryId || reference.sourceCategoryId || '';
    const categoryPath = clone(reference.categoryPath?.length ? reference.categoryPath : reference.sourceCategoryPath || []);
    Object.assign(patch, { categoryId, categoryPath, targetCategoryId: categoryId, targetCategoryPath: categoryPath,
      categoryReference: { referenceId: reference.id || '', categoryId, categoryPath } });
    return patch;
  }
  const patch = {};
  const fieldNames = { origin: 'origin', province: 'province', brand: 'brand', brandName: 'brand', compatibleBrand: 'compatible brand', compatibleBrands: 'compatible brand', privateMold: 'private mold', model: 'model', compatibleModel: 'compatible model', compatibleModels: 'compatible model', productType: 'type', type: 'type', color: 'color' };
  const existingValues = new Set([
    ...list(target.attributes), ...list(target.customAttributes),
    ...list(target.variantGroups).map((group) => ({ name: group.name, value: list(group.options).filter((value) => !isBlank(value)) })),
    ...Object.entries(fieldNames)
      .filter(([field]) => field !== 'productType' || ![target.categoryPath?.at(-1), target.sourceCategoryPath?.at(-1)].filter(Boolean).includes(target[field]))
      .map(([field, name]) => ({ name, value: target[field] }))
  ].filter((item) => !isBlank(item.value)).map((item) => requiredAttributeKey(item.name)));
  const cloneIfPresent = (field) => {
    if (!Object.hasOwn(reference || {}, field) || isBlank(reference[field])) return;
    if (options.onlyMissing && !isBlank(target?.[field])) return;
    if (options.onlyMissing && fieldNames[field] && existingValues.has(requiredAttributeKey(fieldNames[field]))) return;
    patch[field] = clone(reference[field]);
  };

  // A reference is a field/specification template. The target's working
  // category remains authoritative unless a caller explicitly requests the
  // legacy category-copy behavior. Copying a successful drone category onto
  // a phone is otherwise enough to make every subsequent submission fail.
  if (!options.preserveCategory) {
    for (const field of [
      'categoryPath', 'categoryId', 'targetCategory', 'targetCategoryPath',
      'targetCategoryId', 'internationalCategory', 'internationalCategoryPath',
      'categoryAttributes', 'publishCategory', 'publishCategoryId'
    ]) cloneIfPresent(field);
    if (!patch.categoryPath && (!options.onlyMissing || isBlank(target?.categoryPath)) && Array.isArray(reference?.sourceCategoryPath) && reference.sourceCategoryPath.length) {
      patch.categoryPath = clone(reference.sourceCategoryPath);
    }
    if (!patch.categoryId && (!options.onlyMissing || isBlank(target?.categoryId)) && !isBlank(reference?.sourceCategoryId) && (!reference.sourcePlatform || reference.sourcePlatform === 'alibaba.com')) {
      patch.categoryId = clone(reference.sourceCategoryId);
    }
  }

  // Controlled category attributes used by the Alibaba form. These names also
  // cover data captured from older versions of the collector/custom editor.
  for (const field of [
    'attributes', 'customAttributes', 'origin', 'province', 'brand',
    'brandName', 'compatibleBrand', 'compatibleBrands', 'privateMold',
    'model', 'modelImages', 'compatibleModel', 'compatibleModels',
    'productType', 'type', 'color', 'colorImages', 'specifications',
    'platformAttributes', 'internationalAttributes', 'targetAttributes',
    'services', 'certificates', 'deliveryTime', 'salesUnit', 'packaging', 'freightTemplate', 'logisticsAttributes'
  ]) cloneIfPresent(field);

  if (options.onlyMissing) {
    const packaging = copyMissingProductData(target, reference).packaging;
    if (packaging) patch.packaging = packaging;
  }

  // Older captures sometimes kept these category values as top-level fields
  // instead of attribute rows. Materialize the aliases the publisher knows so
  // a reference remains usable across old and new workspace schemas.
  const referenceAttributes = Array.isArray(reference?.attributes) ? reference.attributes.map((item) => ({ ...item })) : [];
  const targetAttributes = Array.isArray(target?.attributes) ? target.attributes.map((item) => ({ ...item })) : [];
  const attributeKey = requiredAttributeKey;
  const mergedAttributes = options.onlyMissing ? targetAttributes : referenceAttributes;
  const knownAttributeNames = new Map(mergedAttributes
    .map((item, index) => [attributeKey(item?.name), index])
    .filter(([name]) => name));
  if (options.onlyMissing) {
    for (const item of referenceAttributes) {
      const key = attributeKey(item?.name);
      if (!key) continue;
      if (existingValues.has(key)) continue;
      const currentIndex = knownAttributeNames.get(key);
      if (currentIndex == null) {
        mergedAttributes.push({ ...item });
        knownAttributeNames.set(key, mergedAttributes.length - 1);
      } else if (isBlank(mergedAttributes[currentIndex]?.value) && !isBlank(item?.value)) {
        mergedAttributes[currentIndex] = { ...mergedAttributes[currentIndex], value: clone(item.value), source: mergedAttributes[currentIndex].source || 'reference-published-product' };
      }
    }
  }
  const addReferenceAttribute = (name, value) => {
    if (isBlank(value)) return;
    const key = attributeKey(name);
    if (options.onlyMissing && existingValues.has(key)) return;
    const existingIndex = knownAttributeNames.get(key);
    if (existingIndex != null) {
      if (isBlank(mergedAttributes[existingIndex].value)) mergedAttributes[existingIndex] = { ...mergedAttributes[existingIndex], value: clone(value) };
      return;
    }
    mergedAttributes.push({ name, value: clone(value), source: 'reference-published-product' });
    knownAttributeNames.set(key, mergedAttributes.length - 1);
  };
  addReferenceAttribute('省份', reference.province);
  addReferenceAttribute('产品名称', reference.productName);
  addReferenceAttribute('品牌名称', reference.brandName || reference.brand);
  addReferenceAttribute('适用品牌', Array.isArray(reference.compatibleBrands)
    ? reference.compatibleBrands.join(', ')
    : (reference.compatibleBrand || reference.applicableBrand || reference.applicationBrand));
  addReferenceAttribute('材质', reference.material || reference.materialName);
  addReferenceAttribute('私模', reference.privateMold);
  addReferenceAttribute('适用型号', Array.isArray(reference.compatibleModels)
    ? reference.compatibleModels.join(', ')
    : (reference.compatibleModel || reference.applicableModel || reference.applicationModel));
  addReferenceAttribute('类型', reference.type || reference.productType);
  if (reference.color && !Array.isArray(patch.variantGroups)) addReferenceAttribute('颜色', reference.color);
  if (mergedAttributes.length) patch.attributes = mergedAttributes;

  // Specifications and their option images are safe to copy. Rebuild SKU
  // rows from the reference only when the target has no rows; when rows exist,
  // retain target price/stock/code and replace only specification attributes.
  if (!options.onlyMissing) cloneIfPresent('variantGroups');
  if (!options.onlyMissing && Array.isArray(patch.variantGroups)) {
    const imageMap = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const colorImages = imageMap(reference.colorImages);
    const modelImages = imageMap(reference.modelImages);
    patch.variantGroups = patch.variantGroups.map((group) => {
      const name = String(group?.name || '').toLowerCase();
      const extraImages = /color|colour|颜色/.test(name) ? colorImages : /model|型号/.test(name) ? modelImages : {};
      return Object.keys(extraImages).length
        ? { ...group, optionImages: { ...(group.optionImages || {}), ...clone(extraImages) } }
        : group;
    });
  }
  if (!options.onlyMissing && Array.isArray(reference?.skus) && reference.skus.length) {
    const targetSkus = Array.isArray(target?.skus) ? target.skus : [];
    const skuKey = (sku) => Object.entries(sku?.attributes || {})
      .map(([name, value]) => `${String(name).trim().toLowerCase()}=${String(value).trim().toLowerCase()}`)
      .sort().join('|');
    const targetByKey = new Map(targetSkus.map((sku) => [skuKey(sku), sku]));
    patch.skus = reference.skus.map((sourceSku, index) => {
      const current = targetByKey.get(skuKey(sourceSku)) || targetSkus[index] || {};
      const next = clone(sourceSku) || {};
      if (Object.hasOwn(current, 'price') && current.price !== '') next.price = clone(current.price);
      else if (target?.price != null && target.price !== '') next.price = clone(target.price);
      if (Object.hasOwn(current, 'stock') && current.stock !== '') next.stock = clone(current.stock);
      else if (target?.stock != null && target.stock !== '') next.stock = clone(target.stock);
      if (Object.hasOwn(current, 'code')) next.code = clone(current.code);
      if (Object.hasOwn(current, 'skuCode')) next.skuCode = clone(current.skuCode);
      return next;
    });
  }

  // Do not allow a template to overwrite source identity, title, keywords,
  // pricing, inventory, main/detail images, description or publish state.
  return patch;
}

function snapshotFields(product) {
  return structuredClone({
    ...Object.fromEntries(['province', 'brandName', 'compatibleBrand', 'compatibleBrands', 'privateMold', 'compatibleModel',
      'compatibleModels', 'material', 'type', 'color', 'colorImages', 'modelImages', 'specifications', 'platformAttributes',
      'internationalAttributes', 'targetAttributes', 'categoryReference', 'stockProvenance'].filter((key) => Object.hasOwn(product, key)).map((key) => [key, product[key]])),
    sourceId: product.sourceId || '', sourceUrl: product.sourceUrl || '', sourceTitle: product.sourceTitle || '',
    sourceOriginalTitle: product.sourceOriginalTitle || '', sourceLanguage: product.sourceLanguage || '',
    sourceCaptureLocale: product.sourceCaptureLocale || '', sourceLanguageEvidence: product.sourceLanguageEvidence || null,
    sourcePrice: product.sourcePrice ?? '', maxPrice: product.maxPrice ?? null, currencySymbol: product.currencySymbol || '', sourcePriceText: product.sourcePriceText || '',
    sourcePriceRange: product.sourcePriceRange || null, sourceTradeAvailability: product.sourceTradeAvailability || null,
    sourceStructuredEvidence: product.sourceStructuredEvidence || null,
    collectedDetailAt: product.collectedDetailAt || '', dataCompleteness: product.dataCompleteness || null,
    title: product.title || '', subtitle: product.subtitle || '', keywords: list(product.keywords),
    categoryPath: list(product.categoryPath || product.sourceCategoryPath), categoryId: product.categoryId || '',
    sourceCategoryPath: list(product.sourceCategoryPath), sourceCategoryId: product.sourceCategoryId || '',
    mainImages: list(product.mainImages || product.images), detailImages: list(product.detailImages),
    videos: list(product.videos), videoUrl: product.videoUrl || '', attributes: list(product.attributes),
    customAttributes: list(product.customAttributes), variantGroups: list(product.variantGroups), skus: list(product.skus),
    priceTiers: list(product.priceTiers), sourcePriceTiers: list(product.sourcePriceTiers),
    stock: product.stock ?? null, moq: product.moq ?? null, deliveryCountry: product.deliveryCountry || '', salesUnit: product.salesUnit || '',
    paymentMethod: product.paymentMethod || '', fobPrice: product.fobPrice || '', priceMode: product.priceMode || '',
    origin: product.origin || '', model: product.model || '', brand: product.brand || '', productType: product.productType || '',
    packaging: product.packaging || {}, deliveryTime: list(product.deliveryTime), shipping: product.shipping || {},
    ...(product.sourcePackaging ? { sourcePackaging: product.sourcePackaging } : {}),
    freightTemplate: product.freightTemplate || '', logisticsAttributes: list(product.logisticsAttributes), services: product.services || {}, certificates: list(product.certificates),
    description: product.description || '', descriptionHtml: product.descriptionHtml || '',
    structuredDescription: product.structuredDescription || null, regionalPricing: product.regionalPricing || {}
  });
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function sourceSnapshotFingerprint(productOrSnapshot) {
  const snapshot = productOrSnapshot?.source?.snapshot || productOrSnapshot;
  return fingerprint(snapshotFields(snapshot));
}

export function verifySourceIntegrity(product) {
  const snapshot = product?.source?.snapshot;
  if (!snapshot) return { present: false, valid: false, expected: '', actual: '' };
  const expected = product.source.snapshotHash || '';
  // Older captures contain exactly the fields present when they were saved.
  // Extending snapshotFields must not invalidate those immutable bytes. Some
  // earlier migrations hashed the normalized projection, so accept that hash
  // too for legacy captures; never replace an existing hash to hide a mismatch.
  const stored = fingerprint(snapshot);
  const actual = product.source.snapshotHashVersion === 2 || stored === expected
    ? stored : sourceSnapshotFingerprint(snapshot);
  return { present: true, valid: !expected || expected === actual, expected, actual };
}

export function auditProduct(product) {
  const issues = [];
  const add = (code, section, severity, field, message) => issues.push({ code, section, severity, field, message });
  const mainImages = list(product.mainImages || product.images);
  const detailImages = list(product.detailImages);
  const attributes = list(product.attributes);
  const groups = list(product.variantGroups);
  const skus = list(product.skus);
  const tiers = list(product.priceTiers);
  const sourcePriceRange = product.sourcePriceRange || null;
  const hasValidSourceRange = positive(sourcePriceRange?.minPrice)
    && positive(sourcePriceRange?.maxPrice)
    && Number(sourcePriceRange.maxPrice) >= Number(sourcePriceRange.minPrice);
  const packaging = product.packaging || {};
  const sourceLanguage = text(product.sourceLanguage).toLowerCase();
  const sourceIntegrity = verifySourceIntegrity(product);

  if (sourceIntegrity.present && !sourceIntegrity.valid) {
    add('source.snapshot.tampered', 'source', 'error', 'source.snapshot', '来源快照指纹不一致，禁止将工作数据当作来源原数据');
  }

  if (!text(product.title)) add('basic.title.missing', 'basic', 'error', 'title', '缺少商品标题');
  crossPlatformPublishErrors(product).forEach((message, index) => add(`source.platform.${index}`, 'publish', 'warning', 'sourcePlatform', `上架前：${message}`));
  if (!list(product.categoryPath || product.sourceCategoryPath).length && !text(product.categoryId)) add('taxonomy.category.missing', 'taxonomy', 'warning', 'categoryPath', '未识别商品类目');
  if (!text(product.subtitle)) add('basic.subtitle.missing', 'basic', 'info', 'subtitle', '未采集副标题');
  if (!list(product.keywords).length) add('basic.keywords.missing', 'basic', 'warning', 'keywords', '未采集商品关键词');
  if (mainImages.length < 4) add('media.main.insufficient', 'media', 'error', 'mainImages', `主图不足4张（当前${mainImages.length}张）`);
  if (!detailImages.length) add('media.detail.missing', 'media', 'error', 'detailImages', '缺少详情图片');
  if (attributes.length < 2) add('attributes.insufficient', 'attributes', 'warning', 'attributes', `商品属性较少（当前${attributes.length}项），上架时按类目核对必填项`);
  if (!text(product.origin)) add('attributes.origin.missing', 'attributes', 'warning', 'origin', '缺少产地，上架时按类目核对');
  if (groups.length && !skus.length) add('sku.rows.missing', 'variants', 'error', 'skus', '存在规格但缺少SKU明细');
  const expectedSkuCount = groups.reduce((count, group) => count * Math.max(1, list(group.options).length), groups.length ? 1 : 0);
  const sourceSkuCount = Number(product.sourceStructuredEvidence?.skuCount || product.dataCompleteness?.structuredSkus || 0);
  const validSourceCombinations = skus.map((sku) => {
    const platform = sourcePlatform(product);
    const structuredSource = sku.source === 'detailData.skuInfoMap' || (platform !== 'alibaba.com'
      && sku.source === platform && product.sourceStructuredEvidence?.platform === platform
      && product.sourceStructuredEvidence?.skuIds?.includes(sku.id));
    if (!structuredSource || sku.derived || !sku.evidence?.combination) return '';
    if (!groups.every((group) => list(group.options).includes(sku.attributes?.[group.name]))) return '';
    return JSON.stringify(groups.map((group) => sku.attributes[group.name]));
  });
  const completeSourceSkuMap = sourceSkuCount > 0 && sourceSkuCount === skus.length
    && validSourceCombinations.every(Boolean) && new Set(validSourceCombinations).size === skus.length;
  if (groups.length && skus.length && expectedSkuCount !== skus.length && !completeSourceSkuMap) add('sku.rows.incomplete', 'variants', 'error', 'skus', `SKU组合不完整（应有${expectedSkuCount}行，当前${skus.length}行）`);
  if (groups.length && skus.length && skus.every((sku) => sku.derived || sku.source === 'derived')) add('sku.derived.only', 'variants', 'warning', 'skus', 'SKU由规格组合推导，不是来源页面真实SKU');
  if (skus.some((sku) => !text(sku.code || sku.skuCode))) add('sku.code.missing', 'variants', 'info', 'skus', '部分SKU缺少商品编码');
  if (skus.some((sku) => sku.price != null && sku.price !== '' && !positive(sku.price))) add('sku.price.invalid', 'variants', 'error', 'skus', '部分SKU价格无效');
  if (skus.some((sku) => sku.stock != null && Number(sku.stock) < 0)) add('sku.stock.invalid', 'variants', 'error', 'skus', '部分SKU库存无效');
  const skusWithoutPublishedPrice = skus.filter((sku) => sku.price == null || sku.price === '');
  if (skusWithoutPublishedPrice.length && !hasValidSourceRange) add('sku.price.missing', 'variants', 'error', 'skus', '部分SKU缺少价格且来源没有有效价格区间');
  if (skusWithoutPublishedPrice.length && hasValidSourceRange) add('sku.price.not-published', 'variants', 'warning', 'skus', `来源仅公开${sourcePriceRange.formattedText || '价格区间'}，未公开逐SKU价格`);
  if (!positive(product.price) && !tiers.some((tier) => positive(tier.price)) && !hasValidSourceRange) add('trade.price.invalid', 'trade', 'error', 'price', '缺少有效销售价格');
  if (!tiers.length && product.priceMode === 'quantity-tier') add('trade.tiers.missing', 'trade', 'error', 'priceTiers', '来源采用数量阶梯定价，但缺少阶梯价格');
  const fob = product.fobPrice && typeof product.fobPrice === 'object' ? product.fobPrice : {};
  const fobTiers = list(fob.tiers);
  if (product.priceMode === 'fob-range' && !(positive(fob.minPrice) && positive(fob.maxPrice) && Number(fob.maxPrice) >= Number(fob.minPrice))) add('trade.fob.range.invalid', 'trade', 'error', 'fobPrice', 'FOB区间价格无效');
  if (product.priceMode === 'fob-tier' && !fobTiers.some((tier) => positive(tier.price) && positive(tier.minQuantity))) add('trade.fob.tiers.missing', 'trade', 'error', 'fobPrice', 'FOB阶梯价格不能为空');
  if (fobTiers.some((tier, index) => index > 0 && Number(tier.minQuantity) <= Number(fobTiers[index - 1].minQuantity))) add('trade.fob.tiers.order', 'trade', 'error', 'fobPrice', 'FOB阶梯起订量必须严格递增');
  if (tiers.some((tier, index) => index > 0 && Number(tier.minQuantity) <= Number(tiers[index - 1].minQuantity))) add('trade.tiers.order', 'trade', 'error', 'priceTiers', '阶梯价起订量必须严格递增');
  if (!text(product.salesUnit)) add('trade.unit.missing', 'trade', 'warning', 'salesUnit', '缺少计量单位');
  if (!positive(packaging.weight)) add('logistics.weight.missing', 'logistics', 'warning', 'packaging.weight', '缺少包装重量，按发布页要求处理');
  if (!positive(packaging.length) || !positive(packaging.width) || !positive(packaging.height)) add('logistics.size.missing', 'logistics', 'warning', 'packaging', '包装长宽高不完整');
  if (!list(product.deliveryTime).length) add('logistics.lead.missing', 'logistics', 'warning', 'deliveryTime', '缺少发货期');
  if (!text(product.description) && !text(product.descriptionHtml)) add('description.missing', 'description', 'error', 'descriptionHtml', '缺少商品详情');
  if (!text(product.descriptionHtml)) add('description.html.missing', 'description', 'warning', 'descriptionHtml', '未保留来源富文本详情');
  const captured = product.source?.snapshot || product;
  if (/^(?:en|en[-_])/i.test(captured.sourceLanguage || sourceLanguage) && /[\u3400-\u9fff]/.test(JSON.stringify({ title: captured.sourceOriginalTitle, subtitle: captured.subtitle, keywords: captured.keywords, attributes: captured.attributes, description: captured.description }))) {
    add('source.language.mismatch', 'source', 'warning', 'sourceLanguage', '来源标记为英文，但采集字段仍含中文，请重新采集源站资料');
  }

  const errors = issues.filter((item) => item.severity === 'error').length;
  const warnings = issues.filter((item) => item.severity === 'warning').length;
  const score = Math.max(0, Math.round(100 - errors * 12 - warnings * 4));
  return {
    status: errors ? 'blocked' : warnings ? 'review' : 'complete', score, errors, warnings,
    issues, checkedAt: nowIso(),
    counts: { mainImages: mainImages.length, detailImages: detailImages.length, attributes: attributes.length, variantGroups: groups.length, skus: skus.length, expectedSkus: expectedSkuCount, priceTiers: tiers.length, sourcePriceRange: hasValidSourceRange ? 1 : 0 },
    sourceIntegrity
  };
}

export function syncProductModel(product, options = {}) {
  product.sourcePlatform = sourcePlatform(product);
  product.schemaVersion = PRODUCT_SCHEMA_VERSION;
  product.source = product.source || {
    platform: product.sourcePlatform,
    productId: product.sourceId || '', url: product.sourceUrl || '', capturedAt: options.capturedAt || product.updatedAt || nowIso(),
    shopId: product.shopId || '', groupId: product.groupId || '', evidence: product.evidence || {}
  };
  product.source.productId = product.sourceId || product.source.productId || '';
  product.source.url = product.sourceUrl || product.source.url || '';
  product.source.language = product.sourceLanguage || product.source.language || '';
  product.source.captureLocale = product.sourceCaptureLocale || product.source.captureLocale || '';
  product.source.languageEvidence = product.sourceLanguageEvidence || product.source.languageEvidence || null;
  if (options.captureSource || !product.source.snapshot) {
    product.source.snapshot = snapshotFields(options.sourceSnapshot || product);
    product.source.snapshotHash = fingerprint(product.source.snapshot);
    product.source.snapshotHashVersion = 2;
  } else if (!product.source.snapshotHash) {
    product.source.snapshotHash = fingerprint(product.source.snapshot);
    product.source.snapshotHashVersion = 2;
  }
  product.working = snapshotFields(product);
  product.sourceIntegrity = verifySourceIntegrity(product);
  product.quality = auditProduct(product);
  product.auditTrail = list(product.auditTrail);
  product.publishHistory = list(product.publishHistory);
  return product;
}

export function recordProductMutation(product, patch, context = {}) {
  const before = snapshotFields(product);
  patch = synchronizeProductOrigin(product, patch);
  if (patch.packaging && typeof patch.packaging === 'object') patch = { ...patch, packaging: { ...product.packaging, ...patch.packaging } };
  if ((context.actor || 'user') !== 'system') {
    for (const field of ['stock', 'skus']) {
      if (Object.hasOwn(patch, field) && stockValuesChanged(product[field], patch[field], field)) {
        patch = { ...patch, stockProvenance: { ...product.stockProvenance, ...patch.stockProvenance, [field]: 'manual' } };
      }
    }
  }
  Object.assign(product, patch);
  product.updatedAt = nowIso();
  product.auditTrail = list(product.auditTrail);
  product.auditTrail.unshift({
    id: context.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: product.updatedAt, actor: context.actor || 'user', action: context.action || 'edit',
    fields: Object.keys(patch), before, after: snapshotFields(product)
  });
  product.auditTrail = product.auditTrail.slice(0, 100);
  return syncProductModel(product);
}

export function createPublishSnapshot(product, context = {}) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: nowIso(), mode: context.mode || 'draft', target: 'alibaba.com',
    category: context.category || '', categoryId: context.categoryId || '', publishPageUrl: context.publishPageUrl || '',
    data: snapshotFields(product), quality: auditProduct(product)
  };
}
