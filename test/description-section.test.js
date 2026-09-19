import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { switchToLegacyDetails } from '../server/publisher.js';
import { waitForDescriptionEditor, descriptionEditorState } from '../server/posting-readiness.js';

test('reveals the structural description section before lazy editor controls exist in English', { skip: !findChromium(), timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div style="height:3500px">Basic information</div>
      <div id="struct-desc-card"><div id="desc-card-title"><h2 role="all"><span>Commodity Details</span></h2></div>
        <div id="desc-card" style="min-height:350px"></div></div>
      <div hidden><button>Normal editor</button></div>
      <script>window.clicks=0;
        const observer=new IntersectionObserver(entries=>{if(!entries.some(e=>e.isIntersecting))return;
          observer.disconnect();document.querySelector('#desc-card').innerHTML=
            '<div id="struct-productDescType"><button>Normal editor</button></div>';
          document.querySelector('#struct-productDescType button').onclick=()=>{
            window.clicks++;const frame=document.createElement('iframe');frame.id='super-text-container_ifr';
            frame.srcdoc='<body class=mce-content-body contenteditable=true>English editor ready</body>';
            document.querySelector('#desc-card').append(frame);
          };
        });observer.observe(document.querySelector('#desc-card-title'));
      </script>`);
    const found = await waitForDescriptionEditor(page, { timeoutMs: 6500, switchMode: () => switchToLegacyDetails(page) });
    assert.equal(await found.body.innerText(), 'English editor ready');
    assert.equal(await page.evaluate(() => window.clicks), 1);
    assert.ok(await page.evaluate(() => scrollY > 2500));
    assert.equal((await descriptionEditorState(page)).detailSectionFound, true);
  } finally { await browser.close(); }
});

test('scrolls the actual rich text placeholder and preserves the selected editor mode', { skip: !findChromium(), timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<input name="productTitle" value="Existing product"><div style="height:3000px"></div>
      <div id="struct-desc-card"><div id="struct-productDescType">
        <span class="icbuRadio-item"><label><input type="radio" checked><span>Ordinary editor</span></label></span></div>
        <div style="height:1200px"></div><div id="struct-superText"><div class="posting-field-supertext">
          <div class="supertext-header">Rich text</div><div id="super-text-container"></div></div></div></div>
      <script>window.clicks=0;document.querySelector('label').onclick=()=>window.clicks++;
        const observer=new IntersectionObserver(entries=>{if(!entries.some(e=>e.isIntersecting))return;
          observer.disconnect();document.querySelector('#super-text-container').innerHTML=
            '<iframe id="super-text-container_ifr" srcdoc="<body class=mce-content-body contenteditable=true>Original description</body>"></iframe>';
        });observer.observe(document.querySelector('.supertext-header'));
      </script>`);
    const result = await waitForDescriptionEditor(page, { timeoutMs: 6500, switchMode: () => switchToLegacyDetails(page) });
    assert.equal(await result.body.innerText(), 'Original description');
    assert.equal(await page.locator('[name=productTitle]').inputValue(), 'Existing product');
    assert.equal(await page.evaluate(() => window.clicks), 0);
  } finally { await browser.close(); }
});

test('reports missing entry separately from an editor script that has not initialized', { skip: !findChromium(), timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const sectionPresent of [false, true]) {
      await page.setContent(sectionPresent
        ? '<div id="desc-card-title">Commodity Details</div><div id="struct-superText"><div class="supertext-header">Rich text</div></div>'
        : '<h2>Basic information</h2>');
      const progress = [];
      await assert.rejects(waitForDescriptionEditor(page, { timeoutMs: 100,
        switchMode: () => switchToLegacyDetails(page), onProgress: stage => progress.push(stage) }), error => {
        assert.equal(error.code, 'PUBLISH_EDITOR_NOT_READY');
        assert.equal(error.diagnostics.detailSectionFound, sectionPresent);
        assert.equal(error.diagnostics.editorScriptLoaded, false);
        assert.match(error.message, sectionPresent ? /详情区已定位/ : /未找到详情区/);
        return true;
      });
      assert.ok(progress.some(stage => (sectionPresent ? /详情区已定位/ : /定位国际站详情区/).test(stage)));
    }
  } finally { await browser.close(); }
});

test('selected visible mode remains a scroll fallback when structural anchors are absent', { skip: !findChromium(), timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div style="height:3000px">Basic information</div>
      <span class="icbuRadio-item"><label><input type="radio" checked><span>Ordinary editor</span></label></span>
      <div hidden><button>Ordinary editor</button></div>
      <script>window.clicks=0;document.querySelector('label').onclick=()=>window.clicks++;
        const observer=new IntersectionObserver(entries=>{if(!entries.some(e=>e.isIntersecting))return;
          observer.disconnect();const frame=document.createElement('iframe');
          frame.srcdoc='<body class=mce-content-body contenteditable=true>Fallback ready</body>';document.body.append(frame);
        });observer.observe(document.querySelector('label'));
      </script>`);
    const found = await waitForDescriptionEditor(page, { timeoutMs: 6500, switchMode: () => switchToLegacyDetails(page) });
    assert.equal(await found.body.innerText(), 'Fallback ready');
    assert.equal(await page.evaluate(() => window.clicks), 0);
  } finally { await browser.close(); }
});

test('waits for an editor mode control moving into a small viewport and clicks it only once', { skip: !findChromium(), timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
    await page.setContent(`<div style="height:2400px"></div>
      <button style="position:fixed;left:-2000px;top:100px">Normal editor</button>
      <footer style="position:fixed;bottom:0;height:100px;width:100%;background:white">Submit controls</footer>
      <script>window.clicks=0;
        const button=document.querySelector('button');
        button.onclick=()=>{window.clicks++;button.setAttribute('aria-selected','true');
          const frame=document.createElement('iframe');frame.srcdoc='<body class=mce-content-body contenteditable=true>Ready</body>';
          document.body.prepend(frame);};
        setTimeout(()=>{const replacement=button.cloneNode(true);replacement.onclick=button.onclick;
          replacement.style.left='30px';button.replaceWith(replacement);},700);
      </script>`);
    const found = await waitForDescriptionEditor(page, { timeoutMs: 6500, switchMode: () => switchToLegacyDetails(page) });
    assert.equal(await found.body.innerText(), 'Ready');
    await switchToLegacyDetails(page);
    assert.equal(await page.evaluate(() => window.clicks), 1);
  } finally { await browser.close(); }
});
