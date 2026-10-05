import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import bytenode from 'bytenode';
import { encryptModule, protectedLoaderSource } from '../tools/protected-modules.mjs';

test('encrypted modules preserve imports and browser callback source, and reject tampering and module substitution', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'protected-modules-test-'));
  const key = crypto.randomBytes(32); const buildId = crypto.randomUUID();
  const names = ['value.js', 'callback.js', 'corrupt.js', 'swapped.js', 'wrong-build.js', 'missing.js'];
  let hooks;
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    for (const name of names) fs.writeFileSync(path.join(root, name), 'throw new Error("Bootstrap required");');
    const write = (name, source, options = {}) => fs.writeFileSync(path.join(root, name + '.bin'), encryptModule(source, { key, buildId, name, ...options }));
    write('value.js', 'export const value = 7;');
    const source = 'import { value } from "./value.js"; export const total = value + 2; export function callback(input) { return input.map(item => item.label).join(","); } export const location = import.meta.url;';
    write('callback.js', source);
    assert.equal(fs.readFileSync(path.join(root, 'callback.js.bin')).includes(Buffer.from('function callback')), false);
    const encrypted = fs.readFileSync(path.join(root, 'callback.js.bin'));
    assert.equal(encrypted.equals(encryptModule(source, { key, buildId, name: 'callback.js' })), false, 'each module gets a fresh nonce');
    write('corrupt.js', 'export const value = 1;');
    const broken = fs.readFileSync(path.join(root, 'corrupt.js.bin')); broken[broken.length - 1] ^= 1;
    fs.writeFileSync(path.join(root, 'corrupt.js.bin'), broken);
    fs.copyFileSync(path.join(root, 'value.js.bin'), path.join(root, 'swapped.js.bin'));
    write('wrong-build.js', 'export const value = 1;', { buildId: 'different-build' });
    const loader = path.join(root, 'loader.jsc');
    fs.writeFileSync(loader, bytenode.compileCode(protectedLoaderSource({ key, buildId, names })));
    hooks = createRequire(import.meta.url)(loader)(root);
    const module = await import(pathToFileURL(path.join(root, 'callback.js')).href);
    assert.equal(module.total, 9);
    assert.equal(module.location, pathToFileURL(path.join(root, 'callback.js')).href);
    assert.equal(vm.runInNewContext(`(${module.callback.toString()})([{label:'Red'},{label:'Blue'}])`), 'Red,Blue');
    for (const name of ['corrupt.js', 'swapped.js', 'wrong-build.js', 'missing.js']) await assert.rejects(import(pathToFileURL(path.join(root, name)).href), /程序组件校验失败/);
    assert.equal(fs.readdirSync(root).some((file) => file.includes('decrypted')), false);
  } finally {
    hooks?.deregister(); key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
