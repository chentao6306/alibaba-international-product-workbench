// Inspect saved product/draft navigation and lazily rendered media. No save,
// submission, deletion, or video association is performed by this probe.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher } from '../server/publisher.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';
import { readSourceDescriptionFrame } from '../server/source-description-frame.js';
import { parseAlibabaDetailDataScript, extractAlibabaDescription } from '../server/alibaba-source-data.js';

const root = process.env.QA_OUTPUT_DIR;
assert.ok(root && !fs.existsSync(root) && process.env.QA_DESKTOP_USER_DATA_DIR && process.env.QA_EXPECTED_ACCOUNT);
fs.mkdirSync(root, { recursive: true });
const cookies = path.join(root, 'session.json');
writePrivateSession(cookies, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = cookies;
const publisher = new SellerPublisher(path.join(root, 'browser'));
const report = { readOnly: true, states: [] };
const save = () => fs.writeFileSync(path.join(root, 'inspect.json'), JSON.stringify(report, null, 2));
try {
  const page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  const snapshot = async label => {
    const state = await page.evaluate(() => {
      const safeUrl = value => {
        try {
          const url = new URL(value, location.href);
          const params = new URLSearchParams();
          for (const key of ['itemId', 'productId', 'primaryId', 'pubAction', 'videoId']) {
            if (url.searchParams.has(key)) params.set(key, url.searchParams.get(key));
          }
          return url.origin + url.pathname + (params.size ? '?' + params : '');
        } catch { return ''; }
      };
      return { url: safeUrl(location.href), title: document.title,
      links: [...document.querySelectorAll('a[href]')].map(node => ({ text: node.innerText.trim(), url: node.href }))
        .filter(link => /draft|草稿|产品管理|商品管理|Manage Products|管理产品|编辑|Edit/i.test(link.text + ' ' + link.url)).slice(0, 150).map(link => ({ ...link, url: safeUrl(link.url) })),
      videos: [...document.querySelectorAll('video')].map(node => ({ url: node.currentSrc || node.src, poster: node.poster,
        module: node.closest('[data-module-name]')?.getAttribute('data-module-name'), html: node.outerHTML.slice(0, 3000) })),
      descriptions: [...document.querySelectorAll('[data-module-name*="description"], [data-module-name*="descption"], [data-testid="module-description"]')]
        .map(node => ({ module: node.getAttribute('data-module-name'), html: node.innerHTML.slice(0, 6000) })),
      specifications: [...document.querySelectorAll('[data-module-name="module_product_specification"]')].map(node => node.innerHTML.slice(0, 12000)),
      frames: [...document.querySelectorAll('iframe')].map(node => ({ src: safeUrl(node.src), id: node.id })),
      text: document.body.innerText.slice(0, 10000),
    }; });
    state.label = label; report.states.push(state); save();
    await page.screenshot({ path: path.join(root, `${label}.png`) });
    console.log(JSON.stringify({ label, url: state.url, links: state.links, videos: state.videos.map(({ url, module }) => ({ url, module })) }));
  };
  if (process.env.QA_PUBLIC_RECEIPT) {
    const receipt = JSON.parse(fs.readFileSync(process.env.QA_PUBLIC_RECEIPT));
    assert.ok(/^\d{10,16}$/.test(receipt.productId));
    const source = await publisher.readSourceProduct(page, { sourcePlatform: 'alibaba.com', sourceId: receipt.productId,
      sourceUrl: `https://www.alibaba.com/product-detail/product_${receipt.productId}.html` });
    report.collected = { videos: source.videos, detailImages: source.detailImages?.length, dataCompleteness: source.dataCompleteness };
    const script = await page.evaluate(() => [...document.scripts].map(node => node.textContent || '').find(text => /(?:window\.)?detailData\s*=\s*\{/.test(text)) || '');
    const data = parseAlibabaDetailDataScript(script);
    report.structuredDescription = extractAlibabaDescription(data);
    report.descriptionRenderType = data?.nodeMap?.module_description?.renderType;
    report.afterCollectionFrame = await readSourceDescriptionFrame(page, { selector: 'iframe[src*="descIframe"]', waitForFrame: true });
    report.descriptionFrames = [];
    for (const frame of page.frames().filter(frame => /\/descIframe\.html/.test(frame.url()))) {
      report.descriptionFrames.push(await frame.evaluate(() => ({
        html: (() => { const root = document.body?.cloneNode(true); root?.querySelectorAll('script,link,iframe').forEach(node => node.remove()); return root?.innerHTML?.slice(0, 16000); })(),
        shadows: [...document.querySelectorAll('*')].filter(node => node.shadowRoot).map(node => ({ tag: node.tagName, id: node.id, html: node.shadowRoot.innerHTML.slice(0, 25000) })),
        images: [...document.images].map(node => ({ src: node.src, lazy: node.getAttribute('data-src') })),
      })));
    }
    await snapshot('collected');
    const detail = page.locator('[data-module-name="module_description"], [data-testid="module-description"], [data-module-name^="module_structure_descption_"]').first();
    if (await detail.count()) await detail.scrollIntoViewIfNeeded();
    await page.waitForTimeout(2500);
    await snapshot('detail-visible');
  } else {
    if (process.env.QA_OBSERVED_URL) {
      const target = new URL(process.env.QA_OBSERVED_URL);
      assert.equal(target.protocol, 'https:'); assert.match(target.hostname, /(^|\.)alibaba\.com$/);
      await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    await page.waitForTimeout(3000);
    await snapshot('seller-navigation');
  }
} catch (error) { report.error = { message: error.message, code: error.code }; process.exitCode = 1; }
finally { save(); await publisher.shutdown(); fs.rmSync(cookies, { force: true }); }
