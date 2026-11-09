import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { clickPostingControl } from './posting-interaction.js';

// Bank dialogs can finish layout after their controls become visible. Keep
// normal actionability checks and dispatch once; do not force or replay writes.
const clickBankControl = (page, target) => clickPostingControl(page, target, { timeout: 15000 });
const videoNameInput = page => page.getByPlaceholder(/^(?:Video name|(?:请输入)?视频名称)\s*$/i);

const failure = message => Object.assign(new Error(`商品视频未完成：${message}`), { code: 'PUBLISH_VIDEO_BANK_PENDING' });
export function videoAssociationProblem(text) {
  const limit = String(text || '').match(/Only the video duration within\s*(\d+)\s*seconds? can be related to the product as the main image video/i)?.[1];
  return limit ? Object.assign(new Error(`平台要求主图视频时长不超过 ${limit} 秒，当前视频超出限制；请更换符合要求的视频后重试关联`), {
    code: 'PUBLISH_VIDEO_DURATION_LIMIT',
  }) : null;
}
const waitUntil = async (page, check, timeout = 30000) => {
  const end = Date.now() + timeout;
  do { const value = await check(); if (value) return value; await page.waitForTimeout(500); } while (Date.now() < end);
  throw failure('平台尚未返回确认结果，请稍后重试视频关联');
};
const writeReceipt = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file);
};

async function openBankDocument(page, url, ready) {
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await ready();
      return;
    } catch (error) {
      // Only retry reading a document. Upload and association clicks are never
      // replayed because their server result may already exist.
      if (attempt || !/Timeout|net::ERR_/i.test(error.message)
        || /login|passport|captcha|verify/i.test(page.url())) throw error;
    }
  }
}

export async function videoContentName(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return `copyfast-${hash.digest('hex').slice(0, 32)}`;
}

