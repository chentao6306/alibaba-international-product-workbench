// Keep the accepted snapshot for references and publication history. Removing
// it from the workbench must not break another product's chosen reference.
export function removePublishedFromWorkbench(state, productId, result, jobId) {
  if (state.settings.autoRemovePublishedProducts !== true || result?.status !== 'published') return false;
  const product = state.products.find(item => item.id === productId);
  if (!product || product.status !== 'published') return false;
  product.removedFromWorkbenchAt = new Date().toISOString();
  product.selected = false;
  const job = state.jobs.find(item => item.id === jobId);
  if (job?.results?.[productId]) Object.assign(job.results[productId], { title: product.title, url: result.url || '', removedFromWorkbench: true });
  return true;
}

export const workbenchProducts = products => products.filter(product => !product.removedFromWorkbenchAt);
