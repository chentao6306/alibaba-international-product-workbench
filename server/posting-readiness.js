import { browserResourcePolicy } from './browser-resource-policy.js';

const DESCRIPTION_HEADING = /^\*?\s*(?:商品详情|商品描述|(?:Product|Commodity)\s*(?:description|details))\s*\*?$/i;
const NORMAL_DESCRIPTION_MODE = /^(?:普通编辑|普通编辑器|(?:Normal|Ordinary|Regular|Basic|Standard)\s*edit(?:or|ing)?)$/i;
const DESCRIPTION_ANCHORS = [
  '.posting-field-supertext .supertext-header',
  '#desc-card-title',
  '#struct-productDescType',
  '#struct-superText',
  '#struct-desc-card',
];

async function visibleDescriptionControl(candidates) {
  for (const candidate of candidates) {
    for (let index = 0, count = await candidate.count(); index < count; index++) {
      const control = candidate.nth(index);
      if (await control.isVisible().catch(() => false)) return control;
    }
  }
  return null;
}

export async function revealDescriptionSection(page) {
  // Alibaba initializes this editor only near the viewport. Its English
  // heading is "Commodity Details", and controls may not exist until scrolling.
  const section = await visibleDescriptionControl([
    ...DESCRIPTION_ANCHORS.map(selector => page.locator(selector)),
    page.getByRole('heading', { name: DESCRIPTION_HEADING }),
  ]);
  if (!section) return false;
  return section.scrollIntoViewIfNeeded({ timeout: 1500 }).then(() => true).catch(() => false);
}

export async function findNormalDescriptionControl(page) {
  return visibleDescriptionControl([
    page.locator('#struct-productDescType').getByText(NORMAL_DESCRIPTION_MODE),
    page.getByText(NORMAL_DESCRIPTION_MODE),
  ]);
}

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
    const title = await findPostingTitle(page);
    if (title) return title;
    await requirePostingPageAvailable(page, { beforeForm: true });
    if (performance.now() >= nextReport) {
      onProgress(`等待国际站商品表单加载（已等待 ${Math.max(0, Math.floor((timeoutMs - deadline + performance.now()) / 1000))} 秒）`);
      const started = performance.now();
      await verify?.();
      deadline += performance.now() - started;
      nextReport = performance.now() + 5000;
    }
    await page.waitForTimeout(pollIntervalMs);
  }
  const title = await findPostingTitle(page);
  if (title) return title;
  await requirePostingPageAvailable(page, { beforeForm: true });
  throw Object.assign(new Error('国际站商品表单加载超时，未找到可编辑的商品名称；已保留商品和任务进度'), { code: 'PUBLISH_FORM_NOT_READY' });
}

export function postingPageProblem(url, text = '', { beforeForm = false } = {}) {
  let login = false;
  try {
    const parsed = new URL(url);
    login = /(?:^|[./-])(?:login|passport|signin|sign-in)(?:[./-]|$)/i.test(parsed.hostname + parsed.pathname);
  } catch {}
  if (login) return Object.assign(new Error('阿里巴巴国际站登录状态已失效，请在卖家窗口重新登录后继续任务'), { code: 'LOGIN_REQUIRED' });
  if (beforeForm && /(?:^|[\r\n])\s*(?:记录不存在|(?:该)?商品不存在|(?:the\s+)?(?:record|product)\s+(?:does not exist|not found)[.!]?)\s*(?:$|[\r\n])/i.test(text)) {
    return Object.assign(new Error('国际站返回商品或草稿记录不存在，请核对当前账号和商品入口；未重新创建或重复提交商品'), { code: 'PUBLISH_RECORD_UNAVAILABLE' });
  }
  if (/类目不是(?:叶子|末级)类目|category\s+is\s+not\s+(?:a\s+)?leaf(?:\s+category)?/i.test(text)) {
    return Object.assign(new Error('当前选择的是上级类目，请在商品编辑中选择具体的末级类目后重试'), { code: 'PUBLISH_CATEGORY_NOT_LEAF' });
  }
  if (/(?:该|当前商品)?类目不在线上经营类目范围内|(?:category|categorization).{0,100}(?:not within|outside).{0,50}(?:business|operating) categor/i.test(text)) {
    return Object.assign(new Error('当前卖家账号未开通该商品的经营类目；请在国际站“店铺管理 → 管理公司信息”核对经营类目后重试'), { code: 'PUBLISH_CATEGORY_NOT_AUTHORIZED' });
  }
  if (/The category does not exist or has become invalid|类目(?:不存在|已失效|已经失效)|该类目已删除/i.test(text)) {
    let categoryId = '';
    try { categoryId = new URL(url).searchParams.get('catId') || ''; } catch {}
    if (!/^[1-9]\d{0,11}$/.test(categoryId)) categoryId = '';
    return Object.assign(new Error(`国际站已停用或无法使用当前类目${categoryId ? `（ID ${categoryId}）` : ''}，请重新选择有效目标类目或引用适用的成功商品后继续`), { code: 'PUBLISH_CATEGORY_INVALID', categoryId });
  }
  return null;
}

