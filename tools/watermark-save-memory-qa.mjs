import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A disposable large workspace, real image APIs and a 256 MB JS heap. Never
// opens seller pages or reads/mutates the user's workspace.
if (process.argv[2] !== '--child') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watermark-save-memory-'));
  const code = path.resolve(process.env.QA_SOURCE_DIR || '.');
  for (const scope of ['mainImages', 'detailImages', 'both']) {
    const result = spawnSync(process.execPath, ['--max-old-space-size=256', fileURLToPath(import.meta.url), '--child', code, path.join(root, scope), scope],
      { encoding: 'utf8', windowsHide: true, timeout: 180000 });
    fs.writeFileSync(path.join(root, scope + '.log'), (result.stdout || '') + (result.stderr || ''));
    assert.equal(result.status, 0, `${scope} failed; inspect ${root}`);
    console.log(result.stdout.trim());
  }
  console.log(JSON.stringify({ ok: true, root }));
} else {
  const [code, root, scope] = process.argv.slice(3);
  fs.mkdirSync(root, { recursive: true });
  const { JsonStore } = await import(pathToFileURL(path.join(code, 'server/store.js')));
  const { registerProductImageApi } = await import(pathToFileURL(path.join(code, 'server/product-image-api.js')));
  const { syncProductModel, verifySourceIntegrity } = await import(pathToFileURL(path.join(code, 'server/product-model.js')));
  const { default: express } = await import('express');
  const file = path.join(root, 'workspace.json'), mediaDir = path.join(root, 'media');
  fs.mkdirSync(mediaDir);
  fs.writeFileSync(path.join(mediaDir, 'marked.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64'));
  const descriptor = fs.openSync(file, 'w');
  fs.writeSync(descriptor, '{"products":[');
  for (let i = 0; i < 451; i++) {
    const product = syncProductModel({ id: String(i), title: `Fixture ${i}`, sourcePlatform: 'alibaba.com', categoryId: '201346401',
      mainImages: ['https://example.com/a.jpg'], detailImages: ['https://example.com/d.jpg'],
      descriptionHtml: `<p>${String(i).padStart(4, '0')}${'x'.repeat(24000)}</p><img src="https://example.com/d.jpg">`, price: 5, origin: 'China' });
    product.auditTrail = Array.from({ length: 2 }, (_, j) => ({ id: `old-${j}`, fields: ['title'], before: { ...product.working }, after: { ...product.working } }));
    fs.writeSync(descriptor, (i ? ',' : '') + JSON.stringify(product));
  }
  fs.writeSync(descriptor, '],"jobs":[],"settings":{},"shops":[],"groups":[],"collectionFolders":[]}');
  fs.closeSync(descriptor);
  const initialBytes = fs.statSync(file).size;
  const store = new JsonStore(file), app = express();
  app.use(express.json({ limit: '12mb' })); registerProductImageApi(app, { store, mediaDir });
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
  const call = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  const started = Date.now();
  try {
    let saved = 0;
    for (let i = 0; i < 451; i += 25) {
      const items = await call('products/image-drafts', { ids: Array.from({ length: Math.min(25, 451 - i) }, (_, n) => String(i + n)) });
      for (const product of items) for (const key of ['mainImages', 'detailImages']) if (scope === 'both' || scope === key) product[key] = ['/media/marked.png'];
      const result = await call('products/save-images', { items, partial: true });
      saved += result.updated; assert.equal(result.failures.length, 0);
    }
    assert.equal(saved, 451);
    for (let i = 0; i < 451; i++) {
      const product = store.read(state => state.products[i]);
      assert.equal(verifySourceIntegrity(product).valid, true);
      assert.equal(product.auditTrail.length, 3);
      assert.equal(product.mainImages[0], scope === 'detailImages' ? 'https://example.com/a.jpg' : '/media/marked.png');
      assert.equal(product.detailImages[0], scope === 'mainImages' ? 'https://example.com/d.jpg' : '/media/marked.png');
      if (scope === 'mainImages') assert.equal(product.descriptionHtml, product.source.snapshot.descriptionHtml);
      else assert.match(product.descriptionHtml, /src="\/media\/marked.png"/);
    }
    console.log(JSON.stringify({ scope, saved, initialBytes, finalBytes: fs.statSync(file).size, milliseconds: Date.now() - started, memory: process.memoryUsage() }));
  } finally { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
}
