const { app, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
// Electron's encryption key lives in Local State; use an isolated copy of the desktop key.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-qa-key-'));
if (process.env.QA_DESKTOP_USER_DATA_DIR) {
  fs.copyFileSync(path.join(process.env.QA_DESKTOP_USER_DATA_DIR, 'Local State'), path.join(profile, 'Local State'));
}
app.setPath('userData', profile);
const cleanup = () => {
  fs.rmSync(path.join(profile, 'Local State'), { force: true });
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
};
app.on('quit', cleanup);

app.whenReady().then(async () => {
  globalThis.__KUA_YIPU_SECURE_STORAGE = { encrypt: (value) => safeStorage.encryptString(value), decrypt: (value) => safeStorage.decryptString(value) };
  const target = process.argv[2];
  if (!target || !path.resolve(target).startsWith(path.resolve(__dirname) + path.sep)) throw new Error('QA module must be in tools');
  process.argv = [process.argv[0], path.resolve(target), ...process.argv.slice(3)];
  await import(pathToFileURL(path.resolve(target)).href);
  cleanup();
  app.exit(process.exitCode || 0);
}).catch((error) => { console.error(error); cleanup(); app.exit(1); });
