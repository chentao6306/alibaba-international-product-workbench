import { productCategory } from './category-routing.js';

export const REQUIRED_ATTRIBUTE_ALIASES = [
  ['屏幕', '屏幕尺寸', 'screen', 'display', 'screen size'],
  ['电池容量', 'battery capacity', 'battery', '电池'],
  ['蜂窝网络', 'cellular network', 'cellular', 'mobile network', 'network'],
  ['蜂窝频段', 'cellular band', 'frequency band', 'network band', 'band'],
  ['操作系统', 'operating system', 'operation system', 'os'],
  ['手机中央处理器', 'cpu', 'processor', 'central processing unit'],
  ['功能', 'function', 'feature', 'features', '功能/特性', '特性', '特征'],
  ['端口', 'port', 'interface', '接口'],
  ['处理器品牌', 'processor brand'],
  ['处理器型号', 'processor type', 'processor model'],
  ['降噪', 'noise cancelling', 'noise canceling', 'noise cancellation'],
  ['防水等级', 'waterproof standard', 'waterproof rating'],
  ['防护等级', 'ip level', 'protection level'],
  ['适用人群', 'applicable people'],
  ['电池续航时间', 'battery life'],
  ['显示类型', 'display type'],
  ['物品形状', 'item shape'],
  ['硬盘容量', 'hard drive capacity'],
  ['屏幕刷新率', 'display refresh rate'],
  ['快速充电', 'quick charge'],
  ['前置摄像头', 'front camera'],
  ['后置摄像头', 'rear camera'],
  ['屏幕 resolution', 'screen resolution', '显示分辨率', 'display resolution'],
  ['材质', 'material', '材料'],
  ['适用型号', 'compatible model', 'model compatibility'],
  ['类型', '种类', 'type', 'product type', '产品类型'],
  ['比例', 'scale'],
  ['保质期', 'shelf life'],
  ['储存类型', '贮存方式', 'storage type'],
  ['配料', 'ingredients'],
  ['食品添加剂', 'additives'],
  ['面料类型', 'fabric type'],
  ['织造方法', 'weaving method'],
  ['图案类型', 'pattern type'],
  ['季节', 'season'],
  ['产地', '原产地', 'place of origin', 'origin', 'country of origin', 'country/region of manufacture'],
  ['品牌名称', '品牌', 'brand name', 'brand'],
  ['适用品牌', 'compatible brand'],
  ['颜色', 'color', 'colour'],
  ['型号', 'model number', 'model'],
  ['省份', 'province'],
  ['私模', 'private mold'],
  ['无人机类型', 'drone type', 'drone types'],
  ['图传距离', 'image transmission distance', 'max transmission distance'],
  ['最大飞行时间', 'max flight time', 'maximum flight time'],
  ['最大起飞重量', 'max takeoff weight', 'maximum takeoff weight'],
  ['控制类型', 'control type', 'controller type'],
  ['最大抗风能力', 'max wind resistance', 'maximum wind resistance'],
  ['操作人员技能水平', 'operator skill level', 'operator skill level required'],
  ['视频采集分辨率', 'video capture resolution'],
  ['运行内存', 'ram'],
  ['存储容量', 'storage capacity', 'rom'],
  ['插头', 'plug', 'plug type'],
  ['年龄范围', '年龄段', 'age range', 'age group'],
  ['适用年龄', 'age', 'applicable age', 'recommended age'],
  ['动物', 'animal', 'animals'],
  ['性别', 'gender'],
  ['是否可定制', 'is customized', 'is_customized', 'customizable', 'customised', 'customized'],
  ['远程距离', '遥控距离', 'remote distance', 'remote control distance', 'control distance'],
  ['套装包含', '套装包括', 'package includes', 'package included', 'set includes'],
  ['组合产品数量', 'number of pieces', 'number of items in set', 'quantity of items in set'],
  ['场景', '适用场景', 'scene', 'scenes', 'applicable scene', 'occasion'],
  ['用途', 'use', 'usage', 'application']
];

const normalize = (value) => String(value || '').normalize('NFKC').toLowerCase().replace(/^[*＊]\s*|\s*[:：]$/g, '').replace(/[\s_\-/]+/g, ' ').trim();
export function requiredAttributeKey(value) {
  const key = normalize(value);
  const group = REQUIRED_ATTRIBUTE_ALIASES.find((aliases) => aliases.some((alias) => normalize(alias) === key));
  return group ? group[0] : key;
}

// Error labels are data, never instructions to replace a listing wholesale.
const protectedField = /商品名称|产品名称|标题|价格|起订量|库存|图片|主图|详情|描述|运费|重量|尺寸|认证|证书|title|product name|price|quantity|stock|image|description|shipping|weight|certificate/i;
const successful = (result) => ['published', 'submitted', 'success'].includes(String(result?.status || '').toLowerCase());

export function createRequiredFieldRepair(target, reference, fields = []) {
  const wanted = new Set(fields.filter((name) => !protectedField.test(name)
    || REQUIRED_ATTRIBUTE_ALIASES.some((aliases) => aliases[0] === requiredAttributeKey(name))).map(requiredAttributeKey));
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
      for (const row of rows) {
        // IDs for rejected values must not select the old option again.
        if (row.valueIds) row.valueIds = {};
        delete row.valueId;
        delete row.attributeValueId;
        delete row.propertyValueId;
        Object.assign(row, { value: structuredClone(value), source: 'reference-published-product' });
      }
    } else attributes.push({ name: key, value: structuredClone(value), source: 'reference-published-product' });
    repaired.push(key);
  }
  if (!repaired.length) return null;
  const patch = { attributes };
  const topLevel = { 产地: 'origin', 省份: 'province', 品牌名称: 'brand', 型号: 'model', 适用型号: 'compatibleModel', 类型: 'productType', 材质: 'material', 私模: 'privateMold' };
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
  const template = { ...reference, ...repair?.patch, requiredAttributes };
  const acceptedLogistics = (snapshot?.result || candidate.publishResult)?.acceptedLogistics;
  for (const field of ['packaging', 'logisticsAttributes', 'freightTemplate']) {
    if ((snapshot?.result || candidate.publishResult)?.listingMode !== 'inquiry'
      && acceptedLogistics && Object.hasOwn(acceptedLogistics, field)) template[field] = structuredClone(acceptedLogistics[field]);
  }
  // Successful form values also belong to specification groups. Leaving the
  // old group options alongside repaired attributes makes the publisher select
  // the rejected options again on the next product.
  template.variantGroups = structuredClone(template.variantGroups || []);
  template.skus = structuredClone(template.skus || []);
  for (const item of requiredAttributes) {
    const group = template.variantGroups.find((group) => requiredAttributeKey(group.name) === requiredAttributeKey(item.name));
    if (!group || group.options?.length !== 1 || !item.value) continue;
    const value = Array.isArray(item.value) ? item.value : [item.value];
    if (value.length !== 1) continue;
    const old = group.options[0];
    group.options = structuredClone(value);
    if (old !== value[0]) group.optionIds = {};
    if (group.optionImages?.[old] && !group.optionImages[value[0]]) group.optionImages[value[0]] = group.optionImages[old];
    for (const sku of template.skus) if (sku.attributes?.[group.name] === old) sku.attributes[group.name] = value[0];
  }
  return template;
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