export async function waitForBankVideoReady(page, name, timeout = 120000) {
  await waitUntil(page, async () => {
    if (await page.locator('#videoName').inputValue().catch(() => '') !== name) return false;
    const complete = page.locator('.upload-common.upload-complete img');
    if (await complete.count() !== 1) return false;
    if (!await complete.evaluate(image => /^https:\/\//.test(image.src) && image.complete && image.naturalWidth > 0)) return false;
    return page.locator('.upload-common.upload-cover img').evaluateAll(images => images.length > 0
      && images.every(image => image.complete && image.naturalWidth > 0));
  }, timeout);
}

async function bankRow(page, name) {
  await videoNameInput(page).waitFor({ timeout: 30000 });
  await videoNameInput(page).fill(name);
  await clickBankControl(page, page.locator('button').filter({ hasText: /^(?:Search|搜索)$/i }));
  await page.waitForTimeout(400);
  await page.locator('.next-loading.next-open').waitFor({ state: 'hidden', timeout: 30000 });
  const titles = page.locator('.list-item-name');
  const indices = await titles.evaluateAll((nodes, wanted) => nodes.flatMap((node, index) => node.getAttribute('title') === wanted ? [index] : []), name);
  if (indices.length > 1) throw failure('视频银行存在重复名称，无法唯一确认视频');
  return indices.length ? titles.nth(indices[0]).locator('xpath=ancestor::tr[1]') : null;
}

export async function videoBankRecord(row) {
  const text = await row.innerText();
  const id = text.match(/VID\s*[:：]\s*(\d+)/i)?.[1];
  if (!id) throw failure('视频银行缺少视频编号');
  if (await row.locator('.list-item-status-rejected, .list-item-status-failed, .list-item-auditStatus-rejected').count()
    || /(?:^|\n)(?:Rejected|审核不通过|审核失败)(?:\n|$)/i.test(text)) throw failure('视频被平台审核拒绝，请更换视频');
  return { id, review: await row.locator('.list-item-status-approved').count() ? 'approved' : 'pending' };
}

export async function prepareBankVideo(page, file, directory, popupUrl) {
  const name = `${await videoContentName(file)}.mp4`;
  const bank = await page.context().newPage();
  let upload, stagedFile;
  try {
    // The publishing form advertises this bank entry even for accounts without
    // an inline uploader. Follow its management link instead of altering flags.
    const entry = new URL(popupUrl, 'https://hz-productposting.alibaba.com');
    if (entry.protocol !== 'https:' || entry.hostname !== 'hz-productposting.alibaba.com' || entry.pathname !== '/product/videobank/popSelect.htm') throw failure('视频银行入口无效');
    const link = bank.getByRole('link', { name: /^(?:Manage videos|管理视频)$/i });
    await openBankDocument(bank, entry.href, () => link.waitFor({ timeout: 20000 }));
    const home = new URL(await link.getAttribute('href'), bank.url());
    if (home.origin !== entry.origin || home.pathname !== '/product/videobank/home.htm') throw failure('视频银行管理链接无效');
    await openBankDocument(bank, home.href, () => videoNameInput(bank).waitFor({ timeout: 20000 }));
    // The bank is scoped to the signed-in seller. Never share pending receipts
    // between accounts which happen to upload identical video bytes.
    const cookies = await page.context().cookies('https://www.alibaba.com');
    const identities = cookies.filter(cookie => cookie.name === 'xman_us_t').map(cookie => new URLSearchParams(cookie.value))
      .filter(value => value.get('sign') === 'y').map(value => value.get('x_lid')?.trim().toLowerCase()).filter(Boolean);
    const identity = identities.length && new Set(identities).size === 1 ? identities[0] : '';
    if (!identity) throw failure('无法核对视频银行账号');
    const account = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
    const receiptFile = path.join(directory, `${account}-${name}.json`);
    let row = await bankRow(bank, name);
    if (!row) {
      let pending;
      try { pending = JSON.parse(fs.readFileSync(receiptFile)); } catch { /* No earlier submission. */ }
      if (pending) throw failure('此前视频上传回执待确认，已避免重复上传；请在视频银行核对');
      const opened = bank.waitForEvent('popup', { timeout: 20000 });
      await clickBankControl(bank, bank.getByRole('button', { name: /^(?:Upload Video|上传视频)$/i }));
      upload = await opened;
      await upload.locator('#icbu-uploader-input').waitFor({ state: 'attached', timeout: 30000 });
      // The platform assigns the filename again when transcoding finishes.
      // Give it the same stable name from the beginning, before editing fields.
      stagedFile = path.join(directory, account, name);
      fs.mkdirSync(path.dirname(stagedFile), { recursive: true });
      fs.copyFileSync(file, stagedFile);
      await upload.locator('#icbu-uploader-input').setInputFiles(stagedFile);
      await upload.locator('#videoName').waitFor({ timeout: 120000 });
      await upload.locator('#icbu-uploader-input').waitFor({ state: 'detached', timeout: 120000 });
      await waitForBankVideoReady(upload, name);
      // The bank requires a content tag even though Submit is already enabled.
      await clickBankControl(upload, upload.getByText(/^(?:Product Display|产品展示|商品展示)$/).first());
      await upload.getByText(/^(?:Selected\s+1\s+tags|已选(?:择)?\s*1\s*个?\s*标签)$/i).waitFor({ timeout: 15000 });
      const submit = upload.getByRole('button', { name: /^(?:Submit|提交)$/i });
      await waitUntil(upload, async () => await submit.isVisible() && !await submit.isDisabled(), 120000);
      // Record intent before clicking. A lost response must never cause an
      // automatic second upload on the next publish attempt.
      writeReceipt(receiptFile, { name, state: 'submitting', time: new Date().toISOString() });
      await clickBankControl(upload, submit);
      await upload.getByText(/^(?:Video submission successful|视频提交成功)$/i).first().waitFor({ timeout: 60000 });
      row = await waitUntil(bank, () => bankRow(bank, name), 30000);
    }
    const record = { ...await videoBankRecord(row), name, bankUrl: home.href };
    writeReceipt(receiptFile, { ...record, state: 'uploaded', time: new Date().toISOString() });
    return record;
  } finally {
    await upload?.close().catch(() => {}); await bank.close().catch(() => {});
    if (stagedFile) fs.rmSync(stagedFile, { force: true });
  }
}

export async function bankVideoAssociation(page, video, productId, { signal } = {}) {
  if (!/^\d+$/.test(String(video.id)) || !/^\d+$/.test(String(productId))) throw failure('视频或商品编号无效');
  const role = video.role || 'main';
  if (!['main', 'detail'].includes(role)) throw failure('视频展示位置无效');
  const bank = await page.context().newPage();
  const linked = await page.context().newPage();
  const close = () => { void bank.close().catch(() => {}); void linked.close().catch(() => {}); };
  signal?.addEventListener('abort', close, { once: true });
  try {
    if (signal?.aborted) throw failure('视频关联等待超时，商品发布结果已保留');
    const bankUrl = new URL(video.bankUrl);
    if (bankUrl.origin !== 'https://hz-productposting.alibaba.com' || bankUrl.pathname !== '/product/videobank/home.htm') throw failure('视频银行地址无效');
    const linkedUrl = new URL(`linked_products.htm?videoId=${video.id}`, bankUrl).href;
    const check = async () => {
      await openBankDocument(linked, linkedUrl, () => linked.locator('table').waitFor({ state: 'attached', timeout: 20000 }));
      await linked.locator('.next-loading.next-open').waitFor({ state: 'hidden', timeout: 20000 });
      await waitUntil(linked, async () => await linked.locator('tbody tr a[href*=".html"]').count() > 0
        || await linked.getByText(/^(?:No linked products!|暂无关联产品[！!]?|没有关联产品[！!]?)$/).isVisible().catch(() => false), 20000);
      const rows = linked.locator('tbody tr').filter({ has: linked.locator(`a[href*="_${productId}.html"]`) });
      const cells = await rows.evaluateAll(nodes => nodes.map(row => {
        const table = row.closest('.next-table') || row.closest('table');
        const headers = [...table.querySelectorAll('thead th')];
        const index = headers.findIndex(node => /^(?:Display status|展示状态|显示状态)$/i.test(node.textContent.trim()));
        return index >= 0 ? row.cells[index]?.innerText || '' : '';
      }));
      const expected = role === 'main' ? /^(?:Primary video|主图视频)$/i : /^(?:Details? video|Video for product details?|Product details(?: video)?|详情视频|详情页视频|描述视频)$/i;
      return cells.some(value => value.split(/[\n\r,，;；]+/).some(label => expected.test(label.trim())));
    };
    if (await check()) return { ...video, productId: String(productId), associated: true, alreadyAssociated: true };
    await openBankDocument(bank, bankUrl.href, () => videoNameInput(bank).waitFor({ timeout: 20000 }));
    const row = await bankRow(bank, video.name);
    const record = row && await videoBankRecord(row);
    if (!record || record.id !== String(video.id)) throw failure('视频编号和名称不一致');
    if (record.review !== 'approved') throw failure('视频仍在平台审核中，审核通过后可从任务历史完成视频关联');
    // The bank renders this action as a link on some accounts and a button on
    // others. Keep it scoped to the verified video and exclude the details action.
    const action = role === 'main' ? /^(?:Relate Product|关联产品主图|关联产品|关联商品)$/i : /^(?:Relate Product Details|关联产品详情|关联详情)$/i;
    await clickBankControl(bank, row.getByText(action).filter({ visible: true }));
    const iframe = bank.locator('.icbu-product-select iframe');
    await waitUntil(bank, async () => {
      const problem = videoAssociationProblem(await bank.locator('body').innerText());
      if (problem) throw problem;
      return iframe.isVisible();
    }, 15000);
    const frame = await iframe.elementHandle().then(node => node.contentFrame());
    if (!frame) throw failure('商品选择器未加载');
    const card = frame.locator(`a[href*="_${productId}.html"]`).locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " popup-item ") or self::td][1]');
    const exactCardVisible = async () => {
      if (await card.count() > 1) throw failure('商品选择器无法唯一确认目标商品');
      return card.isVisible();
    };
    // The picker can already display this exact listing while its advanced
    // search controls are hidden or absent. Selection still requires the
    // matching numeric checkbox below; never use the first/default product.
    if (!await exactCardVisible()) {
      const advanced = frame.getByRole('button', { name: /^(?:Advanced Search|高级搜索)$/i });
      await waitUntil(bank, async () => await exactCardVisible()
        || await frame.locator('input#productId').isVisible() || await advanced.isVisible(), 30000);
      if (!await exactCardVisible()) {
        if (!await frame.locator('input#productId').isVisible()) {
          try { await clickBankControl(bank, advanced); }
          catch (error) { if (!await frame.locator('input#productId').isVisible()) throw error; }
        }
        await frame.locator('input#productId').waitFor({ timeout: 20000 });
        await frame.locator('input#productId').fill(String(productId));
        const videoFilter = frame.locator('#isVideo').locator('xpath=ancestor::span[contains(@class,"next-select-single")][1]');
        if (await videoFilter.count() && !/^(?:All|全部)$/.test((await videoFilter.locator('em').innerText()).trim())) {
          await clickBankControl(bank, videoFilter);
          await clickBankControl(bank, frame.locator('[role="option"]:visible, .next-menu-item:visible').filter({ hasText: /^(?:All|全部)$/ }));
        }
        await clickBankControl(bank, frame.locator('button').filter({ hasText: /^(?:Search|搜索)$/i }));
      }
    }
    const input = frame.locator(`input[type="checkbox"][value="${productId}"]`);
    // Some bank pickers mount the checkbox only while the product image is
    // hovered. Locate the card through its exact public product link first;
    // waiting for the input before hovering deadlocks that picker variant.
    if (!await input.count()) {
      // The current picker uses a div grid; earlier layouts used table cells.
      // Bind either layout to the exact product link, never the first image.
      await card.waitFor({ state: 'visible', timeout: 20000 });
      if (await card.count() !== 1) throw failure('商品选择器无法唯一确认目标商品');
      const image = card.locator('.popup-item-img-wrapper');
      if (await image.count() !== 1) throw failure('商品选择器未找到唯一的目标商品图片');
      await image.hover();
    }
    await input.waitFor({ state: 'attached', timeout: 20000 });
    const wrapper = input.locator('xpath=ancestor::div[contains(@class,"popup-item-img-wrapper")][1]');
    await wrapper.hover();
    if (!await input.isChecked()) await clickBankControl(bank, input.locator('xpath=ancestor::label[1]'));
    if (!await input.isChecked()) throw failure('目标商品未勾选');
    if (await frame.locator('input[type="checkbox"]:checked').count() !== 1) throw failure('关联选择包含其他商品，已停止');
    await clickBankControl(bank, frame.locator('button#confirm'));
    await iframe.waitFor({ state: 'hidden', timeout: 30000 });
    await waitUntil(linked, check, 45000);
    return { ...video, productId: String(productId), associated: true };
  } finally { signal?.removeEventListener('abort', close); await bank.close().catch(() => {}); await linked.close().catch(() => {}); }
}

export async function completePublishedVideo(page, video, publicationUrl, associate = bankVideoAssociation, { timeoutMs = 90000 } = {}) {
  let productId, timer;
  const controller = new AbortController();
  try {
    productId = new URL(publicationUrl).searchParams.get('primaryId');
    return await Promise.race([
      associate(page, video, productId, { signal: controller.signal }),
      new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(failure('视频关联等待超时，请从任务历史继续处理'));
      }, timeoutMs); }),
    ]);
  }
  catch (error) {
    // The listing already exists. Preserve success and an actionable receipt;
    // never turn an optional association failure into a duplicate publication.
    return { ...video, productId, associated: false, warning: `商品已发布，视频关联待完成：${error.message}` };
  }
  finally { clearTimeout(timer); controller.abort(); }
}
