import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import bytenode from 'bytenode';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { encryptModule, protectedLoaderSource, protectedEntry } from './protected-modules.mjs';

const rendererFiles = new Set(['login.js', 'verification-ui.js']);
const entryBodies = { 'main.js': 'main-body.js', 'service-worker.js': 'service-worker-body.js' };
const stub = "throw new Error('请通过抄得快桌面程序启动');\n";
const obfuscate = (source) => JavaScriptObfuscator.obfuscate(source, {
  target: 'browser-no-eval', compact: true, identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false, stringArray: true, stringArrayEncoding: ['rc4'], stringArrayThreshold: 0.7,
  controlFlowFlattening: false, deadCodeInjection: false, selfDefending: false,
  debugProtection: false, disableConsoleOutput: false, sourceMap: false,
}).getObfuscatedCode();

export default async function preparePackage() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const key = crypto.randomBytes(32);
  const buildId = crypto.randomBytes(16).toString('hex');
  const names = [];
  for (const directory of ['server', 'electron']) {
    const destination = path.join(root, '.packaged', directory);
    await fs.rm(destination, { recursive: true, force: true });
    await fs.mkdir(destination, { recursive: true });
    for (const name of await fs.readdir(path.join(root, directory))) {
      if (!/\.(?:js|cjs|html)$/.test(name)) continue;
      const source = await fs.readFile(path.join(root, directory, name), 'utf8');
      if (name.endsWith('.html')) { await fs.writeFile(path.join(destination, name), source); continue; }
      // Renderer/preload scripts retain Electron's sandbox and are obfuscated.
      if (name.endsWith('.cjs') || directory === 'electron' && rendererFiles.has(name)) {
        await fs.writeFile(path.join(destination, name), obfuscate(source));
        continue;
      }
      // Playwright serializes callbacks with toString(). Preserve their local
      // bindings and decrypt only in memory, without a plaintext disk cache.
      const output = (await transform(source, { loader: 'js', target: 'node22', minifyWhitespace: true, minifySyntax: false, minifyIdentifiers: false, legalComments: 'none', sourcemap: false })).code;
      const body = directory === 'electron' && entryBodies[name] || name;
      const relative = `${directory}/${body}`;
      names.push(relative);
      await fs.writeFile(path.join(destination, body + '.bin'), encryptModule(output, { key, buildId, name: relative }));
      await fs.writeFile(path.join(destination, body), stub);
      if (body !== name) await fs.writeFile(path.join(destination, name), protectedEntry(body));
    }
  }
  const loader = await bytenode.compileElectronMainCode(protectedLoaderSource({ key, buildId, names }));
  await fs.writeFile(path.join(root, '.packaged', 'electron', 'protected-loader.jsc'), loader);
  key.fill(0);
  const dist = path.join(root, '.packaged', 'dist');
  await fs.rm(dist, { recursive: true, force: true });
  await fs.cp(path.join(root, 'dist'), dist, { recursive: true });
  async function protectRenderer(directory) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await protectRenderer(file);
      else if (item.name.endsWith('.map')) await fs.unlink(file);
      else if (item.name.endsWith('.js')) await fs.writeFile(file, obfuscate(await fs.readFile(file, 'utf8')));
    }
  }
  await protectRenderer(dist);
  console.log(`Protected ${names.length} business modules; renderer scripts obfuscated; no business source maps.`);
}
