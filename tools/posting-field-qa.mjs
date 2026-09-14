import fs from 'node:fs';
import path from 'node:path';
import { SellerPublisher, fillAndVerify, alibabaKeywordText } from '../server/publisher.js';
import { buildAlibabaPublishUrl, productCategory } from '../server/category-routing.js';

const output = process.env.QA_OUTPUT_DIR;
if (!output || !process.env.QA_PRODUCT_FILE) throw new Error('Set QA_OUTPUT_DIR and QA_PRODUCT_FILE');
fs.mkdirSync(output, { recursive: true });
const imported = JSON.parse(fs.readFileSync(process.env.QA_PRODUCT_FILE, 'utf8'));
const product = imported.product || imported;
const publisher = new SellerPublisher(output);
const report = { fields: [] };
let page;
try {
  page = await publisher.currentSellerPage();
  await page.goto(buildAlibabaPublishUrl(productCategory(product).id), { waitUntil: 'domcontentloaded', timeout: 45000 });
  const title = page.locator('input#productTitle');
  await title.waitFor({ timeout: 30000 });
  for (const text of [product.title, 'T-MOTOR MN1315 KV100: 50kg Max Thrust, Powering 130kg Heavy-Lift Multirotor UAV', 'Hobbywing H15 Plus Coaxial 145kg Thrust 18 28S Powertrain Manned Aircraft EVTOL,heavy Lift Professional Drone Propulsion System']) {
    let error = '';
    try { await fillAndVerify(title, text, '商品标题'); } catch (failure) { error = failure.message; }
    report.fields.push({ text, error, actual: await title.inputValue(), html: await title.evaluate((node) => node.outerHTML) });
  }
  const keywords = page.locator('.posting-field-keywords textarea:visible').first();
  report.keywordFields = [];
  for (const keywordTitle of ['Drone Accessories UC2070, Drone Carbon Fiber Propeller Blades', report.fields[1].text]) {
    await fillAndVerify(keywords, alibabaKeywordText({ title: keywordTitle, keywords: [] }), '商品关键词');
    report.keywordFields.push({ title: keywordTitle, value: await keywords.inputValue(), context: await keywords.evaluate((node) => node.closest('.posting-field-keywords')?.parentElement?.textContent) });
  }
  report.validators = await page.locator('input#productTitle, .posting-field-keywords textarea').evaluateAll((nodes) => nodes.map((node) => {
    const key = Object.getOwnPropertyNames(node).find((key) => key.startsWith('__reactProps'));
    return { id: node.id, value: node.value, illegalpatterns: node[key]?.illegalpatterns, message: node.getAttribute('message'), context: node.closest('.posting-field')?.textContent };
  }));
  if (process.env.QA_FIELDS_ONLY === '1') {
    console.log(JSON.stringify({ fields: report.fields, validators: report.validators, keywordFields: report.keywordFields }));
  } else {
    if (process.env.QA_FAIL_MAIN_UPLOAD === '1') {
      let failed = false;
      await page.route('https://filebroker.alibaba.com/t/upload**', async (route) => {
        if (!failed) { failed = true; report.injectedFailure = true; await route.abort('connectionreset'); }
        else await route.continue();
      });
    }
    if (process.env.QA_INSPECT_MAIN_FAILURE === '1') publisher.waitForMainImageUploads = async () => {
      await page.waitForTimeout(4000);
      throw new Error('QA inspect upload state');
    };
    try { report.mainImages = await publisher.uploadMainImages(page, product); }
    catch (error) { report.uploadError = error.stack; }
    await page.locator('.image-uploader .image-upload-list-item').first().hover().catch(() => {});
    await page.waitForTimeout(500);
    report.slots = await page.locator('.image-uploader .image-upload-list-item').evaluateAll((nodes) => nodes.map((node) => {
      const components = [];
      const key = Object.getOwnPropertyNames(node).find((key) => key.startsWith('__reactFiber'));
      let fiber = key && node[key];
      for (let i = 0; fiber && i < 20; i++, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        const summarize = (file) => file && Object.fromEntries(Object.entries(file).filter(([key]) => !['thumbUrl', 'originFileObj'].includes(key)));
        if (props) components.push({ name: fiber.type?.name, keys: Object.keys(props), file: summarize(props.file), fileList: props.fileList?.map(summarize), onRemove: String(props.onRemove || ''), onSort: String(props.onSort || ''), onFileListChange: String(props.onFileListChange || '') });
      }
      return { html: node.outerHTML, components };
    }));
    console.log(JSON.stringify({ output, fields: report.fields, mainImages: report.mainImages, uploadError: report.uploadError }));
  }
  if (report.fields.some((field) => field.error) || report.uploadError) process.exitCode = 1;
} catch (error) { report.error = error.stack; console.error(error.message); process.exitCode = 1; }
finally {
  if (page) await page.screenshot({ path: path.join(output, 'posting.png') }).catch(() => {});
  fs.writeFileSync(path.join(output, 'posting.json'), JSON.stringify(report, null, 2));
  await publisher.shutdown();
}