export async function requirePostingPageAvailable(page, options = {}) {
  const text = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
  const problem = postingPageProblem(page.url(), text, options);
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

export async function descriptionEditorState(page) {
  return page.evaluate(({ anchors, headingPattern, modePattern }) => {
    const visible = (node) => {
      const rect = node?.getBoundingClientRect();
      return Boolean(rect?.width && rect?.height && getComputedStyle(node).visibility !== 'hidden');
    };
    const modeRegex = new RegExp(modePattern, 'i');
    const headingRegex = new RegExp(headingPattern, 'i');
    const modes = [...document.querySelectorAll('label, [role=tab], button, .item-label')]
      .filter((node) => visible(node) && modeRegex.test(node.textContent?.trim()));
    const mode = modes.find(node => node.closest('#struct-productDescType')) || modes[0];
    const section = anchors.flatMap(selector => [...document.querySelectorAll(selector)]).find(visible)
      || [...document.querySelectorAll('h1,h2,h3,h4,[role=heading]')].find(node => visible(node) && headingRegex.test(node.textContent?.trim()));
    const rect = section?.getBoundingClientRect();
    const radio = (mode?.closest('.icbuRadio-item') || mode)?.querySelector('input[type=radio]');
    const frames = [...document.querySelectorAll('iframe')].filter((node) => /(?:_ifr$|description|editor)/i.test(node.id)
      || node.closest('.mce-edit-area'));
    return { detailSectionFound: Boolean(section), detailSectionInView: Boolean(rect && rect.bottom > 0 && rect.top < innerHeight),
      modeControl: Boolean(mode), normalSelected: radio ? radio.checked : null,
      editorFrames: frames.length, visibleEditorFrames: frames.filter(visible).length,
      editorScriptLoaded: Boolean(window.tinymce || window.tinyMCE), documentState: document.readyState };
  }, { anchors: DESCRIPTION_ANCHORS, headingPattern: DESCRIPTION_HEADING.source, modePattern: NORMAL_DESCRIPTION_MODE.source })
    .catch(() => ({ documentState: 'unavailable' }));
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
      const state = await descriptionEditorState(page);
      const stage = state.editorFrames ? '等待国际站详情编辑区域就绪'
        : state.detailSectionFound ? '详情区已定位，等待国际站编辑器初始化'
          : state.modeControl ? '等待国际站详情编辑器加载' : '正在定位国际站详情区';
      onProgress(`${stage}（已等待 ${Math.max(0, Math.floor((timeoutMs - deadline + performance.now()) / 1000))} 秒）`);
      nextReport = performance.now() + 8000;
    }
    await page.waitForTimeout(pollIntervalMs);
  }
  await requirePostingPageAvailable(page);
  const found = await findDescriptionEditor(page);
  if (found) return found;
  const diagnostics = await descriptionEditorState(page);
  const reason = diagnostics.normalSelected === false ? '普通编辑模式未成功选中'
    : diagnostics.editorFrames ? '编辑器框架已出现，但编辑区域仍不可用'
      : diagnostics.modeControl ? '详情区已展开，但国际站仍未创建编辑器'
        : diagnostics.detailSectionFound ? '详情区已定位，但国际站仍未创建编辑器，请检查发布页面的加载状态'
          : '未找到详情区或普通编辑入口，请检查当前发布页面';
  throw Object.assign(new Error(`${reason}（已等待 ${Math.ceil(timeoutMs / 1000)} 秒）；已保留商品及任务进度，未提交当前商品`),
    { code: 'PUBLISH_EDITOR_NOT_READY', diagnostics });
}
