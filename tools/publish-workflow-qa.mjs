// Run with Electron. Uses a COPY of a saved workspace and the production API.
// Draft is the default. Direct submission requires an explicit --submit flag.
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { SellerPublisher } from '../server/publisher.js';
import { readPostingAttributeSchema, sourceAttributeForField } from '../server/category-attributes.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
import assert from 'node:assert/strict';
import { recordProductMutation } from '../server/product-model.js';
import { SKU_PRICE_INPUT } from '../server/sku-reference.js';

const argument = (name, fallback = '') => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const desktop = argument('desktop', path.join(process.env.APPDATA, 'alibaba-international-product-workbench'));
const output = path.resolve(argument('output', 'D:/CodexBuildTemp/customer-workflow-1.4.29'));
const ids = argument('ids').split(',').filter(Boolean);
const account = argument('account');
const distinctPrices = process.argv.includes('--distinct-prices');
if (distinctPrices && process.argv.includes('--submit')) throw new Error('Synthetic price QA is draft-only.');
if (!ids.length || !account) throw new Error('Provide --ids=sourceId,... and --account=sellerId');
if (output.toLowerCase().startsWith(path.resolve(desktop).toLowerCase())) throw new Error('QA output must be separate from the installed workspace');
fs.mkdirSync(path.join(output, 'electron'), { recursive: true });
fs.copyFileSync(path.join(desktop, 'Local State'), path.join(output, 'electron/Local State'));
app.setPath('userData', path.join(output, 'electron'));
app.on('window-all-closed', () => {});

