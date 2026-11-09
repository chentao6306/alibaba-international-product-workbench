import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { sourceDescriptionFormat, ensureSourceDescriptionMode, requireSourceDescriptionMode, descriptionCompatibility } from '../server/description-mode.js';
import { descriptionSourceHash } from '../server/description-structure.js';
import { SellerPublisher } from '../server/publisher.js';

const oldProduct = { descriptionHtml: '<p>Original content</p><table><tr><td>Material</td><td>Nylon</td></tr></table>', detailImages: [] };
const newProduct = { descriptionHtml: '<p>Soft nylon</p>', structuredDescription: { version: 1,
  sourceHtmlHash: descriptionSourceHash('<p>Soft nylon</p>'), modules: [{ type: 'highlights', items: ['Soft nylon'] }] } };

test('selects description generation from source modules and retains the classification after stale manual edits', () => {
  assert.equal(sourceDescriptionFormat(oldProduct), 'legacy');
  assert.equal(sourceDescriptionFormat({ descriptionHtml: '<p><img src="source.jpg"></p>' }), 'legacy');
  assert.equal(sourceDescriptionFormat(newProduct), 'structured');
  assert.equal(sourceDescriptionFormat({ ...newProduct, descriptionHtml: '<p>Edited content</p>' }), 'structured');
  assert.equal(sourceDescriptionFormat({ ...oldProduct, source: { snapshot: newProduct } }), 'structured');
  assert.equal(sourceDescriptionFormat({ ...newProduct, descriptionTemplate: { html: '<p>User template</p>' } }), 'legacy');
});

test('returns an old source to the legacy editor once, confirms the switch and preserves its table', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<input name="productTitle" value="Existing title"><div id="desc-card-title">商品详情</div>
      <div id="textDesc">New editor default</div><button id="back">返回老版</button>
      <div role="dialog" hidden><button id="confirm">继续返回旧版</button></div>
      <script>window.mode=4;window.clicks=0;window.confirms=0;
        window.GlobalStore={engine:{getModels:()=>({formValues:{productDescType:{value:window.mode}}})}};
        document.querySelector('#back').onclick=()=>{window.clicks++;document.querySelector('[role=dialog]').hidden=false};
        document.querySelector('#confirm').onclick=()=>{window.confirms++;
          setTimeout(()=>{window.mode=1;document.querySelector('#textDesc').remove();document.querySelector('#back').remove();
            document.querySelector('[role=dialog]').remove();const root=document.createElement('div');root.id='struct-superText';
            root.innerHTML='<iframe srcdoc="<body class=mce-content-body contenteditable=true>Previous</body>"></iframe>';document.body.append(root);},120);
        };
      </script>`);
    await ensureSourceDescriptionMode(page, oldProduct, { timeoutMs: 2000 });
    const publisher = new SellerPublisher('unused-fixture');
    publisher.uploadLegacyDetailImages = async () => 0;
    await publisher.fillLegacyDescription(page, oldProduct);
    const content = await page.frameLocator('iframe').locator('body').innerHTML();
    assert.match(content, /<table>/); assert.match(content, /Nylon/);
    assert.equal(await page.locator('[name=productTitle]').inputValue(), 'Existing title');
    assert.deepEqual(await page.evaluate(() => [window.clicks, window.confirms]), [1, 1]);
    await requireSourceDescriptionMode(page, oldProduct);
    await page.evaluate(() => window.mode = 4);
    await assert.rejects(requireSourceDescriptionMode(page, oldProduct), { code: 'PUBLISH_DESCRIPTION_MODE_UNAVAILABLE' });
  } finally { await browser.close(); }
});

test('prefers native modules and uses legacy compatibility only for an unavailable structured entrance', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="textDesc">Saved native content</div><button onclick="window.clicked=true">返回老版</button>');
    assert.equal(await ensureSourceDescriptionMode(page, newProduct), 'structured');
    assert.equal(await page.evaluate(() => window.clicked), undefined);
    await assert.rejects(ensureSourceDescriptionMode(page, { ...newProduct, descriptionHtml: 'Changed' }), error => error.diagnostics.stage === 'source-modules-unavailable');
    await assert.rejects(ensureSourceDescriptionMode(page, oldProduct, { timeoutMs: 200 }), error => error.diagnostics.stage === 'switch-not-committed');
    assert.equal(await page.locator('#textDesc').innerText(), 'Saved native content');
    await page.setContent('<div id="struct-superText">Old editor</div>');
    assert.equal(await ensureSourceDescriptionMode(page, newProduct, { timeoutMs: 200 }), 'legacy');
    assert.equal(descriptionCompatibility(page, newProduct).reason, 'structured-entry-unavailable');
    await requireSourceDescriptionMode(page, newProduct);
    assert.equal(await page.locator('#struct-superText').innerText(), 'Old editor');
    // A new form navigation must not reuse the previous form's decision.
    await page.goto('about:blank#new-form');
    await page.setContent('<div id="struct-superText">Old editor</div><button onclick="document.querySelector(\'#struct-superText\').id=\'detailImage\';this.remove()">使用新版</button>');
    assert.equal(await ensureSourceDescriptionMode(page, newProduct, { timeoutMs: 1000 }), 'structured');
  } finally { await browser.close(); }
});
