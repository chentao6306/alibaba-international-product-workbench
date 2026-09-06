export function runWithProgressTimeout(run, options = {}) {
  const timeoutMs = Math.max(10, Number(options.timeoutMs || 120000));
  let timer = null;
  let settled = false;
  let stage = String(options.initialStage || '准备处理');
  let rejectTimeout;

  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (settled) return;
      options.onTimeout?.(stage);
      const duration = timeoutMs < 60000
        ? `${Math.ceil(timeoutMs / 1000)} 秒`
        : `${Math.ceil(timeoutMs / 60000)} 分钟`;
      const error = new Error(`${stage}连续 ${duration} 没有进展，已停止当前商品；可稍后单独重试`);
      error.code = 'PUBLISH_STAGE_TIMEOUT';
      error.stage = stage;
      rejectTimeout(error);
    }, timeoutMs);
  };
  const progress = (nextStage) => {
    if (settled) return;
    stage = String(nextStage || stage);
    options.onProgress?.(stage);
    arm();
  };
  const timeout = new Promise((_, reject) => {
    rejectTimeout = reject;
    arm();
  });
  const operation = Promise.resolve().then(() => run(progress));
  operation.catch(() => {});
  return Promise.race([operation, timeout]).finally(() => {
    settled = true;
    clearTimeout(timer);
  });
}
