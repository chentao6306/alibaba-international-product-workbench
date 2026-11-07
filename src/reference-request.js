import { localFetch } from './local-api.js';

export async function referenceRequest(url, body, { signal, timeoutMs = 60000, fetchImpl = localFetch } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const saving = url === '/api/products/reference';
  try {
    const response = await fetchImpl(url, { signal: controller.signal, ...(body ? {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    } : {}) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || data.message || '引用资料请求失败'), { status: response.status });
    return data;
  } catch (error) {
    if (timedOut) throw new Error(saving
      ? '保存响应超时，结果尚未确认；请关闭窗口刷新商品核对后再预览，勿重复保存。'
      : '读取引用预览或商品资料超时，尚未保存修改，请稍后重新读取。');
    if (signal?.aborted) throw error;
    if (saving && (!error.status || error.status >= 500)) throw new Error('保存结果尚未确认；请关闭窗口刷新商品核对后再预览。' + error.message);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
