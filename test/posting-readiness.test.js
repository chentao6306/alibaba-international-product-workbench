import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { postingPageProblem, waitForDescriptionEditor, descriptionEditorState } from '../server/posting-readiness.js';
import { SellerPublisher, switchToLegacyDetails } from '../server/publisher.js';
import { browserResourcePolicy } from '../server/browser-resource-policy.js';

test('low-resource policy covers two-core, four-GB and low-free-memory hosts without slowing ready pages', () => {
  const gib = 1024 ** 3;
  const normal = { cpuCount: 8, totalBytes: 16 * gib, freeBytes: 8 * gib };
  assert.equal(browserResourcePolicy(normal).constrained, false);
  for (const resource of [{ cpuCount: 2 }, { totalBytes: 4 * gib }, { freeBytes: 0.5 * gib }]) {
    const policy = browserResourcePolicy({ ...normal, ...resource });
    assert.equal(policy.constrained, true);
    assert.equal(policy.imageConcurrency, 1);
    assert.ok(policy.readinessTimeoutMs >= 180000);
    assert.ok(policy.navigationTimeoutMs >= 90000);
  }
});

test('slow editor initializes beyond 45 seconds without repeated clicks and rebuilt controls can activate again', { skip: !findChromium(), timeout: 85000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.setContent(`<button>Normal editor</button><script>
      window.clicks=0; let timer;
      document.querySelector('button').onclick=()=>{
        window.clicks++; clearTimeout(timer);
        timer=setTimeout(()=>{const frame=document.createElement('iframe');
          frame.srcdoc='<body class="mce-content-body" contenteditable="true">Slow editor ready</body>';
          document.body.append(frame);},52000);
      };
    </script>`);
    const stages = [];
    const policy = browserResourcePolicy({ cpuCount: 2, totalBytes: 4 * 1024 ** 3, freeBytes: 1024 ** 3 });
    const result = await waitForDescriptionEditor(page, { timeoutMs: policy.readinessTimeoutMs,
      switchMode: () => switchToLegacyDetails(page), onProgress: (stage) => stages.push(stage) });
    assert.equal(await result.body.innerText(), 'Slow editor ready');
    assert.equal(await page.evaluate(() => window.clicks), 1, 'Repeated clicks would reset the initialization timer');
    assert.ok(stages.some((stage) => /已等待 (?:4\d|5\d) 秒/.test(stage)));
    await page.setContent('<button onclick="window.reactivated=true">Normal editor</button>');
    await switchToLegacyDetails(page);
    assert.equal(await page.evaluate(() => window.reactivated), true);
    await page.setContent('<iframe srcdoc="<body class=mce-content-body contenteditable=false>Still initializing</body>"></iframe>');
    await assert.rejects(waitForDescriptionEditor(page, { timeoutMs: 200 }), { code: 'PUBLISH_EDITOR_NOT_READY' });
  } finally { await browser.close(); }
});

test('distinguishes invalid category, expired login and normal posting URLs', () => {
  assert.equal(postingPageProblem('https://login.alibaba.com/', '').code, 'LOGIN_REQUIRED');
  assert.equal(postingPageProblem('https://passport.alibaba.com/icbu_login.htm', '').code, 'LOGIN_REQUIRED');
  assert.equal(postingPageProblem('https://post.alibaba.com/product/publish.htm', 'The category does not exist or has become invalid.').code, 'PUBLISH_CATEGORY_INVALID');
  assert.equal(postingPageProblem('https://post.alibaba.com/product/publish.htm', '该类目已失效').code, 'PUBLISH_CATEGORY_INVALID');
  assert.equal(postingPageProblem('https://post.alibaba.com/product/publish.htm?return=login', 'Normal editor'), null);
});

test('selected normal mode reveals a lazy detail section without toggling the editor again', { skip: !findChromium(), timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div style="height:3000px">Main product fields</div><h2>Product description</h2>
      <span class="icbuRadio-item"><label><input type="radio" checked><span>Normal editor</span></label></span>
      <div id="detail"></div><script>window.clicks=0;document.querySelector('label').onclick=()=>window.clicks++;
      const observer=new IntersectionObserver(entries=>{if(!entries.some(e=>e.isIntersecting))return;
        observer.disconnect();document.querySelector('#detail').innerHTML='<iframe id="description_ifr" srcdoc="<body class=mce-content-body contenteditable=true>Lazy editor ready</body>"></iframe>';
      });observer.observe(document.querySelector('h2'));</script>`);
    assert.equal((await descriptionEditorState(page)).editorFrames, 0);
    const result = await waitForDescriptionEditor(page, { timeoutMs: 6000, switchMode: () => switchToLegacyDetails(page) });
    assert.equal(await result.body.innerText(), 'Lazy editor ready');
    assert.equal(await page.evaluate(() => window.clicks), 0);
  } finally { await browser.close(); }
});

test('mode switch retries once only when the radio explicitly remains unselected', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<span class="icbuRadio-item"><label><input type="radio"><span>Normal editor</span></label></span>
      <script>window.clicks=0;document.querySelector('input').onclick=e=>{if(++window.clicks===1)e.preventDefault();};</script>`);
    await switchToLegacyDetails(page);
    assert.equal(await page.locator('input').isChecked(), false);
    await switchToLegacyDetails(page);
    assert.equal(await page.locator('input').isChecked(), true);
    await switchToLegacyDetails(page);
    assert.equal(await page.evaluate(() => window.clicks), 2);
    const state = await descriptionEditorState(page);
    assert.equal(state.normalSelected, true);
    assert.equal(state.editorFrames, 0);
    await assert.rejects(waitForDescriptionEditor(page, { timeoutMs: 100 }), (error) =>
      error.code === 'PUBLISH_EDITOR_NOT_READY' && error.diagnostics.normalSelected && /未创建编辑器/.test(error.message));
  } finally { await browser.close(); }
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
    if (++attempts === 1) throw Object.assign(new Error('Form loading'), { code: 'PUBLISH_FORM_NOT_READY' });
    return { status: 'drafted' };
  };
  assert.equal((await publisher.publishProduct(product, url)).status, 'drafted');
  assert.equal(attempts, 2);
  for (const code of ['PUBLISH_EDITOR_NOT_READY', 'PUBLISH_FORM_NOT_READY', 'LOGIN_REQUIRED', 'PUBLISH_CATEGORY_INVALID', 'PUBLISH_RESULT_UNKNOWN']) {
    attempts = 0;
    publisher.publishPreparedProduct = async () => { attempts++; throw Object.assign(new Error(code), { code }); };
    await assert.rejects(publisher.publishProduct(product, url), { code });
    assert.equal(attempts, code === 'PUBLISH_FORM_NOT_READY' ? 2 : 1);
  }
});
