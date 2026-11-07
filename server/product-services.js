// Explicit merchant settings only. Collected supplier promises are provenance,
// never evidence that the current seller offers the same customization.
export const customizationKey = (kind, name) => `${kind}:${name}`;

export function customizationGroups(services = {}) {
  return ['lightCustomization', 'deepCustomization'].flatMap(kind => (services[kind] || []).map(name => {
    const setting = services.customizationDetails?.[customizationKey(kind, name)] || {};
    return { kind, name, rows: setting.rows || [setting], baseImage: setting.baseImage || '', hotspot: setting.hotspot };
  }));
}

export function customizationProblems(group) {
  const issues = [];
  if (!group.rows.length || group.rows.length > 6) issues.push('定制值需为 1 至 6 项');
  for (const [index, row] of group.rows.entries()) {
    const prefix = `${group.name} 第 ${index + 1} 项`;
    if (!String(row.value || '').trim()) issues.push(`${prefix}缺少定制值`);
    if (!Number.isInteger(Number(row.moq)) || Number(row.moq) < 1) issues.push(`${prefix}缺少有效起订量`);
    if (row.surcharge !== '' && row.surcharge != null && (!Number.isFinite(Number(row.surcharge)) || Number(row.surcharge) < 0.01)) issues.push(`${prefix}加价需大于或等于 0.01`);
    if (group.kind === 'lightCustomization' && (row.surcharge === '' || row.surcharge == null)) issues.push(`${prefix}缺少加价`);
    if (group.kind === 'lightCustomization' && /^(?:Packaging|包装)$/i.test(group.name) && !row.image) issues.push(`${prefix}缺少包装示例图`);
  }
  if (group.kind === 'lightCustomization' && /logo|图案/i.test(group.name)) {
    if (!group.baseImage) issues.push(`${group.name}缺少商品底图`);
    const h = group.hotspot || {};
    const values = ['x', 'y', 'width', 'height'].map(key => Number(h[key]));
    if (['x', 'y', 'width', 'height'].some(key => h[key] === '' || h[key] == null) || values.some(value => !Number.isFinite(value))
      || values[0] < 0 || values[1] < 0 || values[2] <= 0 || values[3] <= 0 || values[0] + values[2] > 100 || values[1] + values[3] > 100) issues.push(`${group.name}缺少有效的底图定制区域`);
  }
  return issues;
}
