import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { JsonStore } from '../server/store.js';
import { SecureSettings } from '../server/secure-settings.js';
import { syncProductModel, verifySourceIntegrity } from '../server/product-model.js';

test('processing settings persist without exposing secrets and processing excludes concurrent publishing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'processing-api-'));
  process.env.DATA_DIR = root;
  process.env.PORT = '0';
  const encryptionKey = crypto.randomBytes(32);
  const encryption = {
    encrypt(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
      const data = Buffer.concat([cipher.update(value), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decrypt(value) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString();
    },
  };
  globalThis.__KUA_YIPU_SECURE_STORAGE = encryption;
  const store = new JsonStore(path.join(root, 'workspace.json'));
  store.update((state) => {
    state.products = [syncProductModel({ id: 'target', sourceId: '12345', sourcePlatform: '1688', title: '不锈钢杯 500ml', price: 70, currencySymbol: '¥', status: 'ready', mainImages: ['https://cbu01.alicdn.com/product.jpg'] }, { captureSource: true })];
  });
  const server = await import('../server/index.js');
  const listener = await server.serverReady;
  const originalFetch = globalThis.fetch;
  let finishTranslation;
  const translating = new Promise((resolve) => { finishTranslation = resolve; });
  let translationStarted;
  const started = new Promise((resolve) => { translationStarted = resolve; });
  globalThis.fetch = (url, options) => {
    if (url === 'https://api.deepseek.com/chat/completions') {
      assert.equal(options.headers.authorization, 'Bearer sk-private-api-fixture');
      translationStarted();
      return translating;
    }
    return originalFetch(url, options);
  };
  const request = async (route, body, method = 'POST') => {
    const response = await originalFetch(`http://127.0.0.1:${listener.address().port}${route}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  try {
    const config = { translateTitle: true, convertCurrency: true, usdRates: { CNY: 0.14 }, deepseekModel: 'deepseek-flash' };
    const saved = await request('/api/settings/processing', { ...config, apiKey: 'sk-private-api-fixture' }, 'PATCH');
    assert.equal(saved.status, 200);
    assert.equal(saved.data.apiKeyConfigured, true);
    assert.equal(JSON.stringify(saved).includes('sk-private-api-fixture'), false);
    assert.equal(fs.readFileSync(path.join(root, 'workspace.json'), 'utf8').includes('sk-private-api-fixture'), false);
    assert.equal(new SecureSettings(root, encryption).key(), 'sk-private-api-fixture');
    await request('/api/settings/processing', config, 'PATCH');
    assert.deepEqual((await request('/api/settings/processing', null, 'GET')).data, { ...config, apiKeyConfigured: true });
    assert.equal((await request('/api/state', null, 'GET')).data.settings.marketplaceProcessing.translateTitle, true);
    const first = request('/api/products/process', { id: 'target' });
    await started;
    assert.equal((await request('/api/products/process', { id: 'target' })).status, 409);
    assert.equal((await request('/api/products/process', { id: 'target' })).status, 409);
    assert.equal((await request('/api/publish', { ids: ['target'] })).status, 409);
    finishTranslation(Response.json({ choices: [{ message: { content: '{"title":"Stainless Steel Cup 500ml"}' } }] }));
    assert.equal((await first).status, 200);
    const product = new JsonStore(path.join(root, 'workspace.json')).read().products[0];
    assert.equal(product.title, 'Stainless Steel Cup 500ml');
    assert.equal(Number(product.price), 9.8);
    assert.equal(product.currencySymbol, '$');
    assert.equal(verifySourceIntegrity(product).valid, true);
    await request('/api/products/process', { id: 'target' });
    assert.equal(Number(new JsonStore(path.join(root, 'workspace.json')).read().products[0].price), 9.8);
    await request('/api/settings/processing', { ...config, apiKey: '' }, 'PATCH');
    assert.equal((await request('/api/settings/processing', null, 'GET')).data.apiKeyConfigured, false);
  } finally {
    finishTranslation(Response.json({}));
    globalThis.fetch = originalFetch;
    await server.shutdownServer();
    delete globalThis.__KUA_YIPU_SECURE_STORAGE;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
