import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

if (process.versions.electron) {
  const { app, BrowserWindow, safeStorage } = await import('electron');
  app.setPath('userData', path.join(process.env.QA_AI_SETTINGS_ROOT, 'profile'));
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    assert.ok(safeStorage.isEncryptionAvailable());
    globalThis.__KUA_YIPU_SECURE_STORAGE = { encrypt: text => safeStorage.encryptString(text), decrypt: bytes => safeStorage.decryptString(bytes) };
    process.env.DATA_DIR = path.join(process.env.QA_AI_SETTINGS_ROOT, 'data');
    process.env.PORT = '0';
    delete process.env.KUA_YIPU_DESKTOP;
    let serverEntry = new URL('../server/index.js', import.meta.url).href;
    if (process.env.QA_AI_PACKAGED_APP) {
      const archive = path.join(process.env.QA_AI_PACKAGED_APP, 'resources', 'app.asar');
      const require = createRequire(import.meta.url);
      require('bytenode');
      require(path.join(archive, 'electron', 'protected-loader.jsc'))(archive);
      process.env.APP_ROOT_DIR = archive;
      serverEntry = pathToFileURL(path.join(archive, 'server', 'index.js')).href;
    }
    const server = await import(serverEntry);
    const listener = await server.serverReady;
    const window = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await window.loadURL(`http://127.0.0.1:${listener.address().port}/`);
    app.on('window-all-closed', () => app.quit());
  }).catch(error => { console.error(error); app.exit(1); });
} else {
  const { _electron } = await import('playwright-core');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-settings-desktop-qa-'));
  const errors = [];
  let app, page;
  async function launch() {
    app = await _electron.launch({ args: [fileURLToPath(import.meta.url)], env: { ...process.env, QA_AI_SETTINGS_ROOT: root,
      QA_AI_PACKAGED_APP: process.argv[2] ? path.resolve(process.argv[2]) : '', KUA_YIPU_AUTH_URL: 'http://127.0.0.1:1' } });
    page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('.sidebar nav button').filter({ hasText: '设置' }).click();
    await page.getByLabel('商品处理方式', { exact: true }).waitFor();
  }
  async function save() {
    const response = page.waitForResponse(res => res.url().endsWith('/api/settings/ai-products') && res.request().method() === 'PATCH');
    await page.getByRole('button', { name: '保存 AI 设置', exact: true }).click();
    assert.equal((await response).status(), 200);
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent.includes('保存 AI 设置')).disabled);
  }
  async function remove() {
    const response = page.waitForResponse(res => res.url().endsWith('/api/settings/ai-products') && res.request().method() === 'PATCH');
    await page.getByRole('button', { name: '移除当前服务密钥', exact: true }).click();
    assert.equal((await response).status(), 200);
    await page.getByRole('button', { name: '移除当前服务密钥', exact: true }).waitFor({ state: 'hidden' });
  }
  try {
    await launch();
    assert.equal(await page.getByLabel('商品处理方式', { exact: true }).inputValue(), 'rules');
    assert.equal(await page.getByLabel('AI 服务', { exact: true }).inputValue(), 'deepseek');
    await page.getByLabel('商品处理方式', { exact: true }).selectOption('assisted');
    await page.getByLabel('AI 商品 API 密钥').fill('sk-ai-desktop-placeholder');
    await page.getByLabel('采集时从商品正文补充明确属性').uncheck();
    await save();
    assert.equal(await page.getByLabel('AI 商品 API 密钥').inputValue(), '');
    const keyFile = path.join(root, 'data', 'integrations.bin');
    assert.equal(fs.readFileSync(keyFile).includes('sk-ai-desktop-placeholder'), false);
    await app.close(); await launch();
    assert.equal(await page.getByLabel('商品处理方式', { exact: true }).inputValue(), 'assisted');
    assert.equal(await page.getByLabel('采集时从商品正文补充明确属性').isChecked(), false);
    assert.equal(await page.getByLabel('上架时辅助映射当前类目属性').isChecked(), true);
    assert.equal(await page.getByRole('button', { name: '测试已保存的 AI 连接', exact: true }).isEnabled(), true);
    const card = () => page.locator('.processing-settings').filter({ has: page.getByRole('heading', { name: 'AI 采集与属性映射', exact: true }) });
    await card().scrollIntoViewIfNeeded();
    await card().screenshot({ path: path.join(root, 'ai-settings-desktop.png') });
    await page.getByLabel('AI 服务', { exact: true }).selectOption('openai');
    assert.equal(await page.getByRole('button', { name: '测试已保存的 AI 连接', exact: true }).isDisabled(), true);
    await page.getByLabel('AI 商品 API 密钥').fill('sk-openai-desktop-placeholder'); await save();
    await app.close(); await launch();
    assert.equal(await page.getByLabel('AI 服务', { exact: true }).inputValue(), 'openai');
    await page.getByLabel('AI 服务', { exact: true }).selectOption('deepseek'); await save();
    assert.equal(await page.getByRole('button', { name: '测试已保存的 AI 连接', exact: true }).isEnabled(), true);
    await remove();
    assert.equal(fs.existsSync(keyFile), true, 'Removing DeepSeek must preserve OpenAI');
    assert.equal(await page.getByLabel('商品处理方式', { exact: true }).inputValue(), 'rules');
    await page.getByLabel('AI 服务', { exact: true }).selectOption('openai'); await save();
    assert.equal(await page.getByRole('button', { name: '测试已保存的 AI 连接', exact: true }).isEnabled(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    await card().scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await card().screenshot({ path: path.join(root, 'ai-settings-narrow.png') });
    await remove(); assert.equal(fs.existsSync(keyFile), false);
    const workspace = fs.readFileSync(path.join(root, 'data', 'workspace.json'), 'utf8');
    assert.doesNotMatch(workspace, /sk-ai-desktop-placeholder|sk-openai-desktop-placeholder/);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, root, packaged: Boolean(process.argv[2]), verified: ['windows-dpapi', 'restart-persistence', 'provider-isolation', 'blank-keeps-key', 'remove-restores-rules', 'independent-switches', 'no-key-rendering', 'narrow-settings'] }));
  } finally { await app?.close(); }
}
