// Exercise mouse focus and keyboard events in Electron using disposable products.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.versions.electron) {
  const { app } = await import('electron');
  app.setPath('userData', path.join(process.env.QA_BATCH_INPUT_ROOT, 'profile'));
  app.whenReady().then(async () => {
    const { createAppWindow } = await import('../electron/window-branding.js');
    process.env.DATA_DIR = path.join(process.env.QA_BATCH_INPUT_ROOT, 'data');
    process.env.PORT = '0';
    delete process.env.KUA_YIPU_DESKTOP;
    const server = await import('../server/index.js');
    const { JsonStore } = await import('../server/store.js');
    const { syncProductModel } = await import('../server/product-model.js');
    const { default: sharp } = await import('sharp');
    const listener = await server.serverReady;
    await sharp({ create: { width: 480, height: 360, channels: 3, background: '#147b7c' } }).png().toFile(path.join(process.env.DATA_DIR, 'media', 'sample.png'));
    await sharp({ create: { width: 100, height: 60, channels: 4, background: '#ed6432' } }).png().toFile(path.join(process.env.DATA_DIR, 'media', 'logo.png'));
    const store = new JsonStore(path.join(process.env.DATA_DIR, 'workspace.json'));
    store.update(s => {
      s.collectionFolders = ['first', 'second'].map(id => ({ id, name: id }));
      s.settings.activeCollectionFolderId = 'first';
      s.products = s.collectionFolders.flatMap(folder => Array.from({ length: 14 }, (_, i) => syncProductModel({
        id: `${folder.id}-${i}`, sourceId: `${folder.id}-${i}`, title: `${folder.id} 商品 ${i}`, selected: true,
        collectionFolderId: folder.id, sourcePlatform: 'alibaba.com', status: 'ready', price: 10,
        mainImages: ['/media/sample.png'], detailImages: ['/media/sample.png'],
      })));
    });
    const window = createAppWindow({ width: 1440, height: 1000, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await window.loadURL(`http://127.0.0.1:${listener.address().port}/`);
    app.on('window-all-closed', () => app.quit());
  }).catch(error => { console.error(error); app.exit(1); });
} else {
  const { _electron } = await import('playwright-core');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-input-desktop-'));
  const errors = [], verified = [];
  let app, page;
  try {
    app = await _electron.launch({ args: [fileURLToPath(import.meta.url)], timeout: 30000, env: { ...process.env, QA_BATCH_INPUT_ROOT: root, KUA_YIPU_AUTH_URL: 'http://127.0.0.1:1' } });
    app.process().stderr.on('data', chunk => process.stderr.write(chunk));
    page = await app.firstWindow({ timeout: 30000 }); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/announcements**', route => route.fulfill({ json: [] }));
    await page.locator('.sidebar nav button').filter({ hasText: '商品工作台' }).click();
    const editor = page.getByRole('region', { name: '批量图片编辑' });
    const settled = () => page.waitForFunction(() => !document.querySelector('.batch-image-editor [role="status"]'));
    const type = async (input, value) => {
      await input.click(); await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace'); await page.keyboard.type(value);
      assert.equal(await input.inputValue(), value, 'mouse click and keyboard must update the controlled input');
      assert.equal(await input.evaluate(node => document.activeElement === node), true);
    };
    const open = async () => {
      await page.getByRole('button', { name: '批量修改 14', exact: true }).click();
      await type(page.getByLabel('标题前缀', { exact: true }), 'Batch title');
      await page.locator('.batch-tabs').getByRole('button', { name: '产品图片', exact: true }).click();
      await editor.waitFor(); await settled();
    };
    for (const [folder, text, scope, watermarkType] of [['first', 'Main batch', 'mainImages', 'text'], ['second', 'Detail batch', 'detailImages', 'text'], ['first', 'Both batch', 'both', 'text'],
      ['second', 'Main logo', 'mainImages', 'image'], ['first', 'Detail logo', 'detailImages', 'image'], ['second', 'Both logo', 'both', 'image']]) {
      await page.getByLabel('采集分组', { exact: true }).selectOption(folder);
      await page.waitForFunction(folder => document.querySelector('.product-table tbody tr')?.textContent.includes(folder + ' 商品'), folder);
      await open(); await type(editor.getByLabel('水印文字'), text);
      await editor.getByLabel('作用范围').selectOption(scope);
      if (watermarkType === 'image') {
        await editor.getByLabel('水印类型').selectOption('image');
        await editor.getByLabel('上传水印图片').setInputFiles(path.join(root, 'data', 'media', 'logo.png'));
        await settled();
      }
      const before = JSON.parse(fs.readFileSync(path.join(root, 'data', 'workspace.json'), 'utf8')).products.filter(p => p.collectionFolderId === folder);
      assert.match(await editor.getByLabel('预览商品').inputValue(), new RegExp('^' + folder + '-'));
      await editor.getByRole('button', { name: '一键添加／更新水印', exact: true }).click(); await settled();
      await editor.getByAltText('处理后', { exact: true }).waitFor();
      await editor.getByRole('button', { name: '保存图片修改', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
      const stored = JSON.parse(fs.readFileSync(path.join(root, 'data', 'workspace.json'), 'utf8'));
      const after = stored.products.filter(p => p.collectionFolderId === folder);
      for (let i = 0; i < after.length; i++) {
        for (const key of ['mainImages', 'detailImages']) {
          if (scope === 'both' || scope === key) assert.notDeepEqual(after[i][key], before[i][key]);
          else assert.deepEqual(after[i][key], before[i][key]);
        }
        assert.deepEqual(after[i].source, before[i].source);
      }
      verified.push(`${watermarkType}-${scope}-saved-and-unchanged-scope-preserved`);
    }
    verified.push('six-successive-batches-keyboard-input');
    await page.getByLabel('采集分组', { exact: true }).selectOption('first');
    await page.waitForFunction(() => document.querySelector('.product-table tbody tr')?.textContent.includes('first 商品'));
    if (process.env.QA_BATCH_INPUT_BASELINE !== '1') {
      await open(); await type(editor.getByLabel('水印文字'), 'Unsaved preview');
      await editor.getByRole('button', { name: '一键添加／更新水印', exact: true }).click(); await settled();
      await page.locator('.batch-drawer').getByTitle('关闭', { exact: true }).click();
      const confirmation = page.getByRole('alertdialog');
      await confirmation.waitFor();
      await page.keyboard.press('Escape');
      await confirmation.waitFor({ state: 'hidden' });
      await type(editor.getByLabel('水印文字'), 'After cancel');
      await page.locator('.batch-drawer').getByTitle('关闭', { exact: true }).click();
      await confirmation.getByRole('button', { name: '确认', exact: true }).click();
      await editor.waitFor({ state: 'hidden' });
      await open(); await type(editor.getByLabel('水印文字'), 'After discard');
      await page.locator('.batch-drawer').getByTitle('关闭', { exact: true }).click();
      const search = page.getByPlaceholder('搜索标题或商品 ID');
      await type(search, 'first'); await type(search, '');
      verified.push('cancel-discard-reopen-and-search-input');
      let pendingRoute;
      const stalled = new Promise(resolve => { pendingRoute = resolve; });
      const handler = route => { pendingRoute(route); };
      await page.route('**/api/products/image-drafts', handler);
      await page.getByRole('button', { name: '批量修改 14', exact: true }).click();
      await page.locator('.batch-tabs').getByRole('button', { name: '产品图片', exact: true }).click();
      const route = await stalled;
      await type(editor.getByLabel('水印文字'), 'While reading');
      assert.equal(await editor.getByRole('button', { name: '一键添加／更新水印', exact: true }).isDisabled(), true);
      await route.fulfill({ status: 503, json: { error: '测试读取失败' } });
      await settled();
      await page.unroute('**/api/products/image-drafts', handler);
      await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/api/products/image-drafts') && response.ok()),
        editor.getByRole('button', { name: '重新读取图片', exact: true }).click(),
      ]);
      await page.waitForFunction(() => !document.querySelector('.batch-image-editor [role="status"]') && document.querySelector('[aria-label="预览商品"]')?.options.length === 14);
      assert.equal(await editor.getByLabel('水印文字').inputValue(), 'While reading');
      assert.equal(await editor.getByRole('button', { name: '一键添加／更新水印', exact: true }).isEnabled(), true);
      await page.locator('.batch-drawer').getByTitle('关闭', { exact: true }).click();
      verified.push('input-during-read-and-retry-without-losing-text');
      await page.getByRole('button', { name: '删除空分组', exact: true }).click();
      await confirmation.waitFor(); await confirmation.getByRole('button', { name: '取消', exact: true }).click();
      await type(search, 'After delete cancellation'); await type(search, '');
      await page.getByRole('button', { name: '批量修改 14', exact: true }).click();
      await page.locator('.batch-tabs').getByRole('button', { name: '详情描述', exact: true }).click();
      const details = page.getByRole('region', { name: '商品详情模板' });
      await type(details.getByLabel('模板名称'), 'Unsaved template');
      await details.getByRole('button', { name: '新建模板', exact: true }).click();
      await confirmation.waitFor(); await confirmation.getByRole('button', { name: '确认', exact: true }).click();
      await type(details.getByLabel('模板名称'), 'After switching template');
      await page.screenshot({ path: path.join(root, 'inputs-after-confirmation.png') });
      verified.push('folder-cancel-and-template-confirm-input');
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, root, verified }));
  } catch (error) {
    await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
    console.error(JSON.stringify({ root, verified, errors })); throw error;
  } finally { await app?.close(); }
}
