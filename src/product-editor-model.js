import { categoryChangePatch, productEditPatch } from '../server/product-edit.js';
import { requiredAttributeKey } from '../server/publish-reference.js';
import { productOrigin, synchronizeProductOrigin } from '../server/origin-country.js';
import { freightTemplateForProduct, cartonModeForProduct } from '../server/publish-policy.js';

const clone = (value) => structuredClone(value);
export const attributeKey = requiredAttributeKey;
export const valuesOf = (value) => (Array.isArray(value) ? value : [value]).filter((item) => item != null && String(item).trim() !== '').map(String);
export const attributeLabels = { '品牌名称': '品牌名称', '产地': '产地', '原产地': '产地', '省份': '省份', '适用品牌': '适用品牌', '材质': '材质', '私模': '私模', '颜色': '颜色', '型号': '型号', '适用型号': '适用型号', '类型': '类型' };
export const labelOf = (name) => attributeLabels[attributeKey(name)] || name;
const aliases = { '品牌名称': 'brand', '产地': 'origin', '原产地': 'origin', '省份': 'province', '型号': 'model', '材质': 'material', '私模': 'privateMold', '类型': 'productType', '颜色': 'color' };

export function createEditorForm(product) {
  const form = productEditPatch(product);
  for (const key of ['title', 'subtitle', 'description', 'descriptionHtml', 'categoryId', 'origin', 'model', 'brand', 'videoUrl', 'paymentMethod', 'freightTemplate']) form[key] ??= '';
  for (const key of ['keywords', 'attributes', 'customAttributes', 'variantGroups', 'skus', 'priceTiers', 'deliveryTime', 'detailImages', 'videos', 'logisticsAttributes', 'certificates']) form[key] ??= [];
  for (const key of ['packaging', 'services', 'shipping', 'regionalPricing']) form[key] ??= {};
  if (typeof form.shipping !== 'object' || Array.isArray(form.shipping)) form.shipping = { notes: String(form.shipping || '') };
  form.mainImages = clone(product.mainImages || product.images || (product.mainImage ? [product.mainImage] : []));
  form.categoryPath = clone(product.categoryPath || (product.sourcePlatform === 'alibaba.com' ? product.sourceCategoryPath : []) || []);
  form.origin = productOrigin(product) || product.origin || '';
  form.salesUnit ||= 'Piece';
  form.freightTemplate = freightTemplateForProduct(product);
  form.shipping.cartonMode = cartonModeForProduct(product);
  form.priceMode ||= 'quantity-tier';
  form.price ??= ''; form.stock ??= ''; form.moq ??= '';
  if (form.moq !== '' && !Number.isFinite(Number(form.moq))) form.moq = String(form.moq).match(/\d[\d,]*(?:\.\d+)?/)?.[0]?.replace(/,/g, '') || '';
  if (form.videoUrl && !form.videos.some((item) => item.role === 'main')) form.videos.unshift({ role: 'main', url: form.videoUrl });
  for (const [key, name] of [['origin', 'Place of Origin'], ['province', 'Province'], ['brand', 'Brand Name'], ['privateMold', 'Private Mold'], ['material', 'Material'], ['model', 'Model Number'], ['productType', 'Type']]) {
    if (form.variantGroups.some((group) => attributeKey(group.name) === attributeKey(name))) continue;
    if (valuesOf(form[key]).length && !form.attributes.some((item) => attributeKey(item.name) === attributeKey(name))) form.attributes.push({ name, value: clone(form[key]) });
  }
  return form;
}

export function editAttribute(form, index, item) {
  const previous = form.attributes[index];
  const next = { ...item };
  const renamed = previous && attributeKey(previous.name) !== attributeKey(next.name);
  if (renamed) for (const key of ['id', 'attributeId', 'propertyId', 'attrId', 'propId']) delete next[key];
  if (renamed || JSON.stringify(previous?.value) !== JSON.stringify(next.value)) {
    for (const key of ['valueId', 'valueIds', 'attributeValueId', 'propertyValueId']) delete next[key];
  }
  const attributes = [...form.attributes]; attributes[index] = next;
  const key = attributeKey(next.name), property = aliases[key];
  const patch = { attributes, ...(property ? { [property]: clone(next.value) } : {}) };
  if (key === attributeKey('brand')) patch.brandName = clone(next.value);
  if (key === attributeKey('Compatible Brand')) { patch.compatibleBrand = ''; patch.compatibleBrands = valuesOf(next.value); }
  if (key === attributeKey('Compatible Model')) { patch.compatibleModel = ''; patch.compatibleModels = valuesOf(next.value); }
  return { ...form, ...synchronizeProductOrigin(form, patch) };
}

export function editorAttributeRows(form, requirements = []) {
  const idOf = (item) => String(item.id || item.attributeId || item.propertyId || item.attrId || item.propId || '');
  const used = new Set();
  // Keep schema rows in the same list and position before and after their first edit.
  // A placeholder must not remount (or change control type) when its value is added.
  const schemaRows = requirements.map((descriptor, at) => {
    const id = idOf(descriptor);
    let index = id ? form.attributes.findIndex((item, i) => !used.has(i) && idOf(item) === id) : -1;
    if (index < 0) index = form.attributes.findIndex((item, i) => !used.has(i)
      && !(id && idOf(item) && id !== idOf(item)) && attributeKey(item.name) === attributeKey(descriptor.label));
    if (index >= 0) used.add(index);
    return { key: `field-${at}`, index: index < 0 ? form.attributes.length : index, descriptor,
      item: index < 0 ? { id: descriptor.id, name: descriptor.label, value: '' } : form.attributes[index] };
  });
  const rows = form.attributes.flatMap((item, index) => used.has(index) ? [] : [{ key: `attribute-${index}`, item, index }]);
  const order = ['Place of Origin', 'Province', 'Brand Name'].map(attributeKey);
  const rank = (item) => order.includes(attributeKey(item.name)) ? order.indexOf(attributeKey(item.name)) : order.length;
  return [...rows, ...schemaRows].sort((left, right) => rank(left.item) - rank(right.item));
}

