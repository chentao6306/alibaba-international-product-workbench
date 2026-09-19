// Run with Electron. Uses a COPY of a saved workspace and the production API.
// Draft is the default. Direct submission requires an explicit --submit flag.
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { SellerPublisher } from '../server/publisher.js';
import { readPostingAttributeSchema, sourceAttributeForField } from '../server/category-attributes.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';

const argument = (name, fallback = '') => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const desktop = argument('desktop', path.join(process.env.APPDATA, 'alibaba-international-product-workbench'));
const output = path.resolve(argument('output', 'D:/CodexBuildTemp/customer-workflow-1.4.28'));
const ids = argument('ids').split(',').filter(Boolean);
const account = argument('account');
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
  const original = SellerPublisher.prototype.publishProduct;
  SellerPublisher.prototype.publishProduct = async function (...args) {
    const [product, , mode] = args;
    const page = await this.currentSellerPage('', { showPublishing: true });
    if (!matchesAlibabaSession(await page.context().cookies(), account, page.url())) throw new Error('Seller account mismatch');
    const row = { sourceId: product.sourceId, categoryId: product.categoryId, mode, options: args[6], started: new Date().toISOString(), stages: [] };
    ledger.push(row); save();
    const progress = args[5];
    args[5] = (stage) => { row.stages.push({ stage, at: new Date().toISOString() }); save(); console.log(JSON.stringify({ id: product.sourceId, stage })); progress?.(stage); };
    try {
      row.result = await original.apply(this, args);
      return row.result;
    } catch (error) {
      row.error = { message: error.message, code: error.code, requiredFields: error.requiredFields };
      throw error;
    } finally {
      row.fields = await this.page?.evaluate(readPostingAttributeSchema).catch(() => []) || [];
      row.fields = row.fields.map((field) => ({ ...field, sourceValue: sourceAttributeForField(product, field)?.value }));
      await this.page?.screenshot({ path: path.join(output, `${product.sourceId}-${mode}.png`) }).catch(() => {});
      row.finished = new Date().toISOString(); save();
      console.log(JSON.stringify({ id: product.sourceId, result: row.result, error: row.error, required: row.fields.filter((field) => field.required) }));
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
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally { await server.shutdownServer(); }
}
main().then(() => app.exit(0), (error) => { console.error(error.message); app.exit(1); });
