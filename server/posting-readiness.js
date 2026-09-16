import { browserResourcePolicy } from './browser-resource-policy.js';

export async function findPostingTitle(page) {
  const selectors = [
    'input[name="productTitle" i], textarea[name="productTitle" i]',
    'input[name="productName" i], textarea[name="productName" i]',
    'input[name="subject" i], textarea[name="subject" i]',
    '#struct-title input, #struct-title textarea, .posting-field-title input, .posting-field-title textarea',
    'input[placeholder*="商品标题"], textarea[placeholder*="商品标题"]',
    'input[placeholder*="product title" i], textarea[placeholder*="product title" i]',
    'input[placeholder*="product name" i], textarea[placeholder*="product name" i]',
    'input[placeholder*="enter a title" i], textarea[placeholder*="enter a title" i]',
    'input[name="title" i], textarea[name="title" i]',
    '[contenteditable="true"][aria-label="Product title" i], [contenteditable="true"][data-testid="product-title" i]'
  ];
  const candidates = selectors.map((selector) => page.locator(selector));
  candidates.push(page.getByRole('textbox', { name: /^\*?\s*(?:product name|product title|商品名称|商品标题)\s*[:：*]?$/i }));
  for (const candidate of candidates) {
    for (let index = 0, count = await candidate.count().catch(() => 0); index < count; index++) {
      const field = candidate.nth(index);
      if (await field.isVisible().catch(() => false) && await field.isEditable().catch(() => false)) return field;
    }
  }
  return null;
}

export async function waitForPostingTitle(page, { timeoutMs = browserResourcePolicy().readinessTimeoutMs, verify, onProgress = () => {} } = {}) {
  const pollIntervalMs = browserResourcePolicy().pollIntervalMs;
  let deadline = performance.now() + timeoutMs;
  let nextReport = 0;
  while (performance.now() < deadline) {
    await requirePostingPageAvailable(page);
    const title = await findPostingTitle(page);
    if (title) return title;
    if (performance.now() >= nextReport) {
      onProgress(`等待国际站商品表单加载（已等待 ${Math.max(0, Math.floor((timeoutMs - deadline + performance.now()) / 1000))} 秒）`);
      const started = performance.now();
      await verify?.();
      deadline += performance.now() - started;
      nextReport = performance.now() + 5000;
    }
    await page.waitForTimeout(pollIntervalMs);
  }
  await requirePostingPageAvailable(page);
  const title = await findPostingTitle(page);
  if (title) return title;
  throw Object.assign(new Error('国际站商品表单加载超时，未找到可编辑的商品名称；已保留商品和任务进度'), { code: 'PUBLISH_FORM_NOT_READY' });
}

export function postingPageProblem(url, text = '') {
  let login = false;
  try {
    const parsed = new URL(url);
    login = /(?:^|[./-])(?:login|passport|signin|sign-in)(?:[./-]|$)/i.test(parsed.hostname + parsed.pathname);
  } catch {}
  if (login) return Object.assign(new Error('阿里巴巴国际站登录状态已失效，请在卖家窗口重新登录后继续任务'), { code: 'LOGIN_REQUIRED' });
  if (/The category does not exist or has become invalid|类目(?:不存在|已失效|已经失效)|该类目已删除/i.test(text)) {
    let categoryId = '';
    try { categoryId = new URL(url).searchParams.get('catId') || ''; } catch {}
    if (!/^\d{4,}$/.test(categoryId)) categoryId = '';
    return Object.assign(new Error(`国际站已停用或无法使用当前类目${categoryId ? `（ID ${categoryId}）` : ''}，请重新选择有效目标类目或引用适用的成功商品后继续`), { code: 'PUBLISH_CATEGORY_INVALID', categoryId });
  }
  return null;
}

export async function requirePostingPageAvailable(page) {
  const text = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
  const problem = postingPageProblem(page.url(), text);
  if (problem) throw problem;
}

export async function findDescriptionEditor(page) {
  for (const frame of page.frames()) {
    // The main document can have unrelated contenteditable title/keyword
    // controls. Only accept a real TinyMCE body or an editable child frame.
    const selector = frame === page.mainFrame() ? 'body.mce-content-body' : 'body.mce-content-body, body[contenteditable="true"]';
    const body = frame.locator(selector).first();
    if (await body.isVisible().catch(() => false) && await body.isEditable().catch(() => false)) return { frame, body };
  }
  return null;
}

export async function waitForDescriptionEditor(page, { switchMode, verify, onProgress = () => {}, timeoutMs = browserResourcePolicy().readinessTimeoutMs } = {}) {
  const pollIntervalMs = browserResourcePolicy().pollIntervalMs;
  let deadline = performance.now() + timeoutMs;
  let nextSwitch = 0;
  let nextReport = 0;
  while (performance.now() < deadline) {
    await requirePostingPageAvailable(page);
    const found = await findDescriptionEditor(page);
    if (found) return found;
    if (performance.now() >= nextSwitch) {
      const verificationStarted = performance.now();
      await verify?.();
      // Human verification can take hours. Only ordinary page loading counts
      // against the editor timeout; the challenge retains its own lifecycle.
      deadline += performance.now() - verificationStarted;
      await switchMode?.();
      nextSwitch = performance.now() + 4000;
    }
    if (performance.now() >= nextReport) {
      onProgress(`等待国际站详情编辑器加载（已等待 ${Math.max(0, Math.floor((timeoutMs - deadline + performance.now()) / 1000))} 秒，加载完成后自动继续）`);
      nextReport = performance.now() + 8000;
    }
    await page.waitForTimeout(pollIntervalMs);
  }
  await requirePostingPageAvailable(page);
  const found = await findDescriptionEditor(page);
  if (found) return found;
  throw Object.assign(new Error(`国际站详情编辑器等待 ${Math.ceil(timeoutMs / 1000)} 秒后仍未就绪；请检查国际站页面和网络，已保留商品及任务进度，可继续重试`), { code: 'PUBLISH_EDITOR_NOT_READY' });
}
