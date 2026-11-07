// Inspect a previously verified publication without submitting or editing it.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher } from '../server/publisher.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';
import { ensureSimplifiedChinese } from '../server/posting-language.js';
const root = process.env.QA_OUTPUT_DIR;
assert.ok(root && process.env.QA_VIDEO_REPORT && process.env.QA_EXPECTED_ACCOUNT);
fs.mkdirSync(root, { recursive: true });
const prior = JSON.parse(fs.readFileSync(process.env.QA_VIDEO_REPORT));
assert.ok(prior.association?.associated); assert.match(prior.productId, /^\d+$/);
const report = { productId: prior.productId, videoId: prior.video.id };
const cookie = path.join(root, 'alibaba-cookies.json');
writePrivateSession(cookie, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = cookie;
const publisher = new SellerPublisher(root);
const save = () => fs.writeFileSync(path.join(root, 'video-readback-inspect.json'), JSON.stringify(report, null, 2));
try {
  const page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  if (process.env.QA_BANK_CHINESE === '1') {
    await page.goto(`https://post.alibaba.com/product/publish.htm?itemId=${prior.productId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('input#productTitle').waitFor({ timeout: 60000 });
    await ensureSimplifiedChinese(page);
    await page.goto(prior.video.bankUrl + '?language=zh_CN', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('.list-item-name').first().waitFor({ timeout: 30000 });
    report.bank = await page.evaluate(() => ({ text: document.body.innerText.slice(0, 5000), inputs: [...document.querySelectorAll('input')].map(node => ({ id: node.id, name: node.name, placeholder: node.placeholder })),
      row: document.querySelector('.list-item-name')?.closest('tr')?.outerHTML }));
    save();
    const linked = await page.context().newPage();
    try {
      await linked.goto(`https://hz-productposting.alibaba.com/product/videobank/linked_products.htm?videoId=${prior.video.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await linked.locator('tbody tr a[href*=".html"]').first().waitFor({ timeout: 30000 });
      report.linkedText = await linked.locator('body').innerText(); save();
    } finally { await linked.close(); }
  }
  await page.goto(`https://post.alibaba.com/product/publish.htm?itemId=${prior.productId}&language=zh_CN`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('input#productTitle').waitFor({ timeout: 60000 });
  await page.waitForTimeout(3000);
  report.edit = await page.evaluate(id => {
    const found = [], seen = new Set();
    for (const node of document.querySelectorAll('[id], [class*="posting-field"], [class*="video" i]')) {
      let fiber = node[Object.keys(node).find(key => key.startsWith('__reactFiber'))];
      for (let depth = 0; fiber && depth < 10; depth++, fiber = fiber.return) {
        if (seen.has(fiber)) continue; seen.add(fiber);
        const props = fiber.memoizedProps;
        if (!props || typeof props !== 'object') continue;
        for (const key of Object.keys(props)) {
          if (['children', 'ref'].includes(key)) continue;
          let text; try { text = JSON.stringify(props[key]); } catch { continue; }
          if (!text || text.length > 3000000) continue;
          const matches = [...text.matchAll(new RegExp(`${id}|detailVideo|mainVideo|videoId|videoUrl`, 'gi'))].slice(0, 15);
          if (matches.length) found.push({ node: node.id || node.className, field: props.id || props.name, key,
            matches: matches.map(match => text.slice(Math.max(0, match.index - 120), match.index + 300)) });
        }
      }
    }
    return { found, media: [...document.querySelectorAll('video, iframe, embed')].map(node => ({ tag: node.tagName, src: node.src, id: node.id })) };
  }, prior.video.id); save();
  const source = await publisher.readSourceProduct(page, { sourcePlatform: 'alibaba.com', sourceId: prior.productId,
    sourceUrl: `https://www.alibaba.com/product-detail/product_${prior.productId}.html` });
  report.publicProduct = { title: source.title, videoUrl: source.videoUrl, videos: source.videos };
  report.publicDom = await page.evaluate(id => ({
    videos: [...document.querySelectorAll('video')].map(node => {
      const ancestors = []; let parent = node;
      for (let i = 0; parent && i < 9; i++, parent = parent.parentElement) ancestors.push({ tag: parent.tagName, id: parent.id,
        className: parent.className, module: parent.getAttribute('data-module-name'), testId: parent.getAttribute('data-testid') });
      return { src: node.currentSrc || node.src, ancestors };
    }),
    scripts: [...document.scripts].flatMap(node => {
      const text = node.textContent || '';
      const matches = [...text.matchAll(new RegExp(`${id}|detailVideo|mainVideo|videoId|videoUrl`, 'gi'))].slice(0, 25);
      return matches.map(match => text.slice(Math.max(0, match.index - 120), match.index + 300));
    }),
    frames: [...document.querySelectorAll('iframe')].map(node => ({ src: node.src, id: node.id })),
  }), prior.video.id); save();
} catch (error) { report.error = { message: error.message, code: error.code }; save(); process.exitCode = 1; }
finally { await publisher.shutdown(); fs.rmSync(cookie, { force: true }); console.log(JSON.stringify({ file: path.join(root, 'video-readback-inspect.json'), error: report.error })); }
