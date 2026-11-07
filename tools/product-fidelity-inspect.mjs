// Inspect an existing listing without submitting or modifying customer data.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher, fillAndVerify, ensureColorSpecificationReady, fillColorSpec, clearSaleAttributeSelections, preparePublishProduct, requireCategoryAttributes } from '../server/publisher.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
import { fillCustomAttributes, readCustomAttributes, requireCustomAttributes } from '../server/custom-attributes.js';
import { revealDescriptionSection } from '../server/posting-readiness.js';

const output = process.env.QA_OUTPUT_DIR;
assert.ok(output && process.env.QA_DESKTOP_USER_DATA_DIR && process.env.QA_EXPECTED_ACCOUNT);
fs.mkdirSync(output, { recursive: true });
const sessionFile = path.join(output, 'inspection-cookies.json');
writePrivateSession(sessionFile, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = sessionFile;
const publisher = new SellerPublisher(path.join(output, 'inspection-browser'));
const report = { readOnly: true, pages: [] };
try {
  const page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  const pending = [];
  report.descriptionResponses = [];
  page.on('response', response => {
    if (!['xhr', 'fetch'].includes(response.request().resourceType())) return;
    pending.push((async () => {
      let data; try { data = await response.json(); } catch { return; }
      const matches = [];
      const walk = (value, trail = '', depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 13) return;
        if (/descUpgrade|textDesc|detailImage|keywordTitleUpgrade|descVersion|newDesc|isNewDetail/i.test(String(value.id || value.name || value.field || ''))) {
          const text = JSON.stringify(value); if (text.length < 18000) matches.push({ trail, value });
        }
        for (const [key, next] of Object.entries(value)) {
          if (/descVersion|newDesc|isNewDetail|detailVersion|structure.*desc|desc.*structure/i.test(key)) matches.push({ trail: trail + '.' + key, value: next });
          walk(next, trail + '.' + key, depth + 1);
        }
      };
      walk(data);
      if (matches.length) { const url = new URL(response.url()); report.descriptionResponses.push({ url: url.origin + url.pathname, matches }); }
    })());
  });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  for (const itemId of (process.env.QA_PUBLISHED_IDS || '1601985253611').split(',')) {
    assert.match(itemId, /^\d+$/);
    await page.goto(process.env.QA_NEW_FORM === '1' ? 'https://post.alibaba.com/product/publish.htm?catId=201905202&language=zh_CN' : `https://post.alibaba.com/product/publish.htm?itemId=${itemId}&language=zh_CN`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('input#productTitle').waitFor({ timeout: 45000 });
    await revealDescriptionSection(page);
    await page.waitForTimeout(1500);
    if (process.env.QA_SMART_EDITOR === '1') {
      await page.locator('#productDescType .item-label').filter({ hasText: /^智能编辑$/ }).click();
      await page.waitForTimeout(12000);
      await page.getByText('我要编辑', { exact: true }).click();
      await page.waitForTimeout(12000);
    }
    const state = await page.evaluate(() => ({
      title: document.querySelector('input#productTitle')?.value,
      descriptionConfiguration: {
        switches: Object.fromEntries(Object.entries(window.Json?.models?.global?.globalSwitcher || {}).filter(([key]) => /detail|desc|decorat/i.test(key))),
        fields: Object.fromEntries(['descUpgrade', 'simpleDescUpgrade', 'textDesc', 'detailImage', 'productDescType'].map(id => [id, window.Json?.components?.[id]?.props])),
      },
      scripts: [...document.scripts].map(s => s.src).filter(Boolean).map(src => { const u = new URL(src); return u.origin + u.pathname; }),
      globals: Object.keys(window).filter(k => /data|schema|config|posting|generate|engine|basic|global/i.test(k)),
      inlineDetail: [...document.scripts].filter(s => !s.src).flatMap(s => [...s.textContent.matchAll(/enableDetailStruct|"descUpgrade"|"textDesc"|"simpleDescUpgrade"|"productDescType"/g)]
        .map(m => s.textContent.slice(Math.max(0, m.index - 40), m.index + 450))).slice(0, 30),
      detailMetadata: ['descUpgrade', 'productDescType', 'textDesc', 'detailImage', 'magicEditor'].map(id => {
        const node = document.getElementById('struct-' + id);
        const key = node && Object.keys(node).find(k => k.startsWith('__reactFiber'));
        const values = [];
        for (let f = node?.[key], i = 0; f && i < 6; f = f.return, i++) {
          for (const [name, value] of Object.entries(f.memoizedProps || {})) {
            if (/children|store|context/i.test(name)) continue;
            try { const json = JSON.stringify(value); if (json?.length < 40000) values.push({ name, value }); } catch {}
          }
        }
        return { id, values };
      }),
      links: [...document.querySelectorAll('a[href]')].filter(n => /结构化|新版|商详|编辑/.test(n.textContent)).map(n => ({ text: n.textContent.trim(), href: n.href })),
      description: document.querySelector('#struct-desc-card')?.outerHTML,
      editorModes: [...document.querySelectorAll('button,a,[role="radio"],.item-label')].map(n => n.textContent.trim()).filter(t => /新版|旧版|编辑|editor|version|smart|structure/i.test(t)),
      categoryMetadata: (() => {
        const root = document.getElementById('catInfo') || document.getElementById('struct-catInfo');
        const key = root && Object.keys(root).find(k => k.startsWith('__reactFiber'));
        const values = [];
        for (let f = root?.[key], i = 0; f && i < 18; f = f.return, i++) {
          const props = f.memoizedProps;
          if (!props) continue;
          for (const [name, value] of Object.entries(props)) if (/cat|value|data|id/i.test(name) && !/children|store|context/i.test(name)) {
            try { const json = JSON.stringify(value); if (json?.length < 15000) values.push({ name, value }); } catch {}
          }
        }
        return values;
      })(),
      sections: [...document.querySelectorAll('[id^="struct-"]')].map(node => ({ id: node.id, text: node.innerText?.slice(0, 500) })),
      custom: [...document.querySelectorAll('[id], [class]')].filter(node => /custom.*(?:attr|prop)|(?:attr|prop).*custom/i.test(`${node.id} ${node.className}`))
        .slice(0, 40).map(node => ({ id: node.id, html: node.outerHTML.slice(0, 22000) })),
      inputs: [...document.querySelectorAll('input,textarea')].map(node => ({ id: node.id, name: node.name, placeholder: node.placeholder, value: node.value, maxLength: node.maxLength })),
    }));
    report.pages.push({ itemId, ...state });
    if (process.env.QA_COLOR === '1') {
      const readColor = () => page.evaluate(() => ({
        html: document.querySelector('#struct-specification')?.outerHTML,
        values: window.GlobalStore?.engine?.getModels()?.formValues?.saleProp,
        selection: (() => {
          const root = document.getElementById('saleAttributesItems');
          const key = root && Object.keys(root).find(name => name.startsWith('__reactFiber'));
          const states = [];
          for (let fiber = root?.[key], depth = 0; fiber && depth < 12; fiber = fiber.return, depth++) {
            const props = fiber.memoizedProps || fiber.stateNode?.props;
            if (props?.id === 'saleAttributesItems') states.push({ value: props.value, dataSource: props.dataSource });
          }
          return states;
        })(),
      }));
      const color = { before: await readColor() };
      try {
        if (process.env.QA_COLOR_CLEAR === '1') color.cleared = await clearSaleAttributeSelections(page);
        color.ready = Boolean(await ensureColorSpecificationReady(page));
        if (color.ready) color.filled = await fillColorSpec(page, ['Black']);
      } catch (error) { color.error = { code: error.code, message: error.message }; }
      color.after = await readColor();
      report.pages.at(-1).colorInspection = color;
    }
    if (process.env.QA_FILL_FIELDS === '1') {
      const workspace = JSON.parse(fs.readFileSync(process.env.QA_WORKSPACE_FILE));
      const source = workspace.products.find(product => product.sourceId === process.env.QA_SOURCE_ID);
      assert.ok(source && source.publishResult?.url?.includes(itemId));
      const product = preparePublishProduct(source);
      const fields = { stages: [] };
      report.pages.at(-1).fieldInspection = fields;
      try {
        fields.result = await publisher.fillProductFields(page, product, stage => { fields.stages.push(stage); console.log(stage); });
        await requireCategoryAttributes(page, product);
        await requireCustomAttributes(page, product);
        fields.accepted = true;
        fields.saleValues = await page.evaluate(() => window.GlobalStore?.engine?.getModels()?.formValues?.saleProp);
      } catch (error) { fields.error = { code: error.code, message: error.message, diagnostics: error.diagnostics }; }
    }
    report.pages.at(-1).frames = [];
    for (const frame of page.frames()) report.pages.at(-1).frames.push({ url: frame.url(), text: (await frame.locator('body').innerText().catch(() => '')).slice(-18000) });
    // Exercise an unsaved row only. Never click save/publish on the existing listing.
    const add = page.locator('#customMoreProperty .add-attr-btn');
    if (await add.count() && process.env.QA_NEW_FORM !== '1') {
      await add.click();
      report.pages.at(-1).customEmptyRow = await page.locator('#customMoreProperty').evaluate(node => node.outerHTML);
      if (process.env.QA_FILL_CUSTOM === '1') {
        const workspace = JSON.parse(fs.readFileSync(path.join(output, 'original-workspace.json')));
        const product = workspace.products.find(p => p.publishResult?.url?.includes(itemId));
        assert.ok(product);
        report.pages.at(-1).customFilled = await fillCustomAttributes(page, product, fillAndVerify);
        report.pages.at(-1).customObserved = await readCustomAttributes(page);
      }
    }
    console.log(JSON.stringify({ itemId, title: state.title, sections: state.sections.map(s => s.id), custom: state.custom.map(s => s.id) }));
    await page.screenshot({ path: path.join(output, `${itemId}-before.png`) });
  }
  fs.writeFileSync(path.join(output, 'inspection.json'), JSON.stringify(report, null, 2));
  await Promise.race([Promise.allSettled(pending), new Promise(resolve => setTimeout(resolve, 3000))]);
} catch (error) { report.error = { code: error.code, message: error.message }; console.error(error.message); process.exitCode = 1; }
finally { fs.writeFileSync(path.join(output, 'inspection.json'), JSON.stringify(report, null, 2)); await publisher.shutdown(); }
