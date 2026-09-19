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
