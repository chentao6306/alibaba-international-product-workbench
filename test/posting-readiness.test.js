import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { postingPageProblem, waitForDescriptionEditor } from '../server/posting-readiness.js';
import { SellerPublisher, switchToLegacyDetails } from '../server/publisher.js';

test('distinguishes invalid category, expired login and normal posting URLs', () => {
  assert.equal(postingPageProblem('https://login.alibaba.com/', '').code, 'LOGIN_REQUIRED');
  assert.equal(postingPageProblem('https://passport.alibaba.com/icbu_login.htm', '').code, 'LOGIN_REQUIRED');
  assert.equal(postingPageProblem('https://post.alibaba.com/product/publish.htm', 'The category does not exist or has become invalid.').code, 'PUBLISH_CATEGORY_INVALID');
  assert.equal(postingPageProblem('https://post.alibaba.com/product/publish.htm', '该类目已失效').code, 'PUBLISH_CATEGORY_INVALID');
  assert.equal(postingPageProblem('https://post.alibaba.com/product/publish.htm?return=login', 'Normal editor'), null);
});

test('waits for delayed English editor and ignores unrelated editable title controls', { skip: !findChromium(), timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1000);
    await page.setContent(`<div contenteditable="true" id="title">Original title</div><button>Switch to old version</button>
      <script>document.querySelector('button').onclick = function () {
        this.remove(); const normal = document.createElement('button'); normal.textContent = 'Normal editor'; document.body.append(normal);
        normal.onclick = () => { if (window.loading) return; window.loading = true;
          setTimeout(() => { const frame = document.createElement('iframe'); frame.id = 'description_ifr';
            frame.srcdoc = '<body class="mce-content-body" contenteditable="true">Ready</body>'; document.body.append(frame); }, 16000);
        };
      };</script>`);
    const stages = [];
    const found = await waitForDescriptionEditor(page, { switchMode: () => switchToLegacyDetails(page), onProgress: (stage) => stages.push(stage) });
    assert.equal(await found.body.innerText(), 'Ready');
    assert.notEqual(found.frame, page.mainFrame());
    assert.equal(await page.locator('#title').innerText(), 'Original title');
    assert.ok(stages.length >= 2);
    await page.setContent('<div contenteditable="true">Title only</div>');
    await assert.rejects(waitForDescriptionEditor(page, { timeoutMs: 100 }), { code: 'PUBLISH_EDITOR_NOT_READY' });
    assert.equal(await page.locator('body').innerText(), 'Title only');
    const resumed = await waitForDescriptionEditor(page, { timeoutMs: 200, verify: async () => {
      await page.waitForTimeout(350);
      await page.setContent('<iframe srcdoc="<body class=mce-content-body contenteditable=true>Verified</body>"></iframe>');
    } });
    assert.equal(await resumed.body.innerText(), 'Verified');
    await page.setContent('The category does not exist or has become invalid.');
    await assert.rejects(waitForDescriptionEditor(page), { code: 'PUBLISH_CATEGORY_INVALID' });
    await page.setContent(`<iframe srcdoc="<body class=mce-content-body contenteditable=true>Original description</body>"></iframe>
      <div class="next-dialog">疑似涉及禁限售，会造成风控违规问题。<button>继续提交</button><button>返回编辑</button></div>`);
    await page.frameLocator('iframe').locator('body').waitFor();
    const publisher = new SellerPublisher('unused-fixture');
    publisher.uploadLegacyDetailImages = async () => assert.fail('Do not upload behind a policy prompt');
    await assert.rejects(publisher.fillLegacyDescription(page, { description: 'Replacement' }), { code: 'PUBLISH_POLICY_REVIEW_REQUIRED' });
    assert.equal(await page.frameLocator('iframe').locator('body').innerText(), 'Original description');
  } finally { await browser.close(); }
});

test('retries incomplete form only once before submission and never replays an uncertain receipt', async () => {
  const publisher = new SellerPublisher('unused-fixture');
  publisher.downloadImageSet = async () => [];
  const product = { title: 'Drone camera', price: 10, minOrder: 1, stock: 10, origin: 'China', packaging: { weight: 0.5 },
    categoryId: '201346401', categoryPath: ['Consumer Electronics', 'Drones Accessories'],
    attributes: [{ name: 'Type', value: 'Camera' }, { name: 'Brand', value: 'Other' }],
    mainImages: [1, 2, 3, 4].map((n) => `https://example.com/${n}.jpg`), detailImages: ['https://example.com/detail.jpg'], description: 'Camera' };
  const url = 'https://post.alibaba.com/product/publish.htm?catId=201346401';
  let attempts = 0;
  publisher.publishPreparedProduct = async () => {
    if (++attempts === 1) throw Object.assign(new Error('Editor loading'), { code: 'PUBLISH_EDITOR_NOT_READY' });
    return { status: 'drafted' };
  };
  assert.equal((await publisher.publishProduct(product, url)).status, 'drafted');
  assert.equal(attempts, 2);
  for (const code of ['PUBLISH_EDITOR_NOT_READY', 'PUBLISH_FORM_NOT_READY', 'LOGIN_REQUIRED', 'PUBLISH_CATEGORY_INVALID', 'PUBLISH_RESULT_UNKNOWN']) {
    attempts = 0;
    publisher.publishPreparedProduct = async () => { attempts++; throw Object.assign(new Error(code), { code }); };
    await assert.rejects(publisher.publishProduct(product, url), { code });
    assert.equal(attempts, ['PUBLISH_EDITOR_NOT_READY', 'PUBLISH_FORM_NOT_READY'].includes(code) ? 2 : 1);
  }
});
