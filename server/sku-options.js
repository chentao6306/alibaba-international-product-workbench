const key = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const text = value => String(value ?? '').trim();
const hasImages = group => Object.values(group.optionImages || {}).some(Boolean)
  || (group.optionValues || []).some(value => value.image)
  || /image/i.test(group.type || '');

// An option label is not its identity: the source can expose several distinct
// colors/styles under the same label. Repair only when source IDs prove which
// option belongs to every SKU; never merge rows or infer IDs from row order.
export function recoverDuplicateSkuOptions(product, { strict = false, normalizeValue = value => value } = {}) {
  const optionKey = value => key(normalizeValue(value));
  const groups = product.variantGroups || [];
  const repeated = groups.filter(group => {
    const values = (group.options || []).map(optionKey);
    return new Set(values).size !== values.length;
  });
  if (!repeated.length) return product;
  const fail = () => {
    if (strict) throw Object.assign(new Error('同名规格选项缺少可唯一核对的来源 ID、图片或原始组合，请核对规格资料；未合并 SKU 或覆盖价格库存'), {
      code: 'PUBLISH_SKU_IDENTITY_UNRESOLVED', requiredFields: repeated.map(group => group.name),
    });
    return product;
  };
  if (!product.skus?.length || repeated.some(group => !text(group.id) || !text(group.name)
    || groups.filter(item => text(item.id) === text(group.id)).length !== 1
    || groups.filter(item => key(item.name) === key(group.name)).length !== 1)) return fail();

  const decoded = new Map();
  for (const sku of product.skus) {
    if (sku.evidence?.method !== 'detailData.skuInfoMap' || !sku.evidence.combination) return fail();
    const selected = new Map();
    for (const token of sku.evidence.combination.split(';').map(text).filter(Boolean)) {
      const parts = token.split(':').map(text);
      const group = repeated.find(item => text(item.id) === parts[0]);
      if (!group) continue;
      if (parts.length !== 2 || !parts[1] || selected.has(group)) return fail();
      selected.set(group, parts[1]);
    }
    if (selected.size !== repeated.length) return fail();
    decoded.set(sku, selected);
  }

  const repaired = new Map();
  const imageGroups = groups.filter(hasImages);
  for (const group of repeated) {
    const options = group.options || [];
    if (options.some(option => typeof option !== 'string' || !key(option))) return fail();
    const canUseSkuImage = groups.length === 1 || (imageGroups.length === 1 && imageGroups[0] === group);
    const rawValues = Array.isArray(group.optionValues) && group.optionValues.length ? group.optionValues : null;
    let values;
    if (rawValues) {
      // Collection retains this array before its old label-keyed maps can
      // overwrite an ID or image. It also detects conflicting manual edits.
      const prior = group.optionIdentityMappings;
      if (rawValues.length !== options.length) return fail();
      if (rawValues.some((value, index) => value.name !== options[index])) {
        // A previous source-label repair can itself collide after the target
        // value conversion. Match its retained IDs, never the current row order.
        if (!Array.isArray(prior) || prior.length !== options.length
          || prior.some((value, index) => value.name !== options[index])
          || new Set(prior.map(value => text(value.id))).size !== prior.length) return fail();
        values = prior.map(value => {
          const original = rawValues.filter(item => text(item.id) === text(value.id));
          if (original.length !== 1 || original[0].name !== value.sourceName
            || text(original[0].image) !== text(value.image)) return null;
          return { ...value, id: text(value.id), image: text(value.image) };
        });
        if (values.some(value => !value)) return fail();
      } else values = rawValues.map(value => ({ ...value, id: text(value.id), name: value.name, image: text(value.image) }));
    } else {
      if (hasImages(group) && !canUseSkuImage) return fail();
      const byId = new Map();
      const snapshot = product.source?.snapshot;
      const originalGroup = snapshot?.variantGroups?.find(item => text(item.id) === text(group.id));
      const originalRowsByCombination = new Map();
      if (originalGroup) for (const row of snapshot.skus || []) {
        const combination = row.evidence?.combination;
        if (combination) originalRowsByCombination.set(combination, [...(originalRowsByCombination.get(combination) || []), row]);
      }
      for (const sku of product.skus) {
        const id = decoded.get(sku).get(group), name = sku.attributes?.[group.name];
        if (!options.includes(name)) return fail();
        const originalRows = originalRowsByCombination.get(sku.evidence.combination);
        if (originalRows?.length === 1 && originalRows[0].attributes?.[originalGroup.name] !== name) return fail();
        const image = canUseSkuImage ? text(sku.image) : '';
        const previous = byId.get(id);
        if (previous && (previous.name !== name || (previous.image && image && previous.image !== image))) return fail();
        byId.set(id, { id, name, image: previous?.image || image, source: 'detailData.skuInfoMap' });
      }
      // A sorted ID order is used only for deterministic display suffixes;
      // source combination tokens, never array position, select SKU options.
      const remaining = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
      values = [];
      for (const name of options) {
        const index = remaining.findIndex(value => value.name === name);
        if (index < 0) return fail();
        values.push(remaining.splice(index, 1)[0]);
      }
      if (remaining.length) return fail();
    }
    if (values.some(value => !value.id) || new Set(values.map(value => value.id)).size !== values.length) return fail();
    const byId = new Map(values.map(value => [value.id, value]));
    // Existing label maps identify the last source option with that label.
    // They can confirm that option, but cannot reconstruct overwritten IDs.
    for (const [name, id] of Object.entries(group.optionIds || {})) {
      const value = byId.get(text(id));
      if (!options.includes(name) || !value || value.name !== name) return fail();
      const mappedImage = text(group.optionImages?.[name]);
      if (mappedImage && value.image && mappedImage !== value.image) return fail();
      if (mappedImage && !value.image) value.image = mappedImage;
    }
    for (const sku of product.skus) {
      const value = byId.get(decoded.get(sku).get(group));
      if (!value || sku.attributes?.[group.name] !== value.name) return fail();
      if (canUseSkuImage && value.image && sku.image && text(sku.image) !== value.image) return fail();
    }
    const counts = new Map();
    for (const value of values) counts.set(optionKey(value.name), (counts.get(optionKey(value.name)) || 0) + 1);
    const occupied = new Set(options.map(optionKey)), indexes = new Map();
    const mappings = values.map(value => {
      let name = value.name;
      if (counts.get(optionKey(name)) > 1) {
        let index = indexes.get(optionKey(name)) || 0;
        do { name = `${value.name} (${++index})`; } while (occupied.has(optionKey(name)) && index < 10000);
        if (occupied.has(optionKey(name))) return null;
        indexes.set(optionKey(value.name), index);
        occupied.add(optionKey(name));
      }
      return { id: value.id, sourceName: value.sourceName || value.name, name, image: value.image,
        source: rawValues ? 'detailData.skuAttrs' : 'detailData.skuInfoMap' };
    });
    if (mappings.some(value => !value)) return fail();
    repaired.set(group, {
      ...group,
      sourceOptions: group.sourceOptions || [...options],
      optionValues: rawValues || values,
      optionIdentityMappings: mappings,
      options: mappings.map(value => value.name),
      optionIds: Object.fromEntries(mappings.map(value => [value.name, value.id])),
      optionImages: Object.fromEntries(mappings.filter(value => value.image).map(value => [value.name, value.image])),
    });
  }
  const skus = product.skus.map(sku => {
    const attributes = { ...sku.attributes };
    for (const group of repeated) {
      const mapping = repaired.get(group).optionIdentityMappings.find(value => value.id === decoded.get(sku).get(group));
      attributes[group.name] = mapping.name;
    }
    const generatedName = sku.name === Object.values(sku.attributes || {}).join(' / ');
    return { ...sku, attributes, ...(generatedName ? { name: Object.values(attributes).join(' / ') } : {}) };
  });
  return { ...product, variantGroups: groups.map(group => repaired.get(group) || group), skus };
}
