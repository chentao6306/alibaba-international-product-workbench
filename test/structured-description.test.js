import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imageOnlyNativeStructure, waitForStructuredEditorEntry, requireStructuredDescriptionReady } from '../server/structured-description.js';
import { buildLegacyDescriptionHtml } from '../server/publisher.js';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { fillStructuredDescription, restoreStructuredImages, requireDescriptionMatch, uploadStructuredImages, resetStructuredGallery, structuredHighlightText, acceptedStructuredHighlights, openStructuredEditor, clearStructuredModules } from '../server/structured-description.js';

test('retains source and company-template image positions and rejects incomplete or unrelated upload addresses', () => {
  const urls = ['https://sc01.alicdn.com/kf/first.jpg', 'https://sc04.alicdn.com/kf/second.jpg'];
  const html = '<p>Before</p><span data-workbench-source-image="1"></span><table><tr><td colspan="2">Material</td><td>Linen</td></tr></table>'
    + '<span data-workbench-image-slot="0"></span><p>After</p><span data-workbench-source-image="1"></span>';
  const restored = restoreStructuredImages(html, urls);
  assert.ok(restored.indexOf('second.jpg') < restored.indexOf('<table>'));
  assert.ok(restored.indexOf('first.jpg') > restored.indexOf('</table>'));
  assert.equal((restored.match(/second.jpg/g) || []).length, 2);
  requireDescriptionMatch(restored, restored.replace('<tbody>', '').replace('</tbody>', ''));
  assert.throws(() => requireDescriptionMatch(restored, restored.replace('Linen', 'Cotton')), /不一致/);
  assert.throws(() => requireDescriptionMatch(restored, restored.replace('colspan="2"', 'colspan="1"')), /不一致/);
  assert.throws(() => requireDescriptionMatch('<p>Before</p><img src="x"><p>After</p>', '<p>Before</p><p>After</p><img src="x">'), /不一致/);
  assert.throws(() => restoreStructuredImages(html, [urls[0]]), /未取得/);
  assert.throws(() => restoreStructuredImages(html, [...urls, 'https://sc01.alicdn.com/kf/unused.jpg']), /数量不一致/);
  assert.throws(() => restoreStructuredImages('<span data-workbench-source-image="0"></span>', ['https://example.com/image.jpg']), /未取得/);
});

test('clears saved gallery selections across rerenders without following a checked-only locator into another gallery', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(1500);
    await page.setContent(`<div id="detailImage"></div><div id="companyImage"></div><script>
      window.selected={detailImage:['100','350'],companyImage:['400','700']};
      window.changed=[];
      function render(id){
        const root=document.getElementById(id);root.innerHTML='';
        for(const value of id==='detailImage'?['100','350']:['400','700']){
          const input=document.createElement('input');input.type='checkbox';input.value=value;input.checked=window.selected[id].includes(value);
          input.onchange=()=>{window.changed.push(id+':'+value);window.selected[id]=window.selected[id].filter(v=>v!==value);render(id);};
          root.append(input);
        }
      }
      render('detailImage');render('companyImage');
      </script>`);
    await resetStructuredGallery(page);
    assert.deepEqual(await page.evaluate(() => window.selected), { detailImage: [], companyImage: ['400', '700'] });
    await resetStructuredGallery(page, 'companyImage');
    assert.deepEqual(await page.evaluate(() => window.selected), { detailImage: [], companyImage: [] });
    assert.deepEqual(await page.evaluate(() => window.changed), ['detailImage:100', 'detailImage:350', 'companyImage:400', 'companyImage:700']);
  } finally { await browser.close(); }
});

