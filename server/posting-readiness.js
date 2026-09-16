export function postingPageProblem(url, text = '') {
  let login = false;
  try {
    const parsed = new URL(url);
    login = /(?:^|[./-])(?:login|passport|signin|sign-in)(?:[./-]|$)/i.test(parsed.hostname + parsed.pathname);
  } catch {}
  if (login) return Object.assign(new Error('阿里巴巴国际站登录状态已失效，请在卖家窗口重新登录后继续任务'), { code: 'LOGIN_REQUIRED' });
  if (/The category does not exist or has become invalid|类目(?:不存在|已失效|已经失效)|该类目已删除/i.test(text)) {
    return Object.assign(new Error('国际站已停用或无法使用当前类目，请重新选择有效目标类目或引用适用的成功商品后重试'), { code: 'PUBLISH_CATEGORY_INVALID' });
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
    if (await body.isVisible().catch(() => false)) return { frame, body };
  }
  return null;
}

export async function waitForDescriptionEditor(page, { switchMode, verify, onProgress = () => {}, timeoutMs = 45000 } = {}) {
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
      onProgress('等待国际站详情编辑器加载');
      nextReport = performance.now() + 8000;
    }
    await page.waitForTimeout(300);
  }
  await requirePostingPageAvailable(page);
  const found = await findDescriptionEditor(page);
  if (found) return found;
  throw Object.assign(new Error('国际站详情编辑器加载超时，可能是页面脚本未加载或编辑器界面变化；已保留商品，可重试'), { code: 'PUBLISH_EDITOR_NOT_READY' });
}
