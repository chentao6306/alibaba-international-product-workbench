import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const code = 'CDK-' + 'p'.repeat(43);
if (process.versions.electron) {
  const { app, BrowserWindow, session } = await import('electron');
  app.setPath('userData', path.join(process.env.QA_ACTIVATION_ROOT, 'profile'));
  app.whenReady().then(async () => {
  const seller = session.fromPartition('persist:kua-yipu-qa-persist');
  await seller.cookies.set({ url: 'https://www.alibaba.com/', domain: '.alibaba.com', name: 'xman_us_t', value: 'sign=y&x_lid=qa-persist', secure: true });
  seller.protocol.handle('https', (request) => new Response(new URL(request.url).hostname === 'login.alibaba.com'
    ? '<script>location.href="https://www.alibaba.com/"</script>'
    : '<html><body><h1>QA Seller</h1><p>Authenticated account fixture</p><div>Product administration</div></body></html>', { headers: { 'content-type': 'text/html' } }));
  await import('../electron/main.js');
  for (let attempt = 0; attempt < 200; attempt++) {
    const window = BrowserWindow.getAllWindows().find((entry) => entry.getTitle() === '抄得快登录');
    if (window && !window.webContents.isLoading()) {
      try {
        const saved = await window.webContents.executeJavaScript('window.kuaYipu.activationStatus("qa-persist")');
        assert.equal(saved, process.env.QA_PHASE === 'read');
        const credentials = { username: 'qa-persist', password: 'fixture-password', activationCode: process.env.QA_PHASE === 'write' ? code : '', remember: false };
        await window.webContents.executeJavaScript(`window.kuaYipu.login(${JSON.stringify(credentials)})`);
        console.log('ACTIVATION_PERSISTENCE_OK');
        app.quit();
        break;
      } catch (error) { console.error(error.message); app.exit(1); }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  }).catch((error) => { console.error(error.message); app.exit(1); });
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-persistence-qa-'));
  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/announcements') { response.end('[]'); return; }
    if (request.url.endsWith('/login')) {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.activationCode !== code) { response.writeHead(403); response.end('{"error":"activation missing"}'); return; }
    }
    response.end(JSON.stringify({ authorized: true, token: 'fixture-token', serverTime: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const executable = (await import('electron')).default;
  try {
    for (const phase of ['write', 'read']) {
      const probe = net.createServer();
      await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const localPort = probe.address().port;
      await new Promise((resolve) => probe.close(resolve));
      await new Promise((resolve, reject) => {
        const child = spawn(executable, [fileURLToPath(import.meta.url)], { windowsHide: true, env: { ...process.env, QA_ACTIVATION_ROOT: root, QA_PHASE: phase, KUA_YIPU_AUTH_URL: `http://127.0.0.1:${server.address().port}`, KUA_YIPU_PORT: String(localPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = ''; let errors = '';
        child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { errors += chunk; });
        const timer = setTimeout(() => { child.kill(); reject(Error(`Native desktop ${phase} did not exit: ${output}\n${errors}`)); }, 25000);
        child.once('exit', (status) => { clearTimeout(timer); status === 0 && output.includes('ACTIVATION_PERSISTENCE_OK') ? resolve() : reject(Error(`Native desktop ${phase}: ${status}\n${output}\n${errors}`)); });
      });
    }
    assert.equal(fs.readFileSync(path.join(root, 'profile', 'activation-credentials.bin')).includes(code), false);
    console.log(JSON.stringify({ ok: true, verified: ['native-electron-normal-exit', 'encrypted-activation-persistence', 'saved-code-reused-after-restart'] }));
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
