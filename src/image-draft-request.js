export async function readImageDrafts(ids, { signal, timeoutMs = 30000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetchImpl('/api/products/image-drafts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }), signal: controller.signal,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '读取商品图片失败');
    return result;
  } catch (error) {
    if (timedOut) throw new Error('读取商品图片超时，请点击“重新读取图片”重试');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
