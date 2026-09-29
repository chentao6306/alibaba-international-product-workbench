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
  else {
    const slot = String(operation).match(/^delete-(main|detail)-(\d+)$/);
    if (!slot || Number(slot[2]) < 1) throw new Error('不支持的图片操作');
    next[slot[1] === 'main' ? 'mainImages' : 'detailImages'].splice(Number(slot[2]) - 1, 1);
  }
  return next;
}
