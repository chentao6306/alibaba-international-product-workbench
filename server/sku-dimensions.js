const key = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

// Source property names are labels, not identities. Two distinct property IDs
// may both be called Material. Keep separate editable keys and the raw label.
export function recoverDuplicateSkuDimensions(product, { strict = false } = {}) {
  const groups = product.variantGroups || [];
  const buckets = new Map();
  for (const group of groups) {
    const name = key(group.name);
    if (name) buckets.set(name, [...(buckets.get(name) || []), group]);
  }
  const duplicates = [...buckets.values()].filter(items => items.length > 1);
  if (!duplicates.length) return product;
  const fail = () => {
    if (strict) throw Object.assign(new Error('同名规格缺少可唯一核对的属性 ID 或原始组合，请核对规格资料；未合并 SKU 或覆盖价格库存'), {
      code: 'PUBLISH_SKU_IDENTITY_UNRESOLVED', requiredFields: duplicates.map(items => items[0].name),
    });
    return product;
  };
  const repeated = duplicates.flat();
  if (!product.skus?.length || repeated.some(group => !group.id)
    || new Set(repeated.map(group => String(group.id))).size !== repeated.length) return fail();
  const renamed = new Map(), occupied = new Set(groups.map(group => key(group.name)));
  for (const items of duplicates) {
    let index = 1;
    for (const group of items) {
      let name;
      do { name = `${group.name} (${index++})`; } while (occupied.has(key(name)));
      occupied.add(key(name)); renamed.set(group, name);
    }
  }
  const byId = new Map(repeated.map(group => [String(group.id), group]));
  const optionRecords = new Map();
  for (const group of repeated) {
    const records = group.optionValues;
    if (!Array.isArray(records) || !records.length) continue;
    if (records.length !== group.options.length || records.some((record, index) => !String(record.id ?? '').trim()
      || record.name !== group.options[index]) || new Set(records.map(record => String(record.id))).size !== records.length) return fail();
    optionRecords.set(group, records);
  }
  const skus = [];
  for (const sku of product.skus) {
    if (sku.evidence?.method !== 'detailData.skuInfoMap' || !sku.evidence.combination) return fail();
    const decoded = new Map(), previous = {};
    for (const token of sku.evidence.combination.split(';').filter(Boolean)) {
      const parts = token.trim().split(':');
      const group = byId.get(parts[0]);
      if (!group) continue;
      if (parts.length !== 2 || decoded.has(group)) return fail();
      const records = optionRecords.get(group);
      const matches = records
        ? records.filter(record => String(record.id) === parts[1]).map(record => [record.name, record.id])
        : Object.entries(group.optionIds || {}).filter(([label, id]) => String(id) === parts[1] && group.options.includes(label));
      if (matches.length !== 1) return fail();
      decoded.set(group, matches[0][0]);
      previous[group.name] = matches[0][0];
    }
    if (decoded.size !== repeated.length) return fail();
    // Reconstruct only the known name-key overwrite. Conflicting manual edits
    // cannot be assigned to either same-named dimension without evidence.
    if (Object.entries(previous).some(([name, value]) => sku.attributes?.[name] !== value)) return fail();
    const attributes = { ...(sku.attributes || {}) };
    for (const group of repeated) delete attributes[group.name];
    for (const group of repeated) attributes[renamed.get(group)] = decoded.get(group);
    const generatedName = sku.name === Object.values(sku.attributes || {}).join(' / ');
    skus.push({ ...sku, attributes, ...(generatedName ? { name: groups.map(group => attributes[renamed.get(group) || group.name]).join(' / ') } : {}) });
  }
  return { ...product, variantGroups: groups.map(group => renamed.has(group)
    ? { ...group, sourceName: group.sourceName || group.name, name: renamed.get(group) } : group), skus };
}
