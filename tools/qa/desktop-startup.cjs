const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const root = process.env.QA_OUTPUT_DIR;
assert.ok(root);
fs.mkdirSync(root, { recursive: true });
app.setPath('userData', path.join(root, 'profile'));
app.commandLine.appendSwitch('mute-audio');
app.whenReady().then(async () => {
  const { createWorkbenchStartup } = await import(pathToFileURL(path.resolve('electron/workbench-startup.js')));
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests++;
    response.setHeader('content-type', 'text/html');
    response.end('<div id="root"><input id="editing" value="unsaved"></div>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const errors = [], loads = [];
  const original = window.loadURL.bind(window);
  let startup;
  window.loadURL = async next => {
    loads.push(next.startsWith('data:') ? 'placeholder' : next);
    if (next.startsWith('data:')) {
      await new Promise(resolve => setTimeout(resolve, 100));
      // Repeated entry while the placeholder is pending must join startup.
      for (let i = 0; i < 20; i++) void startup.start(window);
    }
    return original(next);
  };
  startup = createWorkbenchStartup({ url, loadingUrl: 'data:text/html,<p>Loading</p>',
    ensureServer: async () => {}, onError: error => errors.push(error.message) });
  assert.ok(await startup.start(window));
  assert.deepEqual(loads, ['placeholder', url]);
  await window.webContents.executeJavaScript('document.querySelector("input").value="retained edits"');
  await startup.start(window);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("input").value'), 'retained edits');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'desktop-startup.json'), JSON.stringify({ ok: true, loads, requests, concurrentEntries: 20, editsRetained: true, errors }, null, 2));
  window.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  console.log('Desktop concurrent startup passed'); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
