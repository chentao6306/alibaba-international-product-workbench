import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { sanitizeCollectedProduct, sanitizeSourceDescriptionHtml, preparePublishProduct, fillOriginCountry } from '../server/publisher.js';
import { currentDescriptionStructure, extractDescriptionStructure, descriptionSourceHash } from '../server/description-structure.js';
import { compileNativeDescription, fillNativeDescriptionText, readNativeDescriptionFields, requireNativeDescriptionFields } from '../server/native-description-fields.js';

const source = '<div data-module-name="module_structure_descption_companyInfo"><div data-testid="product-detail-text">Original supplier.</div></div>'
  + '<div data-module-name="module_structure_descption_faqInfo"><div data-testid="product-detail-qa">'
  + '<div><div><span>How to contact us?</span></div><div><span>Use the inquiry button.</span></div></div>'
  + '<div><div><span>What is the lead time?</span></div><div><span>Contact us through the inquiry button for a quotation.</span></div></div></div></div>';
const schemas = { companyDesc: { maxLength: 2000 }, companyFaqDesc: { maxItem: 8, questionLength: 150, answerLength: 500 } };
const faq = structure => structure.modules.find(module => module.type === 'faq').items;

test('keeps complete contact FAQ after collection, save, reopen and a manual company edit', () => {
  const collected = sanitizeCollectedProduct({ descriptionHtml: source, structuredDescription: extractDescriptionStructure(source) });
  const reopened = JSON.parse(JSON.stringify(collected));
  reopened.descriptionHtml = reopened.descriptionHtml.replace('Original supplier.', 'Edited supplier.');
  const prepared = preparePublishProduct(reopened);
  const plan = compileNativeDescription(currentDescriptionStructure(prepared), schemas);
  assert.equal(plan.companyDesc, 'Edited supplier.');
  assert.deepEqual(plan.companyFaqDesc, [
    { question: 'How to contact us?', answers: 'Use the inquiry button.' },
    { question: 'What is the lead time?', answers: 'Contact us through the inquiry button for a quotation.' },
  ]);
  assert.deepEqual(faq(extractDescriptionStructure(sanitizeSourceDescriptionHtml(prepared.descriptionHtml))), faq(extractDescriptionStructure(source)));
  const clean = sanitizeSourceDescriptionHtml(source + '<p>Contact us: sales@example.test</p><p>Phone: +1 555 123 4567</p><script>alert(1)</script>');
  assert.doesNotMatch(clean, /sales@|555 123|alert\(1\)/);
});

function legacyProduct() {
  // Old releases saved sanitized HTML and an intact structured snapshot.
  const html = source.replace('<span>How to contact us?</span>', '');
  const structure = extractDescriptionStructure(source);
  structure.sourceHtmlHash = descriptionSourceHash(html);
  const snapshot = { descriptionHtml: html, structuredDescription: structure };
  const descriptionHtml = html.replace('Original supplier.', 'Edited supplier.');
  return { descriptionHtml, structuredDescription: extractDescriptionStructure(descriptionHtml), source: {
    snapshot, snapshotHashVersion: 2, snapshotHash: descriptionSourceHash(JSON.stringify(snapshot)),
  } };
}

test('recovers only a proven legacy FAQ question loss from its intact immutable snapshot', () => {
  const product = legacyProduct(), before = structuredClone(product);
  const prepared = preparePublishProduct(product);
  const structure = currentDescriptionStructure(prepared);
  const plan = compileNativeDescription(structure, schemas);
  assert.equal(plan.companyFaqDesc[0].question, 'How to contact us?');
  assert.equal(plan.companyDesc, 'Edited supplier.');
  assert.deepEqual(structure.repairs, [{ reason: 'legacy-faq-question-cleanup', source: 'source.snapshot.structuredDescription', rows: [1] }]);
  assert.deepEqual(product, before);
});

test('does not restore FAQ from another edit, missing evidence, changed answers or a tampered snapshot', () => {
  for (const change of [
    product => { delete product.source; },
    product => { product.source.snapshotHash = 'tampered'; },
    product => { product.source.snapshot.descriptionHtml += 'changed'; },
    product => { product.descriptionHtml = product.descriptionHtml.replace('Use the inquiry button.', 'Edited answer.'); },
    product => { product.descriptionHtml = product.descriptionHtml.replace('<div><div></div>', '<div><div>Edited question?</div>'); },
    product => { product.structuredDescription.modules.find(m => m.type === 'faq').items.reverse(); },
  ]) {
    const product = legacyProduct(); change(product);
    const current = currentDescriptionStructure(product);
    assert.equal(current.repairs, undefined);
    assert.ok(!faq(current).some(item => item.question === 'How to contact us?'));
  }
  const product = legacyProduct(); product.descriptionHtml = '<p>Manual replacement.</p>';
  assert.equal(currentDescriptionStructure(product), null);
  product.descriptionTemplate = { id: 'template' };
  assert.equal(currentDescriptionStructure(product), null);
});

const browserTest = (name, run) => test(name, { skip: !findChromium(), timeout: 45000 }, async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
    // Match the desktop's per-action budget. The deliberately short remount
    // probe below still exercises recovery without a machine-load race.
    page.setDefaultTimeout(5000);
    await run(page);
  } finally { await browser.close(); }
});