async function main() {
  await app.whenReady();
  globalThis.__KUA_YIPU_SECURE_STORAGE = { decrypt: (value) => safeStorage.decryptString(value) };
  process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = path.join(desktop, 'alibaba-cookies.json');
  process.env.DATA_DIR = path.join(output, 'workspace');
  process.env.PORT = '0';
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
  const source = JSON.parse(fs.readFileSync(path.join(desktop, '.data/workspace.json'), 'utf8'));
  const products = ids.map((id) => {
    const product = source.products.find((item) => item.sourceId === id);
    if (!product) throw new Error(`Source product not found: ${id}`);
    return { ...product, collectionFolderId: 'workflow-qa' };
  });
  if (distinctPrices) for (const product of products) {
    if (product.skus?.length !== 3 || product.skus.some((sku) => sku.enabled === false)) throw new Error('Price QA requires exactly three enabled SKUs.');
    recordProductMutation(product, {
      priceMode: 'sku',
      skus: product.skus.map((sku, index) => ({ ...sku, price: (6.7 + index / 10).toFixed(2) })),
    }, { action: 'qa-distinct-prices' });
  }
  // Watermark outputs and uploaded descriptions use local /media URLs. A
  // workspace-only copy would turn valid customer images into missing files.
  const media = path.join(process.env.DATA_DIR, 'media');
  fs.mkdirSync(media, { recursive: true });
  for (const match of JSON.stringify(products).matchAll(/\/media\/([a-zA-Z0-9_.-]+)/g)) {
    const file = path.join(desktop, '.data', 'media', match[1]);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) fs.copyFileSync(file, path.join(media, match[1]));
  }
  const ledgerFile = path.join(output, 'ledger.json');
  const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) : [];
  const submit = process.argv.includes('--submit');
  if (submit && ids.some((id) => !ledger.some((row) => row.sourceId === id && row.mode === 'draft' && row.result?.status === 'drafted'))) {
    throw new Error('Every product must pass a real draft in this ledger before direct submission.');
  }
  if (submit && ledger.some((row) => ids.includes(row.sourceId) && row.mode === 'submit')) {
    throw new Error('This ledger already contains a submission attempt. Reconcile its receipt before retrying.');
  }
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'workspace.json'), JSON.stringify({
    ...source, jobs: [], shops: [], groups: [], products,
    collectionFolders: [{ id: 'workflow-qa', name: 'QA' }],
  }));
  const save = () => fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
  let priceReadback = null;
  if (distinctPrices) {
    const reconcile = SellerPublisher.prototype.reconcileMainImages;
    SellerPublisher.prototype.reconcileMainImages = async function (page, product, ...args) {
      const result = await reconcile.call(this, page, product, ...args);
      const prices = await page.locator(`#sku ${SKU_PRICE_INPUT.split(', ').join(', #sku ')}`).filter({ visible: true }).evaluateAll((inputs) => inputs.map((input) => Number(input.value)));
      assert.deepEqual([...prices].sort((a, b) => a - b), [6.7, 6.8, 6.9], 'Real posting page must retain three different SKU prices before saving');
      priceReadback = prices;
      return result;
    };
  }
  const original = SellerPublisher.prototype.publishProduct;
  SellerPublisher.prototype.publishProduct = async function (...args) {
    const [product, , mode] = args;
    const page = await this.currentSellerPage('', { backgroundPublishing: true });
    if (!matchesAlibabaSession(await page.context().cookies(), account, page.url())) throw new Error('Seller account mismatch');
    const row = { sourceId: product.sourceId, categoryId: product.categoryId, mode, options: args[6], started: new Date().toISOString(), stages: [] };
    ledger.push(row); save();
    const progress = args[5];
    args[5] = (stage) => { row.stages.push({ stage, at: new Date().toISOString() }); save(); console.log(JSON.stringify({ id: product.sourceId, stage })); progress?.(stage); };
    try {
      row.result = await original.apply(this, args);
      if (distinctPrices) { assert.ok(priceReadback, 'Missing price readback'); row.priceReadback = priceReadback; }
      return row.result;
    } catch (error) {
      row.error = { message: error.message, code: error.code, requiredFields: error.requiredFields };
      throw error;
    } finally {
      row.fields = await this.page?.evaluate(readPostingAttributeSchema).catch(() => []) || [];
      row.fields = row.fields.map((field) => ({ ...field, sourceValue: sourceAttributeForField(product, field)?.value }));
      row.specification = await this.page?.locator('#struct-specification').evaluate((node) => ({
        text: node.innerText,
        colors: [...node.querySelectorAll('input[role="colorCombobox"]')].map((input) => ({
          value: input.value,
          html: input.closest('.posting-feild-color-item, .posting-field-color-item, .posting-feild-color-item-container')?.outerHTML,
        })),
      })).catch(() => null);
      await this.page?.screenshot({ path: path.join(output, `${product.sourceId}-${mode}.png`) }).catch(() => {});
      row.finished = new Date().toISOString(); save();
      console.log(JSON.stringify({ id: product.sourceId, result: row.result, error: row.error }));
    }
  };
  const server = await import('../server/index.js');
  const listener = await server.serverReady;
  const base = `http://127.0.0.1:${listener.address().port}`;
  try {
    const response = await fetch(base + '/api/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      ids: products.map((product) => product.id), collectionFolderId: 'workflow-qa',
      mode: submit ? 'submit' : 'draft', listingMode: argument('listing-mode', 'inquiry'),
    }) });
    const job = await response.json();
    if (!response.ok) throw new Error(job.message || job.error);
    let lastMessage = '';
    for (;;) {
      const state = await fetch(base + '/api/state').then((response) => response.json());
      const current = state.jobs.find((item) => item.id === job.id);
      if (lastMessage !== current.message) { console.log(current.message); lastMessage = current.message; }
      if (['completed', 'failed', 'paused', 'cancelled'].includes(current.status)) {
        fs.writeFileSync(path.join(output, 'job-result.json'), JSON.stringify({ job: current, products: state.products.map((product) => ({ sourceId: product.sourceId, status: product.status, sourceIntegrity: product.sourceIntegrity, result: product.publishResult })) }, null, 2));
        const outcomes = state.products.filter((product) => ids.includes(product.sourceId));
        if (outcomes.length !== ids.length || outcomes.some((product) => product.status !== (submit ? 'published' : 'drafted'))) throw new Error('Real posting QA did not receive a successful receipt for every product; inspect job-result.json');
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally { await server.shutdownServer(); }
}
main().then(() => app.exit(0), (error) => { console.error(error.message); app.exit(1); });
