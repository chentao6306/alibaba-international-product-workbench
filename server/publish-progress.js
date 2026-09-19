// Job progress is authoritative during an attempt. Keep the previous product
// receipt intact for history, but never show it as the current task's failure.
export function productPublishDisplay(product, jobs = []) {
  const active = jobs.filter((job) => job.type === 'publish'
    && ['queued', 'running', 'pause_requested', 'paused'].includes(job.status))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  for (const job of active) {
    const ids = job.metadata?.productIds || [];
    const index = ids.indexOf(product.id);
    const progress = Number(job.progress || 0);
    if (index < progress || index < 0 || job.results?.[product.id]) continue;
    const currentId = job.currentProductId || ids[progress];
    const current = currentId === product.id && job.status !== 'queued';
    if (!current) return {
      status: 'publish_queued', message: job.status === 'paused' ? '任务已暂停，此商品尚未处理' : '已加入当前任务，等待处理', jobId: job.id,
    };
    const prefix = `${job.status === 'paused' ? '已暂停：' : `正在处理 ${progress + 1}/${job.total}：`}${product.title} - `;
    const message = String(job.message || '');
    return {
      status: job.status === 'paused' ? 'publish_paused' : job.status === 'pause_requested' ? 'publish_pausing' : 'publishing',
      message: message.startsWith(prefix) ? message.slice(prefix.length) : message || (job.status === 'paused' ? '任务已暂停，处理后可继续' : '正在处理当前商品'),
      jobId: job.id,
    };
  }
  return { status: product.status, message: product.publishResult?.message || '' };
}

export function publishCounts(job) {
  const results = Object.values(job.results || {});
  const success = results.filter((result) => ['published', 'drafted'].includes(result.status)).length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const skipped = results.filter((result) => result.status === 'skipped').length;
  return { success, failed, skipped, remaining: Math.max(0, Number(job.total || 0) - Number(job.progress || 0)) };
}

export function recordPublishOutcome(state, jobId, productId, result, progress) {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) return;
  job.results = { ...job.results, [productId]: { status: result.status, message: result.message || '' } };
  job.progress = progress;
  job.updatedAt = new Date().toISOString();
}