browserTest('fills and verifies literal origin when a fixed publish footer covers the field', async page => {
  await page.setContent(`<style>body{margin:0;height:1800px}#struct-p-1{position:absolute;top:530px}#struct-float-bottom{position:fixed;bottom:0;height:100px;width:100%;background:white}</style>
    <div class="sell-catProp-item" id="struct-p-1"><label class="required">原产地</label><input required onblur="window.committed=this.value"></div>
    <div id="struct-float-bottom" onclick="window.footerClicks++"><div class="sell-info">Publish controls</div></div>
    <script>window.footerClicks=0</script>`);
  assert.equal(await fillOriginCountry(page, 'None'), true);
  assert.equal(await page.locator('input').inputValue(), 'None');
  assert.equal(await page.evaluate(() => window.committed), 'None');
  assert.equal(await page.evaluate(() => window.footerClicks), 0);
  assert.equal(await page.locator('#struct-float-bottom').isVisible(), true);
});

async function companyPage(page) {
  await page.setContent(`<div id="companyDesc"><textarea data-real="true"></textarea></div><button onclick="window.submits++">Submit</button>
    <script>window.submits=0;window.writes=0;
    const state={textDesc:'',companyDesc:'',companyFaqDesc:[],detailImage:[],companyImage:[]};
    window.GlobalStore={engine:{getModels:()=>({formValues:state})}};
    window.bindEditor=()=>document.querySelector('textarea').onchange=e=>{state.companyDesc=e.target.value;window.writes++;};bindEditor();</script>`);
}
const companyPlan = { textDesc: '', companyDesc: 'Verified company text.', companyFaqDesc: [], galleries: [] };

browserTest('reacquires a remounted company textarea and verifies the committed native value', async page => {
  await companyPage(page);
  let replaced = false;
  const stages = [];
  await fillNativeDescriptionText(page, companyPlan, { onProgress: stage => stages.push(stage), beforeInteraction: async locator => {
    if (!replaced && await locator.evaluate(node => node.tagName === 'TEXTAREA')) {
      replaced = true;
      await page.evaluate(() => {
        document.querySelector('textarea').remove();
        setTimeout(() => { document.querySelector('#companyDesc').innerHTML = '<textarea data-real="true"></textarea>'; window.bindEditor(); }, 250);
      });
      await locator.scrollIntoViewIfNeeded({ timeout: 75 });
    }
    await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
  } });
  assert.equal(replaced, true);
  assert.deepEqual(stages, ['填写新版详情：公司介绍']);
  requireNativeDescriptionFields(companyPlan, await readNativeDescriptionFields(page));
  assert.deepEqual(await page.evaluate(() => [window.writes, window.submits]), [1, 0]);
});

browserTest('bounds company field recovery and identifies the failing field without submitting', async page => {
  await companyPage(page);
  let attempts = 0;
  await assert.rejects(fillNativeDescriptionText(page, companyPlan, { beforeInteraction: async locator => {
    if (await locator.evaluate(node => node.tagName === 'TEXTAREA')) {
      attempts++;
      throw Object.assign(new Error('locator.scrollIntoViewIfNeeded: Timeout 5000ms exceeded'), { name: 'TimeoutError' });
    }
  } }), error => {
    assert.equal(error.diagnostics.field, 'companyDesc');
    assert.equal(error.diagnostics.attempts, 3);
    assert.match(error.message, /公司介绍/);
    return true;
  });
  assert.equal(attempts, 3);
  assert.deepEqual(await page.evaluate(() => [window.writes, window.submits]), [0, 0]);
});

browserTest('does not retry text editing after a pause or an unresolved platform overlay', async page => {
  await companyPage(page);
  for (const code of ['PUBLISH_PAUSED', 'PUBLISH_OVERLAY_BLOCKED']) {
    let attempts = 0;
    await assert.rejects(fillNativeDescriptionText(page, companyPlan, { beforeInteraction: async () => {
      attempts++; throw Object.assign(new Error('Stop editing'), { code });
    } }), { code });
    assert.equal(attempts, 1);
  }
  assert.deepEqual(await page.evaluate(() => [window.writes, window.submits]), [0, 0]);
});

browserTest('recovers a fourth FAQ answer temporarily disabled after its question commits', async page => {
  await page.setContent(`<div id="companyFaqDesc"><div class="company-faq-desc"><div id="rows"></div></div></div>
    <button onclick="window.submits++">Submit</button><script>
    window.submits=0;window.answerWrites=0;
    const state={textDesc:'',companyDesc:'',companyFaqDesc:[],detailImage:[],companyImage:[]};
    window.GlobalStore={engine:{getModels:()=>({formValues:state})}};
    for(let index=0;index<5;index++){
      const row=document.createElement('div');row.className='item';
      row.innerHTML='<div class="question"><input></div><div class="answers"><textarea data-real="true"></textarea></div>';
      const input=row.querySelector('input'),answer=row.querySelector('textarea');
      input.onchange=()=>{
        state.companyFaqDesc[index]={question:input.value,answers:''};
        if(index===3){answer.disabled=true;setTimeout(()=>answer.disabled=false,6400);}
      };
      answer.onchange=()=>{state.companyFaqDesc[index].answers=answer.value;window.answerWrites++;};
      document.querySelector('#rows').append(row);
    }
    </script>`);
  const plan = { textDesc: '', companyDesc: '', galleries: [], companyFaqDesc: Array.from({ length: 5 }, (_, index) => ({
    question: `Question ${index + 1}?`, answers: `Answer ${index + 1}.`,
  })) };
  await fillNativeDescriptionText(page, plan, { beforeInteraction: target => target.scrollIntoViewIfNeeded({ timeout: 1000 }) });
  requireNativeDescriptionFields(plan, await readNativeDescriptionFields(page));
  assert.deepEqual(await page.evaluate(() => [window.answerWrites, window.submits]), [5, 0]);
});
