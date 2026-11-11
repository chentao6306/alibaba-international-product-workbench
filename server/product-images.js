// Shared image draft rules. Empty arrays are intentional user edits.
export function productImageLists(product) {
  return {
    mainImages: [...(product.mainImages || product.images || (product.mainImage ? [product.mainImage] : []))],
    detailImages: [...(product.detailImages || [])],
  };
}

export function imageRevision(product) {
  return JSON.stringify([productImageLists(product), product.descriptionHtml || '', product.structuredDescription || null]);
}

export function editImageLists(product, operation) {
  const next = productImageLists(product);
  if (operation === 'dedupe' || operation === 'clean') {
    for (const key of ['mainImages', 'detailImages']) {
      next[key] = next[key].filter((url) => typeof url === 'string' && url.trim());
      if (operation === 'dedupe') next[key] = [...new Set(next[key])];
    }
  } else if (operation === 'copy-detail') next.detailImages = [...next.mainImages];
  else if (operation === 'clear-main') next.mainImages = [];
  else if (operation === 'clear-detail') next.detailImages = [];
  else if (/^restore-source-(main|detail|all|both)$/.test(operation)) {
    const scope = operation.replace('restore-source-', '');
    const keys = scope === 'main' ? ['mainImages'] : scope === 'detail' ? ['detailImages'] : ['mainImages', 'detailImages'];
    if (product.sourceImageError || !product.sourceImages) throw new Error(product.sourceImageError || '没有可验证的采集原图，请重新采集后重试');
    for (const key of keys) {
      const label = key === 'mainImages' ? '主图' : '详情图';
      const images = product.sourceImages[key];
      if (product.sourceImageErrors?.[key]) throw new Error(product.sourceImageErrors[key]);
      if (!Array.isArray(images) || !images.length) throw new Error(`采集快照中没有${label}，无法恢复`);
      const limit = key === 'mainImages' ? 6 : 30;
      if (images.length > limit) throw new Error(`采集${label}共 ${images.length} 张，超过当前 ${limit} 张限制，未截断原图`);
      next[key] = [...images];
    }
  }
  else {
    const slot = String(operation).match(/^delete-(main|detail)-(\d+)$/);
    if (!slot || Number(slot[2]) < 1) throw new Error('不支持的图片操作');
    next[slot[1] === 'main' ? 'mainImages' : 'detailImages'].splice(Number(slot[2]) - 1, 1);
  }
  return next;
}