export function rebuildEditorSkus(form, groups = form.variantGroups) {
  const active = groups.filter((group) => group.name.trim() && group.options.length);
  if (new Set(active.map((group) => attributeKey(group.name))).size !== active.length) throw new Error('规格名称不能重复');
  const count = active.reduce((total, group) => total * group.options.length, 1);
  if (count > 1000) throw new Error(`规格组合有 ${count} 行，请减少到 1000 行以内`);
  const signature = (attributes) => JSON.stringify(Object.entries(attributes || {}).map(([name, value]) => [attributeKey(name), value]).sort());
  const previous = new Map(form.skus.map((sku) => [signature(sku.attributes), sku]));
  let combinations = [{}];
  for (const group of active) combinations = combinations.flatMap((row) => [...new Set(group.options)].map((value) => ({ ...row, [group.name]: value })));
  const skus = combinations.map((attributes, index) => {
    const old = previous.get(signature(attributes));
    const imageBindings = active.filter((group) => Object.hasOwn(group.optionImages || {}, attributes[group.name]));
    const image = imageBindings.map((group) => group.optionImages[attributes[group.name]]).find(Boolean) || '';
    return { ...(old || { id: `manual-${index + 1}`, price: form.price || '', stock: form.stock === '' ? null : form.stock, code: '', enabled: true, derived: true, source: 'manual' }),
      attributes, image: imageBindings.length ? image : old?.image || '' };
  });
  const imageMap = (name) => clone(groups.find((group) => attributeKey(group.name) === attributeKey(name))?.optionImages || {});
  const groupKeys = new Set([...form.variantGroups, ...groups].map((group) => attributeKey(group.name)));
  for (const sku of form.skus) for (const name of Object.keys(sku.attributes || {})) groupKeys.add(attributeKey(name));
  const patch = {};
  for (const name of groupKeys) {
    const group = groups.find((group) => attributeKey(group.name) === name);
    const value = group?.options || [];
    if (aliases[name]) patch[aliases[name]] = value.join(', ');
    if (name === attributeKey('Compatible Model')) { patch.compatibleModels = value; patch.compatibleModel = ''; }
  }
  const attributes = form.attributes.flatMap((item) => {
    if (!groupKeys.has(attributeKey(item.name))) return [item];
    const group = groups.find((group) => attributeKey(group.name) === attributeKey(item.name));
    if (!group?.options.length) return [];
    const { valueId, valueIds, attributeValueId, propertyValueId, ...rest } = item;
    return [{ ...rest, value: clone(group.options) }];
  });
  return { ...form, ...patch, attributes, variantGroups: clone(groups), skus, colorImages: imageMap('Color'), modelImages: imageMap('Model Number'), specifications: {} };
}

export function editorPayload(form) {
  const payload = productEditPatch(form);
  payload.mainImages = form.mainImages.map((url) => url.trim()).filter(Boolean);
  payload.images = [...payload.mainImages]; payload.mainImage = payload.mainImages[0] || '';
  payload.customAttributes = form.customAttributes.filter((item) => String(item.name || '').trim() || valuesOf(item.value).length);
  if (payload.customAttributes.some((item) => !String(item.name || '').trim() || !valuesOf(item.value).length)) throw new Error('自定义属性的名称和属性值必须同时填写');
  payload.attributes = form.attributes.filter((item) => item.name?.trim());
  payload.keywords = form.keywords.map((value) => value.trim()).filter(Boolean);
  payload.logisticsAttributes = form.logisticsAttributes.map((value) => value.trim()).filter(Boolean);
  const cleanTiers = (tiers) => tiers.filter((tier) => tier.minQuantity !== '' || tier.price !== '');
  payload.priceTiers = cleanTiers(form.priceTiers);
  if (payload.fobPrice?.tiers) payload.fobPrice.tiers = cleanTiers(payload.fobPrice.tiers);
  payload.videoUrl = form.videos.find((item) => item.role === 'main' && item.url)?.url || '';
  for (const key of ['price', 'stock', 'moq']) {
    if (form[key] !== '' && form[key] != null) {
      const value = Number(form[key]);
      if (!Number.isFinite(value) || value < 0) throw new Error(`${{ price: '销售价', stock: '库存', moq: '起订量' }[key]}无效`);
      payload[key] = value;
    }
  }
  return payload;
}

export function changeEditorCategory(form, option) {
  return { ...form, ...categoryChangePatch(form, { categoryId: option.id || '', categoryPath: option.path ? option.path.split(' >> ') : [] }) };
}

export function updateDeliveryCell(deliveryTime, index, column, value) {
  const rows = clone(deliveryTime.length ? deliveryTime : [['Quantity (pieces)'], ['Lead time (days)']]);
  rows[0] ||= ['Quantity (pieces)']; rows[1] ||= ['Lead time (days)'];
  rows[column][index + 1] = value;
  return rows;
}