// A small native-editor contract fixture: blur commits to a separate saved model;
// completing requires mobile confirmation; reopening loads only that saved model.
// A mere DOM write cannot pass the round trip.
function editorDocument(saved, savedHighlights = '') {
  const script = `let value=${JSON.stringify(saved)}, highlights=${JSON.stringify(savedHighlights)}, rowId=0;
    const canvas=document.querySelector('#canvas');
    function add(html){
      const row=document.createElement('div');row.className='editor-component-row';row.style='min-height:80px;padding:25px';
      const content=document.createElement('div');content.className='comp-singletext-text';
      const input=document.createElement('div');input.contentEditable='true';input.dataset.editType='rich';input.innerHTML=html;
      input.onblur=()=>{value=input.innerHTML;setTimeout(()=>{if(input.isConnected){const replacement=input.cloneNode(true);replacement.onblur=input.onblur;input.replaceWith(replacement);}},30);};
      content.append(input);row.append(content);
      const remove=document.createElement('button');remove.className='editor-canvas-handler-btn';remove.textContent='Remove';
      remove.onclick=e=>{e.stopPropagation();row.remove();value='';};row.append(remove);
      row.onclick=()=>{document.querySelectorAll('.editor-component-row').forEach(n=>n.classList.remove('active'));row.classList.add('active');};canvas.append(row);
    }
    function addHighlights(text){
      const row=document.createElement('div');row.className='editor-component-row';row.style='min-height:80px;padding:25px';
      const input=document.createElement('div');input.className='highlights-content-editor';input.contentEditable='true';input.dataset.editType='text';input.innerText=text;
      input.onblur=()=>{highlights=input.innerText;};row.append(input);
      const remove=document.createElement('button');remove.className='editor-canvas-handler-btn';remove.textContent='Remove';
      remove.onclick=e=>{e.stopPropagation();row.remove();highlights='';};row.append(remove);
      row.onclick=()=>{document.querySelectorAll('.editor-component-row').forEach(n=>n.classList.remove('active'));row.classList.add('active');};canvas.append(row);
    }
    if(highlights) addHighlights(highlights);
    add(value||'<p>UNRELATED PLATFORM EXAMPLE</p>');
    document.querySelector('#add').onclick=()=>add('Click to edit');
    document.querySelector('#highlights').onclick=()=>addHighlights('UNRELATED CERTIFICATION CLAIM');
    document.querySelector('#finish').onclick=()=>document.querySelector('#sync').hidden=false;
    document.querySelector('#sync').onclick=()=>{
      parent.savedDescription=parent.rejectSave?value.replace('Linen','Cotton'):value;
      parent.mobileDescription=parent.savedDescription;
      parent.savedHighlights=parent.rejectHighlights?'TRUNCATED':highlights;
      if(parent.formValues) parent.formValues.magicEditor={pageId:++parent.saveVersion};
      parent.document.querySelector('.icbu-sell-editor-dialog').remove();
    };`;
  return `<div class="header-title">Editor title</div><button id="finish">Editing completed</button>
    <button id="sync" hidden>Confirm synchronization</button><button>Text</button><button id="highlights"> Product Highlights </button>
    <div class="menu-item-wrap-tag"><span>Plain text</span><button id="add" class="manager__item-thumbnail">Add text module</button></div>
    <div id="canvas"></div><script>${script}</script>`;
}

for (const rejectSave of [false, true]) test(`verifies native desktop and mobile saved HTML${rejectSave ? ' and rejects platform content changes' : ' without retaining sample content'}`, { skip: !findChromium(), timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="detailImage" style="min-height:30px">Product gallery</div><button id="open">AI详情编辑器</button>');
    await page.exposeFunction('makeEditor', editorDocument);
    await page.evaluate(reject => {
      window.rejectSave = reject; window.savedDescription = ''; window.mobileDescription = '';
      document.querySelector('#open').onclick = async () => {
        const dialog = document.createElement('div'); dialog.className = 'icbu-sell-editor-dialog';
        const frame = document.createElement('iframe'); frame.name = 'decorateDetailEditor'; frame.style = 'width:100%;height:650px';
        frame.srcdoc = await window.makeEditor(window.savedDescription); dialog.append(frame); document.body.append(dialog);
      };
    }, rejectSave);
    const html = '<p>Original paragraph</p><table><tr><th>Material</th><td>Linen</td></tr></table><p>Original end</p>';
    if (rejectSave) await assert.rejects(fillStructuredDescription(page, { html, files: [] }), error => {
      assert.equal(error.code, 'PUBLISH_EDITOR_NOT_READY'); assert.equal(error.diagnostics.stage, 'saved-readback'); return true;
    });
    else {
      await fillStructuredDescription(page, { html, files: [] });
      const saved = await page.evaluate(() => ({ desktop: window.savedDescription, mobile: window.mobileDescription }));
      requireDescriptionMatch(html, saved.desktop); requireDescriptionMatch(html, saved.mobile);
      assert.doesNotMatch(saved.desktop, /UNRELATED PLATFORM EXAMPLE/);
      assert.equal(await page.locator('iframe').count(), 0);
    }
  } finally { await browser.close(); }
});

