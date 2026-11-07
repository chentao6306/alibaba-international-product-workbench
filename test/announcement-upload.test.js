import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { findChromium } from '../server/browser-runtime.js';
import { uploadAnnouncementImage } from '../auth-server/admin-image-upload.js';

const image = { src: `/api/announcement-images/${'a'.repeat(64)}.webp`, width: 10, height: 10 };
const source = () => new File([new Uint8Array([1, 2, 3])], '中文公告.png', { type: 'image/png' });
const success = () => Response.json(image, { status: 201 });

test('announcement upload snapshots local bytes once and retries a disconnected request with the same bytes', async () => {
  const file = source();
  let reads = 0;
  const read = file.arrayBuffer.bind(file);
  file.arrayBuffer = async () => { reads++; return read(); };
  const bodies = [];
  const result = await uploadAnnouncementImage(file, { token: 'test-session', fetchImpl: async (url, options) => {
    assert.equal(url, '/api/admin/announcement-images');
    assert.equal(options.headers.authorization, 'Bearer test-session');
    assert.equal(options.headers['content-type'], 'image/png');
    assert.ok(options.body instanceof ArrayBuffer, 'request must not depend on an open local file handle');
    bodies.push(options.body);
    if (bodies.length === 1) throw new TypeError('Failed to fetch');
    return success();
  } });
  assert.deepEqual(result, image);
  assert.equal(reads, 1);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual([...new Uint8Array(bodies[1])], [1, 2, 3]);
});

test('announcement upload reports unreadable local files before sending a request', async () => {
  let requests = 0;
  const options = { token: 'test', fetchImpl: async () => { requests++; return success(); } };
  await assert.rejects(uploadAnnouncementImage({ size: 3, arrayBuffer: async () => { throw new DOMException('File changed', 'NotReadableError'); } }, options), /保存到电脑本地.*已保留/);
  await assert.rejects(uploadAnnouncementImage({ size: 3, arrayBuffer: async () => new ArrayBuffer(2) }, options), /发生变化/);
  assert.equal(requests, 0);
});

test('announcement upload bounds connection retries and gives an actionable Chinese error', async () => {
  let requests = 0;
  await assert.rejects(uploadAnnouncementImage(source(), { token: 'test', fetchImpl: async () => { requests++; throw new TypeError('Failed to fetch'); } }), /连接中断.*已保留/);
  assert.equal(requests, 2);
  requests = 0;
  await assert.rejects(uploadAnnouncementImage(source(), { token: 'test', fetchImpl: async () => { requests++; throw new DOMException('Timed out', 'TimeoutError'); } }), /上传超时/);
  assert.equal(requests, 1);
});

test('announcement upload does not retry rejected requests and explains non-JSON proxy errors', async () => {
  for (const [status, message] of [[401, /重新登录/], [413, /大小限制/], [502, /HTTP 502/]]) {
    let requests = 0;
    await assert.rejects(uploadAnnouncementImage(source(), { token: 'test', fetchImpl: async () => {
      requests++; return new Response('<html>proxy error</html>', { status });
    } }), message);
    assert.equal(requests, 1);
  }
  await assert.rejects(uploadAnnouncementImage(source(), { token: 'test', fetchImpl: async () => Response.json({ error: '图片格式无法读取' }, { status: 400 }) }), /图片格式无法读取/);
  await assert.rejects(uploadAnnouncementImage(source(), { token: 'test', fetchImpl: async () => Response.json({}) }), /图片信息不完整/);
});

test('browser upload keeps selected bytes when the local file changes during transmission', { timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-upload-file-'));
  const file = path.join(root, '公告图片.png');
  const original = Buffer.from('original local image bytes');
  fs.writeFileSync(file, original);
  const bodies = [];
  const server = http.createServer(async (request, response) => {
    if (request.url === '/upload.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(fs.readFileSync(new URL('../auth-server/admin-image-upload.js', import.meta.url))); return;
    }
    if (request.method === 'POST' && request.url === '/api/admin/announcement-images') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      bodies.push(Buffer.concat(chunks));
      response.writeHead(201, { 'content-type': 'application/json' }); response.end(JSON.stringify(image)); return;
    }
    response.writeHead(200, { 'content-type': 'text/html' }); response.end('<input type="file" id="image">');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--mute-audio'] });
    const page = await browser.newPage();
    await page.exposeFunction('changeLocalFile', () => { fs.writeFileSync(file, 'replaced by another program'); fs.utimesSync(file, new Date(), new Date(Date.now() + 2000)); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator('#image').setInputFiles(file);
    const result = await page.evaluate(async () => {
      const { uploadAnnouncementImage } = await import('/upload.js');
      return uploadAnnouncementImage(document.querySelector('#image').files[0], { token: 'test-session', fetchImpl: async (url, options) => {
        document.querySelector('#image').value = '';
        await window.changeLocalFile();
        return fetch(url, options);
      } });
    });
    assert.deepEqual(result, image);
    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies[0], original);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
