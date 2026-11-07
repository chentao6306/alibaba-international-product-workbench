import os from 'node:os';

// Bounds are ceilings, not sleeps: a ready page proceeds immediately.
export function browserResourcePolicy({
  cpuCount = os.availableParallelism(), totalBytes = os.totalmem(), freeBytes = os.freemem()
} = {}) {
  const gib = 1024 ** 3;
  const constrained = cpuCount <= 2 || totalBytes <= 4.5 * gib || freeBytes < 0.75 * gib;
  return {
    constrained,
    readinessTimeoutMs: constrained ? 180000 : 90000,
    navigationTimeoutMs: constrained ? 90000 : 60000,
    pollIntervalMs: constrained ? 750 : 400,
    imageConcurrency: constrained ? 1 : 3,
    sourceFrameTimeoutMs: constrained ? 30000 : 15000
  };
}