test('native highlights persist with the source HTML and receipts expire when the editor or product changes', { skip: !findChromium(), timeout: 45000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="detailImage" style="min-height:30px">Product gallery</div><div id="textDesc"><div contenteditable="true"></div></div><button id="open">AI详情编辑器</button>');
    await page.exposeFunction('makeEditor', editorDocument);
    await page.evaluate(() => {
      window.savedDescription = ''; window.savedHighlights = ''; window.saveVersion = 0;
      window.formValues = { productDescType: { value: 5 }, magicEditor: {} };
      window.GlobalStore = { engine: { getModels: () => ({ formValues: window.formValues }) } };
      document.querySelector('#open').onclick = async () => {
        const dialog = document.createElement('div'); dialog.className = 'icbu-sell-editor-dialog';
        const frame = document.createElement('iframe'); frame.name = 'decorateDetailEditor'; frame.style = 'width:100%;height:650px';
        frame.srcdoc = await window.makeEditor(window.savedDescription, window.savedHighlights); dialog.append(frame); document.body.append(dialog);
      };
    });
    const product = { subtitle: 'Natural linen fabric', keywords: ['Linen fabric', 'Woven fabric'] };
    const html = '<p>Original fabric description</p><table><tr><td>Composition</td><td>100% linen</td></tr></table>';
    const highlights = structuredHighlightText(product);
    await fillStructuredDescription(page, { html, files: [], highlights });
    const saved = await page.evaluate(() => ({ html: window.savedDescription, highlights: window.savedHighlights }));
    assert.equal(saved.highlights, highlights); requireDescriptionMatch(html, saved.html);
    assert.doesNotMatch(saved.html + saved.highlights, /UNRELATED/);
    assert.equal(await acceptedStructuredHighlights(page, product), true);
    assert.equal(await acceptedStructuredHighlights(page, { ...product, subtitle: 'Changed by user' }), false);
    await page.evaluate(() => { window.formValues.magicEditor.pageId++; });
    assert.equal(await acceptedStructuredHighlights(page, product), false);
    await page.evaluate(() => { window.rejectHighlights = true; });
    await assert.rejects(fillStructuredDescription(page, { html, files: [], highlights }), error => error.diagnostics?.stage === 'highlights-readback');
    assert.equal(await acceptedStructuredHighlights(page, product), false);
  } finally { await browser.close(); }
});

test('oversized highlights are rejected before removing or uploading existing content', async () => {
  const page = new Proxy({}, { get: () => assert.fail('Must validate before changing the form') });
  await assert.rejects(fillStructuredDescription(page, { html: '<p>Keep</p>', files: [], highlights: 'x'.repeat(2001) }), error => error.diagnostics?.stage === 'highlights-limit');
});

test('maps image-only descriptions directly to native galleries without requiring the optional AI editor button', () => {
  const urls=['https://sc04.alicdn.com/kf/first.jpg','https://sc04.alicdn.com/kf/second.jpg'];
  const html='<div><img data-workbench-image-slot="0"></div><p><img data-workbench-image-slot="1"></p>';
  const plan=imageOnlyNativeStructure(html,urls,'Soft fabric');
  assert.equal(plan.modules[0].items[0],'Soft fabric');
  assert.deepEqual(plan.modules[1].images.map(i=>i.url),urls);
  for (const extra of ['<p>Keep real text</p>','<table><tr><td></td></tr></table>','<a href="https://example.test">Link</a>']) {
    assert.equal(imageOnlyNativeStructure(html+extra,urls),null);
  }
  assert.equal(imageOnlyNativeStructure(html,[urls[0]]),null);
  assert.equal(imageOnlyNativeStructure(html.replace('slot="1"','slot="0"'),urls),null);
  const generated = buildLegacyDescriptionHtml({ descriptionHtml: `<p><img src="${urls[0]}"></p><p><img src="${urls[1]}"></p>`, detailImages: urls });
  assert.deepEqual(imageOnlyNativeStructure(generated, urls).modules[0].images.map(i => i.url), urls);
});

test('waits for a lazily mounted structured editor entry and leaves source content untouched', {skip:!findChromium()}, async()=>{
  const browser=await chromium.launch({executablePath:findChromium(),headless:true});
  try {
    const page=await browser.newPage();
    await page.setContent('<div id="companyFaqDesc">Keep existing FAQ</div>');
    await page.evaluate(()=>setTimeout(()=>{const b=document.createElement('button');b.textContent='详描通用排版';document.body.append(b);},500));
    assert.equal(await waitForStructuredEditorEntry(page,2500),true);
    assert.equal(await page.locator('#companyFaqDesc').innerText(),'Keep existing FAQ');
    await page.getByRole('button').evaluate(n=>n.remove());
    assert.equal(await waitForStructuredEditorEntry(page,100),false);
  } finally {await browser.close();}
});

