// Inspect and exercise origin on an existing QA publication without saving it.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { SellerPublisher, fillOriginCountry } from '../server/publisher.js';
import { readPostingAttributeSchema } from '../server/category-attributes.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';

const root = process.env.QA_OUTPUT_DIR, id = process.env.QA_PUBLISHED_ID;
assert.ok(root && process.env.QA_EXPECTED_ACCOUNT && /^\d{10,16}$/.test(id));
fs.mkdirSync(root, { recursive: true });
const session = path.join(root, 'cookies.json');
writePrivateSession(session, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = session;
const publisher = new SellerPublisher(path.join(root, 'browser'));
const report = { publishedId: id, saved: false, steps: [], measurements: [] };
const save = () => fs.writeFileSync(path.join(root, 'origin-performance.json'), JSON.stringify(report, null, 2));
try {
  const page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  await page.goto(`https://post.alibaba.com/product/publish.htm?itemId=${id}&language=zh_CN`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('input#productTitle').waitFor({ timeout: 60000 });
  const capture = async () => {
    const fields = (await page.evaluate(readPostingAttributeSchema)).filter(field => /产地|origin/i.test(field.label));
    const rows = [];
    for (const field of fields) {
      if (!field.rowId) continue;
      rows.push(await page.locator(`[id="${field.rowId.replace(/["\\]/g, '')}"]`).evaluate(node => node.outerHTML));
    }
    return { fields, rows };
  };
  report.before = await capture(); save();
  if (process.env.QA_INSPECT_ONLY) {
    const field = page.locator('#struct-p-1 input').first();
    const models = () => field.evaluate(node => {
      const items = [];
      for (let current = node; current && current.id !== 'struct-p-1'; current = current.parentElement) {
        let fiber = current[Object.keys(current).find(key => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'))];
        for (let depth = 0; fiber && depth < 5; depth++, fiber = fiber.return) {
          const props = fiber.memoizedProps;
          if (props && typeof props === 'object') items.push({ keys: Object.keys(props), id: props.id, propertyName: props.name, label: props.label, uiType: props.uiType, value: props.value, defaultValue: props.defaultValue,
            dataSource: props.dataSource?.slice?.(0, 5), name: fiber.type?.name });
        }
      }
      return items;
    });
    report.modelBefore = await models();
    await field.click();
    await page.waitForTimeout(700);
    report.menus = await page.locator('.sell-o-select-options:visible, .next-select-popup:visible, [role="listbox"]:visible').evaluateAll(nodes => nodes.map(node => node.outerHTML));
    report.modelOpen = await models(); report.ok = true;
    save();
    await publisher.shutdown();
  } else {
  const proto = Object.getPrototypeOf(page.locator('body'));
  const originals = new Map();
  for (const method of ['evaluate', 'evaluateAll', 'waitFor', 'click', 'fill', 'inputValue', 'isVisible']) {
    const fn = proto[method]; originals.set(method, fn);
    proto[method] = async function(...args) {
      const began = performance.now();
      try { return await fn.apply(this, args); }
      finally {
        const ms = Math.round(performance.now() - began);
        if (ms >= 100) report.steps.push({ method, selector: this._selector, ms });
      }
    };
  }
  try {
    for (const country of (process.env.QA_ORIGIN_VALUES || 'China,China').split(',')) {
      const began = performance.now();
      const accepted = await fillOriginCountry(page, country);
      report.measurements.push({ country, accepted, ms: Math.round(performance.now() - began), state: await capture() }); save();
    }
  } finally { for (const [name, method] of originals) proto[name] = method; }
  report.after = await capture();
  report.ok = report.measurements.every(item => item.accepted);
  }
} catch (error) { report.error = { message: error.message, code: error.code, diagnostics: error.diagnostics }; process.exitCode = 1; }
finally { save(); await publisher.shutdown(); fs.rmSync(session, { force: true }); console.log(JSON.stringify({ ok: report.ok, measurements: report.measurements, error: report.error })); }
