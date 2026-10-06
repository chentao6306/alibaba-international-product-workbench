import { app, BrowserWindow, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_ID = 'com.kua-yipu.workbench';
let icon;
let initialized = false;

export function appWindowIcon() {
  if (icon) return icon;
  // Protected-module previews have dist/ but no public/ directory. Resolve
  // relative to this module, never the shell's current working directory.
  for (const directory of app.isPackaged ? ['dist'] : ['public', 'dist']) {
    const candidate = nativeImage.createFromPath(path.join(root, directory, 'brand.png'));
    if (!candidate.isEmpty()) { icon = candidate; return icon; }
  }
  throw new Error('软件图标资源缺失，请重新安装完整的抄得快安装包');
}

function brandWindow(window) {
  window.setIcon(appWindowIcon());
  window.setMenuBarVisibility(false);
  if (process.platform === 'win32') {
    const ico = app.isPackaged ? path.join(process.resourcesPath, 'brand.ico') : path.join(root, 'assets', 'brand.ico');
    const previewIco = path.join(root, '..', 'assets', 'brand.ico');
    const iconPath = fs.existsSync(ico) ? ico : fs.existsSync(previewIco) ? previewIco : '';
    window.setAppDetails({ appId: APP_ID, ...(iconPath ? { appIconPath: iconPath, appIconIndex: 0 } : {}) });
  }
}

export function initializeWindowBranding() {
  if (initialized) return;
  initialized = true;
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
  // Includes verification WebContentsViews, iframe media, and popup windows.
  // The Chromium switch also covers audio started before navigation events.
  app.commandLine.appendSwitch('mute-audio');
  app.on('web-contents-created', (_event, contents) => {
    contents.setAudioMuted(true);
    contents.on('did-start-navigation', () => { if (!contents.isDestroyed()) contents.setAudioMuted(true); });
  });
  // Covers web-created seller windows as well as our explicitly constructed
  // windows. Verification can initialize this independently of main.js.
  app.on('browser-window-created', (_event, window) => brandWindow(window));
}

export function createAppWindow(options) {
  initializeWindowBranding();
  return new BrowserWindow({ ...options, icon: appWindowIcon() });
}