test('detects a blank structured editor before filling the form so only the safe pre-submit retry is allowed', { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<input id="productTitle" value="Existing title"><div id="magicEditor"></div><div id="companyFaqDesc">Existing FAQ</div><script>window.GlobalStore={engine:{getModels:()=>({formValues:{productDescType:{value:5}}})}};</script>');
    await assert.rejects(requireStructuredDescriptionReady(page, { html: '<p>Source text</p>', timeoutMs: 100 }), error => error.code === 'PUBLISH_FORM_NOT_READY' && error.diagnostics.stage === 'entry-before-fill');
    assert.equal(await page.locator('input').inputValue(), 'Existing title');
    assert.equal(await page.locator('#companyFaqDesc').innerText(), 'Existing FAQ');
    await page.evaluate(() => setTimeout(() => { const button = document.createElement('button'); button.textContent = 'AI详情编辑器'; document.querySelector('#magicEditor').append(button); }, 250));
    await requireStructuredDescriptionReady(page, { html: '<p>Source text</p>', timeoutMs: 1000 });
    await page.evaluate(() => { document.querySelector('button').remove(); window.GlobalStore.engine.getModels = () => ({ formValues: { productDescType: { value: 4 } } }); });
    await requireStructuredDescriptionReady(page, { html: '<span data-workbench-source-image="0"></span>', imageUrls: ['https://sc04.alicdn.com/kf/source.jpg'], timeoutMs: 100 });
    await assert.rejects(requireStructuredDescriptionReady(page, { html: '<table><tr><td>Must retain table</td></tr></table>', timeoutMs: 100 }), { code: 'PUBLISH_FORM_NOT_READY' });
  } finally { await browser.close(); }
});

for (const height of [0, 200]) test(`keeps a saved magic editor with ${height}px placeholder in view until its lazy button mounts`, { skip: !findChromium() }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.setContent(`<div style="height:1500px"></div><div id="magicEditor" style="height:${height}px"></div><div style="height:2500px"></div><div id="companyFaqDesc">FAQ</div><script>window.GlobalStore={engine:{getModels:()=>({formValues:{productDescType:{value:5}}})}};let timer;new IntersectionObserver(entries=>{clearTimeout(timer);if(entries[0].isIntersecting)timer=setTimeout(()=>{document.querySelector("#magicEditor").innerHTML="<button>AI详情编辑器</button>";},350);}).observe(document.querySelector("#magicEditor"));</script>`);
    assert.equal(await waitForStructuredEditorEntry(page, 1500), true);
    assert.equal(await page.locator('#magicEditor button').isVisible(), true);
  } finally { await browser.close(); }
});

test('preview buttons disappearing during editor transitions do not fail the product or imply a saved description', { skip: !findChromium(), timeout: 25000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const label of ['确认应用', 'Confirm the application and go to Edit']) {
      await page.setContent('<button id="open">AI详情编辑器</button>');
      await page.evaluate(label => {
        document.querySelector('#open').onclick = () => {
          const frame = document.createElement('iframe'); frame.name = 'decorateDetailEditor'; frame.style = 'width:900px;height:500px';
          // Continuous movement makes the pending click wait for stability.
          // The platform then removes that button and enters the editor itself.
          frame.srcdoc = `<style>@keyframes moving {from{transform:translateX(0)}to{transform:translateX(100px)}}button{animation:moving .2s infinite alternate linear}</style>
            <button>${label}</button><script>setTimeout(()=>{document.body.innerHTML='<button style="animation:none">编辑完成</button><div class="editor-component-row">Actual editor</div>';},700);<\/script>`;
          document.body.append(frame);
        };
      }, label);
      const frame = await openStructuredEditor(page, { previewTimeout: 5000 });
      assert.equal(await frame.locator('.editor-component-row').innerText(), 'Actual editor');
      assert.equal(await acceptedStructuredHighlights(page, {}), false);
    }
    // Clicking a confirmation that does nothing is not proof of an editor.
    await page.setContent('<button id="open">AI详情编辑器</button>');
    await page.evaluate(() => {
      document.querySelector('#open').onclick = () => {
        const frame = document.createElement('iframe'); frame.name = 'decorateDetailEditor';
        frame.srcdoc = '<button onclick="parent.previewClicks++">确认应用</button>'; document.body.append(frame);
      };
      window.previewClicks = 0;
    });
    await assert.rejects(openStructuredEditor(page, { previewTimeout: 2000 }), error =>
      error.code === 'PUBLISH_EDITOR_NOT_READY' && error.diagnostics.stage === 'generated-preview');
    assert.equal(await page.evaluate(() => window.previewClicks), 1);
  } finally { await browser.close(); }
});

