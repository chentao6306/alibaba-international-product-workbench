export const BATCH_SIZE = 100;

export function chunks(items, size = BATCH_SIZE) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
}

// Keep a bounded number of requests active. An individual failure never discards
// successful previews; callers retain the exact target for a selective retry.
export async function processImageTargets(targets, process, onProgress = () => {}) {
  const cache = new Map(), results = new Array(targets.length);
  let cursor = 0, completed = 0, lastProgress = 0;
  async function worker() {
    while (cursor < targets.length) {
      const index = cursor++, target = targets[index];
      try {
        if (!cache.has(target.url)) cache.set(target.url, Promise.resolve().then(() => process(target)));
        results[index] = { target, result: await cache.get(target.url) };
      } catch (error) { results[index] = { target, error: error.message || '图片处理失败' }; }
      completed++;
      if (completed === targets.length || Date.now() - lastProgress >= 150) {
        lastProgress = Date.now(); onProgress(completed, targets.length);
      }
    }
  }
  await Promise.all([worker(), worker()]);
  return results;
}

export function sameImages(a, b) {
  return ['mainImages', 'detailImages'].every((key) => a[key].length === b[key].length && a[key].every((url, i) => url === b[key][i]));
}
