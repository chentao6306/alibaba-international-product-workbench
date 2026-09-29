// Shared by the editor and its API; source evidence and publish state are not editable.
export const PRODUCT_EDIT_FIELDS = [
  'title', 'subtitle', 'keywords', 'price', 'stock', 'moq', 'currencySymbol',
  'categoryPath', 'categoryId', 'attributes', 'customAttributes', 'origin', 'province',
  'brand', 'brandName', 'model', 'material', 'privateMold', 'productType',
  'compatibleBrand', 'compatibleBrands', 'compatibleModel', 'compatibleModels', 'color', 'type',
  'variantGroups', 'skus', 'colorImages', 'modelImages', 'specifications',
  'mainImage', 'images', 'mainImages', 'detailImages', 'videoUrl', 'videos',
  'description', 'descriptionHtml', 'structuredDescription',
  'priceTiers', 'fobPrice', 'priceMode', 'skuPriceMode', 'salesUnit', 'paymentMethod',
  'packaging', 'deliveryTime', 'shipping', 'freightTemplate', 'logisticsAttributes',
  'deliveryCountry', 'deliveryOptions', 'services', 'certificates', 'regionalPricing', 'sellerGroup',
];

export function productEditPatch(value = {}) {
  return structuredClone(Object.fromEntries(Object.entries(value).filter(([key]) => PRODUCT_EDIT_FIELDS.includes(key))));
}

// Property/value IDs belong to their original category. Preserve the product
// text and commerce, but require fresh bindings after an explicit leaf change.
export function categoryChangePatch(product, patch) {
  if (patch.categoryId == null || String(patch.categoryId) === String(product.categoryId || '')) return patch;
  const next = { ...patch, categoryReference: null };
  for (const key of ['targetCategory', 'targetCategoryId', 'targetCategoryPath', 'internationalCategory', 'internationalCategoryPath', 'publishCategory', 'publishCategoryId', 'categoryAttributes']) next[key] = null;
  for (const field of ['attributes', 'variantGroups']) {
    const items = Object.hasOwn(patch, field) ? patch[field] : product[field];
    if (!Array.isArray(items)) continue;
    next[field] = items.map((item) => {
      const value = { ...item };
      for (const key of ['id', 'attributeId', 'propertyId', 'attrId', 'propId', 'valueId', 'valueIds', 'attributeValueId', 'propertyValueId', 'optionIds']) delete value[key];
      return value;
    });
  }
  return next;
}