test('refuses an oversized structured gallery before changing any form data', async () => {
  await assert.rejects(uploadStructuredImages({ locator: () => assert.fail('Must check the limit before mutating') }, Array(31).fill('image.jpg')), error => {
    assert.equal(error.diagnostics.stage, 'image-limit'); return true;
  });
});

test('removes template navigation together with its content using current Chinese and English confirmation labels', { skip: !findChromium(), timeout: 20000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage();
    for (const label of ['删除导航及其内容', '删除导航及内容', '删除导航和内容', 'Delete navigation and content', 'Delete navigation and its content']) {
      await page.setContent(`<div class="editor-component-row" style="height:100px;padding:30px">
          <div data-edit-type="navigation">OTHER PRODUCT IMAGES</div><button class="editor-canvas-handler-btn">Delete</button>
        </div><div class="editor-component-row" id="content">UNRELATED TEMPLATE CONTENT</div>
        <div role="dialog" hidden><button id="all">${label}</button><button id="nav">仅删除导航条</button></div>
        <script>window.removedAll=false;window.removedOnlyNavigation=false;
          document.querySelector('.editor-component-row').onclick=e=>e.currentTarget.classList.add('active');
          document.querySelector('.editor-canvas-handler-btn').onclick=()=>document.querySelector('[role=dialog]').hidden=false;
          document.querySelector('#nav').onclick=()=>{window.removedOnlyNavigation=true;};
          document.querySelector('#all').onclick=()=>{window.removedAll=true;document.querySelectorAll('.editor-component-row').forEach(n=>n.remove());document.querySelector('[role=dialog]').remove();};
        </script>`);
      await clearStructuredModules(page, page.mainFrame());
      assert.deepEqual(await page.evaluate(() => [window.removedAll, window.removedOnlyNavigation]), [true, false]);
      assert.equal(await page.locator('.editor-component-row').count(), 0);
    }
  } finally { await browser.close(); }
});

test('waits past stale empty-gallery validation and maps out-of-order uploads by source file identity', { skip: !findChromium(), timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-images-'));
  try {
    const files = ['first.jpg', 'second.jpg'].map(name => { const file = path.join(root, name); fs.writeFileSync(file, 'fixture'); return file; });
    const page = await browser.newPage();
    await page.setContent(`<div id="detailImage"><label><input type="checkbox">Other product images</label><div id="upload"></div></div>
      <script>document.querySelector('input').onchange=()=>{
        document.querySelector('#upload').innerHTML='<input type="file" multiple><div class="gallery-item-error">勾选该图集后至少上传一张图片</div>';
        document.querySelector('input[type=file]').onchange=e=>{
          const files=[...e.target.files];
          setTimeout(()=>{document.querySelector('.gallery-item-error').remove();
            for(const file of files.reverse()) {const row=document.createElement('div');row.className='gallery-item-image';
              const image=document.createElement('img');image.alt=file.name;image.src='https://sc01.alicdn.com/kf/'+file.name;row.append(image);document.querySelector('#upload').append(row);}
          },650);
        };
      };</script>`);
    const result = await uploadStructuredImages(page, files);
    assert.deepEqual(result, ['https://sc01.alicdn.com/kf/first.jpg', 'https://sc01.alicdn.com/kf/second.jpg']);
  } finally { await browser.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('uploads native gallery images sequentially so completion timing cannot reorder the saved image list', { skip: !findChromium(), timeout: 20000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-gallery-order-'));
  try {
    const files = ['first.jpg', 'second.jpg', 'third.jpg'].map(name => { const file = path.join(directory, name); fs.writeFileSync(file, 'fixture'); return file; });
    const page = await browser.newPage();
    await page.setContent(`<div id="detailImage"><label><input type="checkbox">Other product images</label><input type="file" multiple><div id="images"></div></div>
      <script>window.batches=[];document.querySelector('input[type=file]').onchange=e=>{
        const files=[...e.target.files];window.batches.push(files.map(f=>f.name));
        files.forEach(file=>setTimeout(()=>{const row=document.createElement('div');row.className='gallery-item-image';
          const image=document.createElement('img');image.alt=file.name;image.src='https://sc01.alicdn.com/kf/'+file.name;row.append(image);document.querySelector('#images').append(row);
        },file.name==='first.jpg'?500:50));
      };</script>`);
    const uploaded = await uploadStructuredImages(page, files, () => {}, { ordered: true });
    assert.deepEqual(await page.evaluate(() => window.batches), [['first.jpg'], ['second.jpg'], ['third.jpg']]);
    assert.deepEqual(await page.locator('.gallery-item-image img').evaluateAll(nodes => nodes.map(node => node.src)), uploaded);
  } finally { await browser.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
