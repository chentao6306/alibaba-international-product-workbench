import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyArtifact } from '../auth-server/update-protocol.js';
import { UPDATE_CONFIG } from '../electron/update-config.js';

const directory = fileURLToPath(new URL('.', import.meta.url));
const repository = path.resolve(directory, '..');

// Local previews use the real signed installer already built on this machine.
// Production uses the existing public release routes, so withdrawn releases
// disappear from the website together with the desktop update feed.
function localDownloads() {
  const install = (server) => {
    const app = express();
    const pkg = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8'));
    const installer = path.join(repository, 'release-installer', `chaodekuai-${pkg.version}-setup.exe`);
    const url = `/updates/chaodekuai/files/chaodekuai-${pkg.version}-setup.exe`;
    app.get('/updates/chaodekuai/latest.json', (_request, response) => {
      response.set('Cache-Control', 'no-store');
      if (!fs.existsSync(installer) || !fs.existsSync(`${installer}.update.json`)) return response.json({ release: null });
      const envelope = JSON.parse(fs.readFileSync(`${installer}.update.json`, 'utf8'));
      const artifact = verifyArtifact(envelope, UPDATE_CONFIG.publicKey);
      if (artifact.version !== pkg.version || fs.statSync(installer).size !== artifact.size) return response.status(503).json({ release: null });
      response.json({ release: { title: `抄得快 ${artifact.version}`, notes: '优化不同类目的规格识别与填写。\n修复图片规格遗漏与 SKU 对应问题。\n已有商品可在更新后继续编辑和处理。', publishedAt: fs.statSync(installer).mtime.toISOString(), envelope, url } });
    });
    app.get([url, '/updates/chaodekuai/download'], (_request, response) => {
      response.set('Cache-Control', 'no-store').download(installer);
    });
    server.middlewares.use(app);
  };
  return { name: 'website-local-downloads', configureServer: install, configurePreviewServer: install };
}

export default defineConfig({
  root: directory,
  base: '/website/',
  publicDir: path.join(directory, 'public'),
  plugins: [react(), localDownloads()],
  build: { outDir: path.join(repository, 'dist-website'), emptyOutDir: true },
  server: { port: 5175, strictPort: true },
  preview: { port: 4175, strictPort: true },
});
