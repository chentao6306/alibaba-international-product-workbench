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
