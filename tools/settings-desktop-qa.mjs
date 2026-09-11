import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.versions.electron) {
  const { app, BrowserWindow, safeStorage } = await import('electron');
  app.setPath('userData', path.join(process.env.QA_SETTINGS_ROOT, 'profile'));
  app.whenReady().then(async () => {
  assert.ok(safeStorage.isEncryptionAvailable());
  globalThis.__KUA_YIPU_SECURE_STORAGE = { encrypt: (value) => safeStorage.encryptString(value), decrypt: (value) => safeStorage.decryptString(value) };
  process.env.DATA_DIR = path.join(process.env.QA_SETTINGS_ROOT, 'data');
  process.env.PORT = '0';
  delete process.env.KUA_YIPU_DESKTOP;
  const server = await import('../server/index.js');
  const { SecureSettings } = await import('../server/secure-settings.js');
  globalThis.__QA_KEY_PERSISTED = () => new SecureSettings(process.env.DATA_DIR).key() === 'sk-desktop-qa-placeholder';
  const listener = await server.serverReady;
  const window = new BrowserWindow({ width: 1440, height: 1000, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await window.loadURL(`http://127.0.0.1:${listener.address().port}/`);
  app.on('window-all-closed', () => app.quit());
  }).catch((error) => { console.error(error); app.exit(1); });
} else {
  const { _electron } = await import('playwright-core');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-desktop-qa-'));
  const errors = [];
  const launch = () => _electron.launch({ args: [fileURLToPath(import.meta.url)], env: { ...process.env, QA_SETTINGS_ROOT: root, KUA_YIPU_AUTH_URL: 'http://127.0.0.1:1' } });
  let app;
  try {
    app = await launch();
    let page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('.sidebar nav button').filter({ hasText: '设置' }).click();
    await page.getByLabel('DeepSeek API 密钥').fill('sk-desktop-qa-placeholder');
    await page.getByLabel('采集时将中文标题翻译为英文').check();
    await page.getByLabel('采集时将来源价格换算为美元').check();
    await page.getByLabel('1 人民币兑美元').fill('0.14');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByText('DeepSeek 与加工规则已保存', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('DeepSeek API 密钥').inputValue(), '');
    assert.equal(fs.readFileSync(path.join(root, 'data', 'integrations.bin')).includes('sk-desktop-qa-placeholder'), false);
    await app.close(); app = await launch();
    page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('.sidebar nav button').filter({ hasText: '设置' }).click();
    await page.getByRole('button', { name: '测试已保存的连接', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '测试已保存的连接', exact: true }).isEnabled(), true);
    assert.equal(await page.getByLabel('采集时将中文标题翻译为英文').isChecked(), true);
    assert.equal(await page.getByLabel('1 人民币兑美元').inputValue(), '0.14');
    assert.equal(await app.evaluate(() => globalThis.__QA_KEY_PERSISTED()), true);
    await page.locator('.processing-settings').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, 'settings-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.sidebar').evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
    await page.locator('.processing-settings').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(root, 'settings-mobile.png') });
    await page.getByRole('button', { name: '移除密钥', exact: true }).click();
    await page.getByText('已移除 API 密钥', { exact: true }).waitFor();
    assert.equal(fs.existsSync(path.join(root, 'data', 'integrations.bin')), false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, root, verified: ['windows-dpapi', 'restart-persistence', 'key-redaction', 'responsive-settings'] }));
  } finally { await app?.close(); }
}
