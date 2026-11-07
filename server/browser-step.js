export function browserStep(action, { timeoutMs = 15000, signal, label = '连接发布浏览器', onLateResolve } = {}) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(Object.assign(new Error('已暂停当前商品操作'), { code: 'PUBLISH_PAUSED' }));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(Object.assign(new Error(`${label}超时，已保留当前商品和任务进度，请稍后继续`),
      { code: 'PUBLISH_BROWSER_NOT_READY' })), timeoutMs);
    Promise.resolve().then(() => {
      if (finished) return;
      return action();
    }).then((value) => {
      if (finished) Promise.resolve().then(() => onLateResolve?.(value)).catch(() => {});
      else finish(null, value);
    }, (error) => finish(error));
  });
}
