import { productCategory } from './category-routing.js';

export const REQUIRED_ATTRIBUTE_ALIASES = [
  ['屏幕', '屏幕尺寸', 'screen', 'display', 'screen size'],
  ['电池容量', 'battery capacity', 'battery'],
  ['蜂窝网络', 'cellular network', 'cellular', 'mobile network', 'network'],
  ['蜂窝频段', 'cellular band', 'frequency band', 'network band', 'band'],
  ['操作系统', 'operating system', 'operation system', 'os'],
  ['手机中央处理器', 'cpu', 'processor', 'central processing unit'],
  ['功能', 'function', 'feature', 'features', '功能/特性', '特性'],
  ['端口', 'port', 'interface', '接口'],
  ['处理器品牌', 'processor brand'],
  ['处理器型号', 'processor type', 'processor model'],
  ['降噪', 'noise cancelling', 'noise canceling', 'noise cancellation'],
  ['防水等级', 'waterproof standard', 'waterproof rating'],
  ['屏幕刷新率', 'display refresh rate'],
  ['快速充电', 'quick charge'],
  ['前置摄像头', 'front camera'],
  ['后置摄像头', 'rear camera'],
  ['屏幕 resolution', 'screen resolution', '显示分辨率', 'display resolution'],
  ['材质', 'material', '材料'],
  ['适用型号', 'compatible model', 'model compatibility'],
  ['类型', 'type', 'product type', '产品类型'],
  ['产地', 'place of origin', 'origin'],
  ['品牌名称', 'brand name', 'brand'],
  ['型号', 'model number', 'model'],
  ['省份', 'province'],
  ['私模', 'private mold']
];

const normalize = (value) => String(value || '').toLowerCase().replace(/[\s_\-/]+/g, ' ').trim();
export function requiredAttributeKey(value) {
  const key = normalize(value);
  const group = REQUIRED_ATTRIBUTE_ALIASES.find((aliases) => aliases.some((alias) => normalize(alias) === key));
  return group ? group[0] : key;
}

// Error labels are data, never instructions to replace a listing wholesale.
const protectedField = /商品名称|产品名称|标题|价格|起订量|库存|图片|主图|详情|描述|运费|重量|尺寸|认证|证书|title|product name|price|quantity|stock|image|description|shipping|weight|certificate/i;
const successful = (result) => ['published', 'submitted', 'success'].includes(String(result?.status || '').toLowerCase());

export function createRequiredFieldRepair(target, reference, fields = []) {
  const wanted = new Set(fields.filter((name) => !protectedField.test(name)).map(requiredAttributeKey));
  // Screen dimensions are category attributes; generic packaging dimensions
  // and commercial/media fields must never be borrowed by this repair.
  for (const name of fields) if (requiredAttributeKey(name) === '屏幕') wanted.add('屏幕');
  if (!wanted.size) return null;
  const entries = [
    ...(reference.attributes || []), ...(reference.customAttributes || []),
    ...(reference.variantGroups || []).filter((group) => group.options?.length === 1)
      .map((group) => ({ name: group.name, value: group.options[0] })),
    ...['origin', 'province', 'brand', 'brandName', 'model', 'compatibleModel', 'productType', 'material', 'privateMold']
      .map((key) => ({ name: ({ brandName: 'brand name', compatibleModel: 'compatible model', productType: 'product type', privateMold: 'private mold' })[key] || key, value: reference[key] })),
    ...(reference.requiredAttributes || [])
  ];
  const values = new Map(entries.filter((item) => item?.name && String(item.value ?? '').trim())
    .map((item) => [requiredAttributeKey(item.name), item.value]));
  const attributes = structuredClone(target.attributes || []);
  const customAttributes = structuredClone(target.customAttributes || []);
  const repaired = [];
  for (const key of wanted) {
    const value = values.get(key);
    if (value == null) continue;
    const rows = [...attributes, ...customAttributes].filter((row) => requiredAttributeKey(row.name) === key);
    if (rows.length && rows.every((row) => String(row.value) === String(value))) continue;
    if (rows.length) {
      for (const row of rows) Object.assign(row, { value: structuredClone(value), source: 'reference-published-product' });
    } else attributes.push({ name: key, value: structuredClone(value), source: 'reference-published-product' });
    repaired.push(key);
  }
  if (!repaired.length) return null;
  const patch = { attributes };
  const topLevel = { 产地: 'origin', 省份: 'province', 品牌名称: 'brand', 型号: 'model', 适用型号: 'compatibleModel', 类型: 'productType' };
  for (const key of repaired) {
    const field = topLevel[key];
    if (field && Object.hasOwn(target, field)) patch[field] = structuredClone(values.get(key));
  }
  if (JSON.stringify(customAttributes) !== JSON.stringify(target.customAttributes || [])) patch.customAttributes = customAttributes;
  return { patch, fields: repaired };
}

export function createPublishedReferenceTemplate(candidate, snapshot) {
  const reference = snapshot ? { ...candidate, ...snapshot.data,
    ...(snapshot.categoryId ? { categoryId: snapshot.categoryId, targetCategoryId: snapshot.categoryId } : {}) } : { ...candidate };
  const requiredAttributes = (snapshot?.result || candidate.publishResult)?.requiredAttributes || [];
  const repair = createRequiredFieldRepair(reference, { requiredAttributes }, requiredAttributes.map((item) => item.name));
  return { ...reference, ...repair?.patch, requiredAttributes };
}

export function findPublishedReferenceRepair(target, products, fields, attemptedIds = []) {
  const targetCategory = productCategory(target);
  if (!targetCategory.id && !targetCategory.pathKey) return null;
  for (const candidate of products) {
    if (candidate.id === target.id || attemptedIds.includes(candidate.id)) continue;
    const snapshots = (candidate.publishHistory || []).filter((entry) => successful(entry.result) && entry.data)
      .map((entry) => createPublishedReferenceTemplate(candidate, entry));
    if (successful(candidate.publishResult) || candidate.status === 'published') {
      if (!snapshots.length) snapshots.push(createPublishedReferenceTemplate(candidate));
    }
    for (const reference of snapshots) {
      const category = productCategory(reference);
      const matches = targetCategory.id && category.id ? targetCategory.id === category.id
        : Boolean(targetCategory.pathKey && category.pathKey === targetCategory.pathKey);
      if (!matches) continue;
      const repair = createRequiredFieldRepair(target, reference, fields);
      if (repair) return { ...repair, referenceId: candidate.id, referenceTitle: candidate.title };
    }
  }
  return null;
}
