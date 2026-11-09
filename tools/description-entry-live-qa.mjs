// Inspect real detail-editor entrances without saving changes or overriding flags.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SellerPublisher } from '../server/publisher.js';
import { revealDescriptionSection } from '../server/posting-readiness.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';

const output = process.env.QA_OUTPUT_DIR;
assert.ok(output && !fs.existsSync(output) && process.env.QA_DESKTOP_USER_DATA_DIR && process.env.QA_EXPECTED_ACCOUNT);
fs.mkdirSync(output, { recursive: true });
const cookies = path.join(output, 'session.json');
writePrivateSession(cookies, readPrivateSession(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = cookies;
const publisher = new SellerPublisher(path.join(output, 'browser'));
const report = { saved: false, flagsOverridden: false, pages: [] };
const snapshot = async (page, label) => {
  const result = await page.evaluate(() => {
    const visible = node => !!node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
    return {
      url: location.origin + location.pathname,
      switches: Object.fromEntries(Object.entries(window.Json?.models?.global?.globalSwitcher || {}).filter(([key]) => /detail|desc|decorat/i.test(key))),
      components: Object.keys(window.Json?.components || {}).filter(key => /desc|detail|editor/i.test(key)),
      entrances: [...document.querySelectorAll('a,button,[role="button"],.item-label')].filter(visible)
        .map(node => ({ text: node.innerText?.trim(), href: node.href })).filter(node => node.text && /新版|旧版|升级|结构化|商详|编辑|产品管理|发布产品|发布商品/.test(node.text) && node.text.length < 250),
      detailText: document.querySelector('#struct-desc-card')?.innerText,
      detailFields: Object.fromEntries(['descUpgrade', 'simpleDescUpgrade', 'textDesc', 'detailImage', 'magicEditor', 'productDescType', 'packagingDesc'].map(id => [id, window.Json?.components?.[id]?.props])),
      inputs: [...document.querySelectorAll('input,textarea')].map(n => ({ id: n.id, name: n.name, placeholder: n.placeholder, type: n.type, visible: visible(n) })),
      detailHtml: [...document.querySelectorAll('#struct-desc-card, #detail-product-card, #struct-textDesc, #struct-detailImage, #struct-logistics')].map(n => ({ id: n.id, html: n.outerHTML })),
      body: document.body.innerText.slice(-26000),
    };
  });
  result.label = label;
  result.frames = [];
  for (const frame of page.frames()) if (frame !== page.mainFrame()) result.frames.push({ url: frame.url().split('?')[0], text: (await frame.locator('body').innerText().catch(() => '')).slice(0, 18000) });
  await page.screenshot({ path: path.join(output, `${label}.png`), fullPage: false });
  report.pages.push(result);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ label, components: result.components, entrances: result.entrances, frames: result.frames.map(f => f.url) }));
};
try {
  const page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  const cases = [
    ...(process.env.QA_NEW_ONLY === '1' ? [] : [['existing', 'https://post.alibaba.com/product/publish.htm?itemId=1601985253611&language=zh_CN']]),
    ['new-phone', 'https://post.alibaba.com/product/publish.htm?catId=201905202&language=zh_CN'],
    ['new-parts', 'https://post.alibaba.com/product/publish.htm?catId=1355&language=zh_CN'],
  ];
  if (process.env.QA_CATEGORY_ID) {
    assert.match(process.env.QA_CATEGORY_ID, /^\d+$/);
    cases.splice(0, cases.length, ['selected-category', `https://post.alibaba.com/product/publish.htm?catId=${process.env.QA_CATEGORY_ID}&language=zh_CN`]);
  }
  for (const [name, url] of cases.filter(([name]) => !process.env.QA_EDITOR_CASE || name === process.env.QA_EDITOR_CASE)) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('input#productTitle').waitFor({ timeout: 45000 });
    await revealDescriptionSection(page);
    await page.waitForTimeout(2000);
    await snapshot(page, name);
    if (process.env.QA_OPEN_STRUCTURED_LAYOUT === '1') {
      const notice = page.getByRole('button', { name: '我知道了', exact: true });
      if (await notice.count() && await notice.first().isVisible()) await notice.first().click();
      const layout = page.getByText('详描通用排版', { exact: true });
      if (await layout.count() && await layout.first().isVisible()) {
        await layout.first().click();
        await page.waitForTimeout(4000);
        await snapshot(page, name + '-structured-layout');
        if (process.env.QA_GENERATE_FREE_LAYOUT === '1') {
          const free = page.getByText('通用排版', { exact: true });
          await free.click();
          await page.getByRole('button', { name: '开始生成', exact: true }).click();
          await page.waitForTimeout(6000);
          await snapshot(page, name + '-free-layout-open');
          if (process.env.QA_OPEN_FREE_LAYOUT_EDITOR === '1') {
            const editor = page.frames().find(frame => /siteadmin\.alibaba\.com\/detail\/decorate\.htm/.test(frame.url()));
            assert.ok(editor);
            await editor.getByText(/^(?:Page loading, please wait|页面加载中.*)$/).waitFor({ state: 'hidden', timeout: 60000 });
            await editor.locator('.preview-container, .editor-content, [contenteditable="true"]').first().waitFor({ timeout: 30000 }).catch(() => {});
            await editor.getByRole('button', { name: /Confirm the application and go to Edit|确认应用.*编辑/ }).click();
            const confirm = editor.getByRole('button', { name: /^(?:Confirmation of application|确认应用)$/ });
            await confirm.waitFor({ state: 'visible', timeout: 8000 });
            await confirm.click();
            await editor.getByRole('button', { name: /^(?:Editing completed|编辑完成)$/ }).waitFor({ timeout: 45000 });
            await snapshot(page, name + '-free-layout-edit');
            if (process.env.QA_INSPECT_TEXT_MODULE === '1') {
              await editor.getByText('Text', { exact: true }).click();
              await page.waitForTimeout(1000);
              await snapshot(page, name + '-text-menu');
            }
            fs.writeFileSync(path.join(output, `${name}-editor.html`), await editor.content());
            fs.writeFileSync(path.join(output, `${name}-editor-metadata.json`), JSON.stringify(await editor.evaluate(() => ({
              controls: [...document.querySelectorAll('button,a,input,textarea,[contenteditable]')].map(n => ({ tag: n.tagName, text: n.innerText?.slice(0, 150), placeholder: n.placeholder, id: n.id, cls: n.className })),
              config: window.__editorConfig,
              dataKeys: Object.keys(window.data || {}), globalKeys: Object.keys(window.globalData || {}), libKeys: Object.keys(window.IcbuDetailEditorLib || {}),
            })), null, 2));
          }
        }
        for (const [index, frame] of page.frames().entries()) if (frame !== page.mainFrame() && !/store-proxy|about:blank/.test(frame.url())) {
          fs.writeFileSync(path.join(output, `${name}-layout-${index}.html`), await frame.content());
          fs.writeFileSync(path.join(output, `${name}-layout-${index}-metadata.json`), JSON.stringify(await frame.evaluate(() => ({
            scripts: [...document.scripts].map(s => s.src).filter(Boolean),
            globals: Object.keys(window).filter(k => /data|config|store|editor/i.test(k)),
            controls: [...document.querySelectorAll('button,a,input,textarea')].map(n => ({tag:n.tagName,text:n.innerText,placeholder:n.placeholder,id:n.id})),
          })), null, 2));
        }
      }
    }
    const smart = page.locator('#productDescType .item-label').filter({ hasText: /^智能编辑$/ });
    if (await smart.isVisible()) {
      await smart.click();
      await page.waitForTimeout(3000);
      await snapshot(page, name + '-smart');
      const switchNotice = page.locator('.next-dialog').filter({ hasText: '保存提交后将会丢失普通编辑中的内容' });
      if (await switchNotice.count() && await switchNotice.first().isVisible()) {
        // These unsaved tabs are discarded. Never save the mode switch.
        await switchNotice.first().getByRole('button', { name: '切换', exact: true }).click();
        await page.waitForTimeout(1000);
      }
      const edit = page.getByText('我要编辑', { exact: true });
      if (await edit.count() && await edit.first().isVisible()) {
        await edit.first().click();
        await page.waitForTimeout(5000);
        await snapshot(page, name + '-smart-open');
      }
    }
  }
} catch (error) {
  if (publisher.page && !publisher.page.isClosed()) await snapshot(publisher.page, 'probe-error').catch(() => {});
  report.error = { code: error.code, message: error.message };
  process.exitCode = 1;
  console.error(error.message);
} finally {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await publisher.shutdown();
}
