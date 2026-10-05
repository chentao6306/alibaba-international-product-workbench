import crypto from 'node:crypto';
import Module from 'node:module';

const HEADER = Buffer.from('CDKENC01');

export function encryptModule(source, { key, buildId, name }) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${buildId}:${name}`));
  const encrypted = Buffer.concat([cipher.update(source, 'utf8'), cipher.final()]);
  return Buffer.concat([HEADER, iv, cipher.getAuthTag(), encrypted]);
}

// Compile for the exact Electron/V8 runtime. This protects files at rest;
// a client cannot promise secrecy against memory inspection or reversing.
export function protectedLoaderSource({ key, buildId, names }) {
  return Module.wrap(`'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { registerHooks } = require('node:module');
const key = Buffer.from(${JSON.stringify([...key])});
const buildId = ${JSON.stringify(buildId)};
const names = new Set(${JSON.stringify(names)});
module.exports = function installProtectedModules(root) {
  return registerHooks({ load: function(url, context, nextLoad) {
    if (!url.startsWith('file:')) return nextLoad(url, context);
    const file = fileURLToPath(url);
    const name = path.relative(root, file).split(path.sep).join('/');
    if (!names.has(name)) return nextLoad(url, context);
    let source;
    try {
      const buffer = fs.readFileSync(file + '.bin');
      if (buffer.length < 36 || buffer.subarray(0, 8).toString() !== 'CDKENC01') throw new Error('Invalid encrypted module');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(8, 20));
      decipher.setAAD(Buffer.from(buildId + ':' + name));
      decipher.setAuthTag(buffer.subarray(20, 36));
      source = Buffer.concat([decipher.update(buffer.subarray(36)), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('程序组件校验失败，请重新下载安装包');
    }
    return { format: 'module', shortCircuit: true, source: source };
  } });
};
`);
}

export function protectedEntry(body) {
  return `import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
require('bytenode');
require('./protected-loader.jsc')(fileURLToPath(new URL('../', import.meta.url)));
await import(${JSON.stringify('./' + body)});
`;
}
