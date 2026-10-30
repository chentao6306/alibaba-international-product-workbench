export const MAX_PUBLISH_DELAY_SECONDS = 300;

export function normalizePublishDelayRange(minSeconds, maxSeconds) {
  const min = Math.max(0, Math.min(MAX_PUBLISH_DELAY_SECONDS, Number(minSeconds) || 0));
  const max = Math.max(min, Math.min(MAX_PUBLISH_DELAY_SECONDS, Number(maxSeconds) || min));
  return { minSeconds: min, maxSeconds: max };
}

export function randomPublishDelayMs(range, random = Math.random) {
  const normalized = normalizePublishDelayRange(range?.minSeconds, range?.maxSeconds);
  if (normalized.maxSeconds <= 0) return 0;
  const sample = Math.max(0, Math.min(0.999999999, Number(random()) || 0));
  return Math.round((normalized.minSeconds + (normalized.maxSeconds - normalized.minSeconds) * sample) * 1000);
}

export function publishDelayFromRequest(body = {}, fallback = {}) {
  const min = body.publishDelayMinSeconds ?? fallback.minSeconds ?? 0;
  const max = body.publishDelayMaxSeconds ?? fallback.maxSeconds ?? 0;
  const valid = (value) => ['number', 'string'].includes(typeof value) && String(value).trim() !== ''
    && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= MAX_PUBLISH_DELAY_SECONDS;
  if (!valid(min) || !valid(max) || Number(max) < Number(min)) {
    throw Object.assign(new Error('上架间隔须为 0 至 300 秒，最长时间不能小于最短时间'), { status: 400 });
  }
  return { minSeconds: Number(min), maxSeconds: Number(max) };
}

export async function waitForPublishDelay(range, { shouldStop, onWaiting, random = Math.random,
  now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const delay = randomPublishDelayMs(range, random);
  const deadline = now() + delay;
  let reported = -1;
  for (;;) {
    if (shouldStop()) return false;
    const remaining = Math.max(0, deadline - now());
    if (!remaining) return true;
    const seconds = Math.ceil(remaining / 1000);
    if (seconds !== reported) { onWaiting(seconds); reported = seconds; }
    await sleep(Math.min(250, remaining));
  }
}
