// Commercial product data is useful for reproducing publishing failures. Keep
// it separate from browser/session data and never accept arbitrary local files.
const SECRET_KEY = /password|passwd|cookie|authorization|activation.?code|access.?token|refresh.?token|api.?key|private.?key|(?:^|[_-])token(?:$|[_-])|credential|secret|session|密钥|密码|授权码/i;
export function diagnosticText(value, limit = 12000) {
  // Read a small suffix before cutting so a credential crossing the output
  // boundary is redacted as a whole instead of leaking its first characters.
  return String(value ?? '').slice(0, limit + 1024)
    .replace(/\bCDK-[\w-]+/gi, '[REDACTED]')
    .replace(/\bsk-[a-zA-Z0-9_-]{16,}\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/((?:password|passwd|cookie|authorization|access_token|refresh_token|api[_ -]?key|secret|token|密码|授权码|密钥)\s*[=:：]\s*)[^\r\n<]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|sign|signature|auth|key|secret|session|access_token|refresh_token)=)[^&#\s"'<>]*/gi, '$1[REDACTED]').slice(0, limit);
}

const timelineStages = new Set(['video', 'description', 'packaging', 'images', 'pricing', 'specifications', 'attributes', 'category', 'language', 'submit', 'save-draft', 'verification', 'login', 'collection', 'startup', 'publishing', 'workspace', 'reference', 'settings', 'storage', 'diagnostics', 'unknown']);
const duration = value => Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), 7 * 86400000) : 0;

export function sanitizeDiagnosticTimeline(input = {}) {
  input = input && typeof input === 'object' ? input : {};
  const entries = Array.isArray(input.entries) ? input.entries : [];
  return { totalMs: duration(input.totalMs), entries: entries.slice(0, 120).map(entry => ({
    stage: timelineStages.has(entry?.stage) ? entry.stage : 'unknown',
    startedMs: duration(entry?.startedMs), durationMs: duration(entry?.durationMs),
    outcome: ['completed', 'failed', 'active', 'waiting'].includes(entry?.outcome) ? entry.outcome : 'active',
  })), truncated: input.truncated === true || entries.length > 120 };
}

export function diagnosticData(value, { budget = 250000 } = {}) {
  let remaining = budget;
  let truncated = false;
  const visit = (item, depth = 0) => {
    if (remaining <= 0 || depth > 10) { truncated = true; return '[TRUNCATED]'; }
    if (typeof item === 'string') {
      const limit = Math.min(remaining, 180000);
      if (item.length > limit) truncated = true;
      const result = diagnosticText(item, limit); remaining -= result.length; return result;
    }
    if (item == null || typeof item === 'boolean' || typeof item === 'number') { remaining -= 8; return item; }
    if (Array.isArray(item)) {
      if (item.length > 2000) truncated = true;
      return item.slice(0, 2000).map(child => visit(child, depth + 1));
    }
    if (typeof item !== 'object') return '';
    const result = {};
    const keys = Object.keys(item).filter(key => !SECRET_KEY.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key));
    if (keys.length > 500) truncated = true;
    for (const key of keys.slice(0, 500)) { remaining -= key.length; result[key.slice(0, 200)] = visit(item[key], depth + 1); }
    return result;
  };
  return { value: visit(value), truncated };
}

export function diagnosticProduct(product = {}) {
  const fields = ['id', 'sourceId', 'sourceUrl', 'sourcePlatform', 'sourceCategoryId', 'sourceCategoryPath', 'categoryId', 'categoryPath',
    'title', 'subtitle', 'keywords', 'description', 'descriptionHtml', 'structuredDescription', 'descriptionTemplate',
    'attributes', 'customAttributes', 'variantGroups', 'skus', 'specifications', 'price', 'maxPrice', 'priceMode', 'priceTiers',
    'sourcePrice', 'sourcePriceTiers', 'sourcePriceRange', 'currencySymbol', 'stock', 'minOrder', 'mainImage', 'mainImages', 'images', 'detailImages',
    'videoUrl', 'videos', 'modelImages', 'colorImages', 'packaging', 'deliveryTime', 'shipping', 'salesUnit', 'logisticsAttributes',
    'freightTemplate', 'origin', 'province', 'brand', 'model', 'services', 'certificates', 'postingRequirements', 'dataCompleteness', 'collectedDetailAt'];
  return diagnosticData(Object.fromEntries(fields.filter(key => Object.hasOwn(product || {}, key)).map(key => [key, product[key]])));
}

export function sanitizeDiagnosticFailure(input = {}) {
  input ||= {};
  const product = diagnosticProduct(input.product);
  const source = diagnosticProduct(input.source);
  const page = diagnosticData(input.page || {}, { budget: 90000 });
  const error = diagnosticData(input.error || {}, { budget: 24000 });
  const screenshots = (Array.isArray(input.screenshots) ? input.screenshots : []).slice(0, 3).flatMap(item => {
    if (!item || !/^[A-Za-z0-9+/=]+$/.test(item.data || '') || !item.data.startsWith('/9j/') || item.data.length > 1600000) return [];
    return [{ label: diagnosticText(item.label, 80), type: 'image/jpeg', data: item.data }];
  });
  const timeline = input.timeline ? sanitizeDiagnosticTimeline(input.timeline) : undefined;
  const truncation = Object.fromEntries(Object.entries({ product: product.truncated, source: source.truncated, page: page.truncated, error: error.truncated,
    timeline: timeline?.truncated === true, screenshots: screenshots.length < (Array.isArray(input.screenshots) ? input.screenshots.length : 0) })
    .map(([key, value]) => [key, value || input.truncation?.[key] === true]));
  return { id: /^[a-f0-9-]{36}$/i.test(input.id || '') ? input.id : '', at: diagnosticText(input.at, 40), stage: diagnosticText(input.stage, 500),
    mode: ['draft', 'submit'].includes(input.mode) ? input.mode : '', elapsedMs: duration(input.elapsedMs),
    ...(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.attemptId || '') ? { attemptId: input.attemptId.toLowerCase() } : {}),
    ...(input.targetCategoryId !== undefined ? { targetCategoryId: /^\d{1,30}$/.test(String(input.targetCategoryId)) ? String(input.targetCategoryId) : '' } : {}),
    ...(['rules', 'assisted'].includes(input.processingMode) ? { processingMode: input.processingMode } : {}),
    ...(timeline ? { timeline } : {}),
    product: product.value, source: source.value, page: page.value, error: error.value, screenshots,
    truncated: input.truncated === true || Object.values(truncation).some(Boolean), truncation,
    captureError: diagnosticText(input.captureError, 300) };
}
