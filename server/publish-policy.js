const present = (value) => value != null && String(value).trim() !== '';
const quantity = (value) => Number(String(value ?? '').replace(/,/g, '').match(/\d+(?:\.\d+)?/)?.[0]) || 0;

export const DEFAULT_FREIGHT_TEMPLATE = '买卖双方协商物流';
export const DEFAULT_CARTON_MODE = '一箱多件';
export function cartonModeForProduct(product) {
  return String(product.shipping?.cartonMode || '').trim() || DEFAULT_CARTON_MODE;
}
export function freightTemplateForProduct(product, selected = '') {
  return String(product.freightTemplate || '').trim() || String(selected || '').trim() || DEFAULT_FREIGHT_TEMPLATE;
}

export function minimumOrderQuantity(product) {
  const tiers = (product.priceTiers || []).map((tier) => quantity(tier.minQuantity)).filter((value) => value > 0);
  return Math.ceil(tiers.length ? Math.min(...tiers) : quantity(product.minOrder || product.moq)) || 1;
}

export function hasManualStock(product, field = 'stock') {
  if (product.stockProvenance?.[field] === 'manual') return true;
  return (product.auditTrail || []).some((entry) => entry.actor !== 'system' && entry.fields?.includes(field)
    && stockValuesChanged(entry.before?.[field], entry.after?.[field], field));
}

export function stockValuesChanged(before, after, field = 'stock') {
  const canonical = (value) => present(value) && Number.isFinite(Number(value)) ? Number(value) : null;
  const values = (value) => field === 'skus' ? (value || []).map((sku) => canonical(sku.stock)) : canonical(value);
  return JSON.stringify(values(before)) !== JSON.stringify(values(after));
}

// Defaults are explicit seller policy, never evidence of actual source stock.
// A legacy 100 is eligible only when the immutable capture proves stock absent.
export function applyStockPolicy(product, { stockPolicy = 'preserve', defaultStock = 100, collected = false } = {}) {
  if (stockPolicy === 'preserve') return product;
  const next = { ...product, stockProvenance: { ...product.stockProvenance } };
  const source = collected ? product : product.source?.snapshot;
  const exactStock = (product.sourceTradeAvailability || source?.sourceTradeAvailability)?.exactSkuStockPublished === true;
  const defaultValue = stockPolicy === 'minimum-order' ? minimumOrderQuantity(product) : Math.max(0, Number(defaultStock) || 0);
  const defaultKind = stockPolicy === 'minimum-order' ? 'default-minimum-order' : 'default-fixed';
  const replace = (field, value, sourceValue) => !hasManualStock(product, field) && !exactStock && (
    !present(value) || String(product.stockProvenance?.[field] || '').startsWith('default-')
    || (source && !present(sourceValue) && Number(value) === 100 && !product.categoryReference)
  );
  if (replace('stock', product.stock, source?.stock)) {
    next.stock = defaultValue;
    next.stockProvenance.stock = defaultKind;
  }
  if (!hasManualStock(product, 'skus') && !exactStock && !product.categoryReference && product.skus?.length) {
    let changed = false;
    next.skus = product.skus.map((sku) => {
      if (sku.enabled === false || (present(sku.stock) && Number(sku.stock) === 0)) return sku;
      if (!replace('skus', sku.stock, null)) return sku;
      changed = true;
      return { ...sku, stock: defaultValue };
    });
    if (changed) next.stockProvenance.skus = defaultKind;
  }
  return next;
}

export function normalizeListingMode(value) {
  return ['auto', 'inquiry'].includes(value) ? value : 'complete-logistics';
}

export function packagingDisplayRows(packaging = {}) {
  return [['weight', 'Package gross weight', 'kg'], ['length', 'Package length', 'cm'],
    ['width', 'Package width', 'cm'], ['height', 'Package height', 'cm']]
    .filter(([key]) => present(packaging[key]) && Number(packaging[key]) > 0)
    .map(([key, name, unit]) => ({ name, value: `${Number(packaging[key])} ${unit}` }));
}
