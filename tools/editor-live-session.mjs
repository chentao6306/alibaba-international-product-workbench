import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { SellerPublisher } from '../server/publisher.js';
import { buildAlibabaPublishUrl, productCategory } from '../server/category-routing.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
import { readPostingAttributeSchema } from '../server/category-attributes.js';

// Interactive QA control stays on loopback. Credentials exist only in the
// login request; reports never include form values or session cookies.
const output = process.env.QA_OUTPUT_DIR;
const workspace = process.env.QA_WORKSPACE_DIR;
const expectedAccount = process.env.QA_EXPECTED_ACCOUNT;
if (!output || !workspace || !expectedAccount) throw new Error('QA output, workspace and expected account are required');
fs.mkdirSync(output, { recursive: true });
const publisher = new SellerPublisher(output);
await publisher.currentSellerPage('', { showPublishing: true });
const token = crypto.randomBytes(24).toString('hex');
const reportFile = path.join(output, 'publish-results.json');
const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile)) : { items: {} };
let running = false, progress = '';
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
const server = http.createServer(async (request, response) => {
  const send = (status, data) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); };
  if (request.headers.authorization !== `Bearer ${token}` || request.headers.origin) return send(403, { error: 'Forbidden' });
  try {
    const chunks = [];
    for await (const chunk of request) { chunks.push(chunk); if (Buffer.concat(chunks).length > 16384) throw new Error('Request too large'); }
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    const page = publisher.page;
    if (request.url === '/status') {
      const frames = [];
      for (const frame of page.frames()) frames.push({ url: frame.url(), inputs: await frame.locator('input').evaluateAll((nodes) => nodes.map((node) => ({ id: node.id, name: node.name, type: node.type, placeholder: node.placeholder, visible: Boolean(node.getClientRects().length) }))).catch(() => []) });
      return send(200, { url: page.url(), title: await page.title(), text: (await page.locator('body').innerText()).slice(0, 7000), frames, running, progress, report });
    }
    if (request.url === '/screenshot') { await page.screenshot({ path: path.join(output, 'current.png') }); return send(200, { path: path.join(output, 'current.png') }); }
    if (request.url === '/posting-state') {
      if (!/^https:\/\/post\.alibaba\.com\/product\//.test(page.url())) throw new Error('Expected a product posting form');
      return send(200, { fields: await page.evaluate(readPostingAttributeSchema),
        controls: await page.locator('button:visible, [role="dialog"]:visible, .next-overlay-wrapper.opened:visible').evaluateAll((nodes) => nodes.map((node) => ({ text: node.innerText, html: node.outerHTML.slice(0, 5000) }))) });
    }
    if (running) return send(409, { error: 'Publishing is running' });
    if (request.url === '/open') { await page.goto(body.url, { waitUntil: 'domcontentloaded', timeout: 45000 }); return send(200, { url: page.url() }); }
    if (request.url === '/fill' || request.url === '/click') {
      const frame = body.frameUrl ? page.frames().find((item) => item.url() === body.frameUrl) : page.mainFrame();
      if (!frame || !/(^|\.)alibaba\.com$/.test(new URL(frame.url()).hostname)) throw new Error('Expected an Alibaba form');
      if (request.url === '/fill') await frame.locator(body.selector).fill(body.value, { timeout: 10000 });
      else await frame.locator(body.selector).click({ timeout: 10000 });
      return send(200, { ok: true });
    }
    if (request.url === '/publish') {
      if (!['draft', 'submit'].includes(body.mode)) throw new Error('Unsupported mode');
      if (!matchesAlibabaSession(await page.context().cookies(), expectedAccount, page.url())) throw new Error('The seller account has not been verified');
      const state = JSON.parse(fs.readFileSync(path.join(workspace, 'workspace.json')));
      const product = state.products.find((item) => item.id === body.id);
      if (!product || product.status !== 'publish_failed') throw new Error('Only the selected failed product can be tested');
      const item = report.items[body.id] ||= { sourceId: product.sourceId };
      if (body.mode === 'submit' && (!item.draft?.result || item.submit)) throw new Error('A successful draft is required, and a submission must not be repeated');
      let publishUrl = buildAlibabaPublishUrl(productCategory(product).id);
      if (body.draftUrl) {
        const url = new URL(body.draftUrl);
        if (body.mode !== 'submit' || url.origin !== 'https://post.alibaba.com' || url.pathname !== '/product/publish.htm'
          || !/^\d+$/.test(url.searchParams.get('itemId')) || url.searchParams.get('pubAction') !== 'draft') throw new Error('Expected the verified draft URL');
        publishUrl = url.href;
      }
      const result = item[body.mode] = { startedAt: new Date().toISOString() }; save();
      running = true;
      send(202, { started: true });
      try {
        const category = productCategory(product);
        result.result = await publisher.publishProduct(product, publishUrl, body.mode, category.pathText, 'editor-live-qa', (message) => { progress = message; }, { listingMode: state.settings.listingMode || 'auto', sellerGroup: product.sellerGroup });
        if (body.mode === 'draft') {
          await page.waitForURL(/itemId=\d+/, { timeout: 10000 }).catch(() => {});
          result.editorUrl = page.url();
        }
      } catch (error) { result.error = error.message; result.code = error.code; result.diagnostics = error.diagnostics; }
      finally { result.finishedAt = new Date().toISOString(); running = false; save(); }
      return;
    }
    if (request.url === '/close') { send(200, { ok: true }); await publisher.shutdown(); server.close(); return; }
    send(404, { error: 'Unknown command' });
  } catch (error) { send(400, { error: error.message }); }
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(path.join(output, 'control.json'), JSON.stringify({ port: server.address().port, token }));
  console.log('Interactive QA browser is ready');
});
