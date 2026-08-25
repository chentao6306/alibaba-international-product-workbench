import crypto from 'node:crypto';

export const PRODUCT_SCHEMA_VERSION = 3;

const nowIso = () => new Date().toISOString();
const list = (value) => Array.isArray(value) ? value : [];
const text = (value) => String(value ?? '').trim();
const positive = (value) => Number(value) > 0;

function snapshotFields(product) {
  return structuredClone({
    sourceId: product.sourceId || '', sourceUrl: product.sourceUrl || '', sourceTitle: product.sourceTitle || '',
    sourceOriginalTitle: product.sourceOriginalTitle || '', sourceLanguage: product.sourceLanguage || '',
    sourceCaptureLocale: product.sourceCaptureLocale || '', sourceLanguageEvidence: product.sourceLanguageEvidence || null,
    sourcePrice: product.sourcePrice ?? '', currencySymbol: product.currencySymbol || '', sourcePriceText: product.sourcePriceText || '',
    collectedDetailAt: product.collectedDetailAt || '', dataCompleteness: product.dataCompleteness || null,
    title: product.title || '', subtitle: product.subtitle || '', keywords: list(product.keywords),
    categoryPath: list(product.categoryPath || product.sourceCategoryPath), categoryId: product.categoryId || '',
    mainImages: list(product.mainImages || product.images), detailImages: list(product.detailImages),
    videos: list(product.videos), videoUrl: product.videoUrl || '', attributes: list(product.attributes),
    customAttributes: list(product.customAttributes), variantGroups: list(product.variantGroups), skus: list(product.skus),
    priceTiers: list(product.priceTiers), sourcePriceTiers: list(product.sourcePriceTiers),
    stock: product.stock ?? null, moq: product.moq ?? null, deliveryCountry: product.deliveryCountry || '', salesUnit: product.salesUnit || '',
    paymentMethod: product.paymentMethod || '', fobPrice: product.fobPrice || '', priceMode: product.priceMode || '',
    origin: product.origin || '', model: product.model || '', brand: product.brand || '', productType: product.productType || '',
    packaging: product.packaging || {}, deliveryTime: list(product.deliveryTime), shipping: product.shipping || {},
    freightTemplate: product.freightTemplate || '', services: product.services || {}, certificates: list(product.certificates),
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
  const actual = sourceSnapshotFingerprint(snapshot);
  const expected = product.source.snapshotHash || '';
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
  const packaging = product.packaging || {};
  const sourceLanguage = text(product.sourceLanguage).toLowerCase();
  const sourceIntegrity = verifySourceIntegrity(product);

  if (sourceIntegrity.present && !sourceIntegrity.valid) {
    add('source.snapshot.tampered', 'source', 'error', 'source.snapshot', '来源快照指纹不一致，禁止将工作数据当作来源原数据');
  }

  if (!text(product.title)) add('basic.title.missing', 'basic', 'error', 'title', '缺少商品标题');
  if (!list(product.categoryPath || product.sourceCategoryPath).length && !text(product.categoryId)) add('taxonomy.category.missing', 'taxonomy', 'warning', 'categoryPath', '未识别商品类目');
  if (!text(product.subtitle)) add('basic.subtitle.missing', 'basic', 'info', 'subtitle', '未采集副标题');
  if (!list(product.keywords).length) add('basic.keywords.missing', 'basic', 'warning', 'keywords', '未采集商品关键词');
  if (mainImages.length < 4) add('media.main.insufficient', 'media', 'error', 'mainImages', `主图不足4张（当前${mainImages.length}张）`);
  if (!detailImages.length) add('media.detail.missing', 'media', 'error', 'detailImages', '缺少详情图片');
  if (attributes.length < 2) add('attributes.insufficient', 'attributes', 'error', 'attributes', `商品属性不足2项（当前${attributes.length}项）`);
  if (!text(product.origin)) add('attributes.origin.missing', 'attributes', 'error', 'origin', '缺少产地');
  if (groups.length && !skus.length) add('sku.rows.missing', 'variants', 'error', 'skus', '存在规格但缺少SKU明细');
  const expectedSkuCount = groups.reduce((count, group) => count * Math.max(1, list(group.options).length), groups.length ? 1 : 0);
  if (groups.length && skus.length && expectedSkuCount !== skus.length) add('sku.rows.incomplete', 'variants', 'error', 'skus', `SKU组合不完整（应有${expectedSkuCount}行，当前${skus.length}行）`);
  if (groups.length && skus.length && skus.every((sku) => sku.derived || sku.source === 'derived')) add('sku.derived.only', 'variants', 'warning', 'skus', 'SKU由规格组合推导，不是来源页面真实SKU');
  if (skus.some((sku) => !text(sku.code || sku.skuCode))) add('sku.code.missing', 'variants', 'info', 'skus', '部分SKU缺少商品编码');
  if (skus.some((sku) => !positive(sku.price) || Number(sku.stock) < 0)) add('sku.values.invalid', 'variants', 'error', 'skus', '部分SKU价格或库存无效');
  if (!positive(product.price) && !tiers.some((tier) => positive(tier.price))) add('trade.price.invalid', 'trade', 'error', 'price', '缺少有效销售价格');
  if (!tiers.length) add('trade.tiers.missing', 'trade', 'error', 'priceTiers', '缺少阶梯价格');
  if (tiers.some((tier, index) => index > 0 && Number(tier.minQuantity) <= Number(tiers[index - 1].minQuantity))) add('trade.tiers.order', 'trade', 'error', 'priceTiers', '阶梯价起订量必须严格递增');
  if (!text(product.salesUnit)) add('trade.unit.missing', 'trade', 'warning', 'salesUnit', '缺少计量单位');
  if (!positive(packaging.weight)) add('logistics.weight.missing', 'logistics', 'error', 'packaging.weight', '缺少包装重量');
  if (!positive(packaging.length) || !positive(packaging.width) || !positive(packaging.height)) add('logistics.size.missing', 'logistics', 'warning', 'packaging', '包装长宽高不完整');
  if (!list(product.deliveryTime).length) add('logistics.lead.missing', 'logistics', 'warning', 'deliveryTime', '缺少发货期');
  if (!text(product.description) && !text(product.descriptionHtml)) add('description.missing', 'description', 'error', 'descriptionHtml', '缺少商品详情');
  if (!text(product.descriptionHtml)) add('description.html.missing', 'description', 'warning', 'descriptionHtml', '未保留来源富文本详情');
  if (/^(?:en|en[-_])/i.test(sourceLanguage) && /[\u3400-\u9fff]/.test(JSON.stringify({ title: product.sourceOriginalTitle, subtitle: product.subtitle, keywords: product.keywords, attributes: product.attributes, description: product.description }))) {
    add('source.language.mismatch', 'source', 'warning', 'sourceLanguage', '来源标记为英文，但采集字段仍含中文，请重新采集源站资料');
  }

  const errors = issues.filter((item) => item.severity === 'error').length;
  const warnings = issues.filter((item) => item.severity === 'warning').length;
  const score = Math.max(0, Math.round(100 - errors * 12 - warnings * 4));
  return {
    status: errors ? 'blocked' : warnings ? 'review' : 'complete', score, errors, warnings,
    issues, checkedAt: nowIso(),
    counts: { mainImages: mainImages.length, detailImages: detailImages.length, attributes: attributes.length, variantGroups: groups.length, skus: skus.length, expectedSkus: expectedSkuCount, priceTiers: tiers.length },
    sourceIntegrity
  };
}

export function syncProductModel(product, options = {}) {
  product.schemaVersion = PRODUCT_SCHEMA_VERSION;
  product.source = product.source || {
    platform: /1688\.com/i.test(product.sourceUrl || '') ? '1688' : 'alibaba.com',
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
    product.source.snapshotHash = sourceSnapshotFingerprint(product.source.snapshot);
  } else if (!product.source.snapshotHash) {
    product.source.snapshotHash = sourceSnapshotFingerprint(product.source.snapshot);
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
    category: context.category || '', data: snapshotFields(product), quality: auditProduct(product)
  };
}
