import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { isMainThread } from 'node:worker_threads';
import { sanitizeDiagnosticReport, sanitizeDiagnosticEvent, diagnosticCode, diagnosticRequestContext } from '../auth-server/diagnostic-schema.js';
import { createDiagnosticStore } from '../auth-server/diagnostics.js';
import { buildDiagnosticReport, readDiagnosticTail, diagnosticSummaryFromState } from '../server/diagnostic-report.js';
import { createRuntimeDiagnostics, pruneRuntimeDiagnostics } from '../server/runtime-diagnostics.js';
import { capturePublishFailure, createPublishDiagnosticStore, pruneAllPublishDiagnostics } from '../server/publish-diagnostics.js';
import { diagnosticProduct } from '../auth-server/diagnostic-evidence.js';
import { createDiagnosticController, collectDiagnosticSummary } from '../electron/diagnostics.js';

const report = () => ({ schemaVersion: 1, reportId: crypto.randomUUID(), createdAt: new Date().toISOString(), appVersion: '1.4.83', events: [] });

test('keeps a bounded redacted cause when a publishing wrapper hides the browser failure', async () => {
  const cause = new Error('locator.click: Timeout 5000ms exceeded\npassword=fixture-private-value\n' + 'x'.repeat(9000));
  const error = Object.assign(new Error('Click result unknown'), { code: 'PUBLISH_CONTROL_RESULT_UNKNOWN', cause });
  const captured = await capturePublishFailure({ product: {}, error, stage: '填写类目属性：类型', mode: 'draft' });
  assert.match(captured.error.cause.message, /locator\.click: Timeout/);
  assert.doesNotMatch(captured.error.cause.message, /fixture-private-value/);
  assert.ok(captured.error.cause.message.length <= 6000);
  assert.equal(captured.error.code, 'PUBLISH_CONTROL_RESULT_UNKNOWN');
});

test('worker exit diagnostics survive capture and ingestion without exposing request values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-worker-'));
  try {
    const file = path.join(root, 'runtime.log');
    const log = createRuntimeDiagnostics(file);
    const request = { method: 'POST', route: { path: '/api/products/reference' },
      originalUrl: '/api/products/reference?token=PRIVATE_TOKEN', body: { title: 'PRIVATE_TITLE' }, params: { id: 'PRIVATE_ID' } };
    const context = diagnosticRequestContext(request);
    assert.deepEqual(context, { method: 'POST', route: '/api/products/reference', stage: 'reference' });
    assert.deepEqual(diagnosticRequestContext({ route: { path: '/api/products/PRIVATE_ID' }, url: request.originalUrl }), {});
    assert.deepEqual(diagnosticRequestContext({ route: { path: /^\/api\/products/ } }), {});
    log('api-error', { ...request, ...context, code: 'ERR_STRING_TOO_LONG' });
    log('service-stopped', { code: 'ERR_WORKER_OUT_OF_MEMORY', exitCode: 1, expected: false, reason: 'oom' });
    log('service-exited', { code: 'LOCAL_SERVICE_TERMINATED', exitCode: 0, expected: true, reason: 'requested' });
    const result = buildDiagnosticReport({ version: '1.4.93', files: [file], dataDirectory: root });
    assert.equal(result.events[0].route, '/api/products/reference');
    assert.equal(result.events[0].stage, 'reference');
    assert.equal(result.events[0].method, 'POST');
    // Source tests run in a process; packaged regressions run in an Electron
    // worker. The reported heap must identify its actual execution context.
    assert.equal(result.events[0].memoryScope, isMainThread ? 'main' : 'worker');
    assert.equal(result.events[1].code, 'ERR_WORKER_OUT_OF_MEMORY');
    assert.equal(result.events[1].exitCode, 1);
    assert.equal(result.events[1].expected, false);
    assert.equal(result.events[2].event, 'service-exited');
    assert.equal(result.events[2].exitCode, 0);
    assert.equal(result.events[2].expected, true);
    assert.deepEqual(sanitizeDiagnosticReport(result), result);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /PRIVATE_|originalUrl|params|body/);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|originalUrl|params|body/);
    assert.equal(sanitizeDiagnosticEvent({ exitCode: 3221225477 }).exitCode, 3221225477);
    assert.equal(sanitizeDiagnosticEvent({ exitCode: -1 }).exitCode, -1);
    for (const invalid of [null, '0', NaN, 1.5, 4294967296]) assert.equal(sanitizeDiagnosticEvent({ exitCode: invalid }).exitCode, undefined);
    assert.equal(sanitizeDiagnosticEvent({ route: '/api/products/PRIVATE_ID', method: 'PRIVATE_METHOD' }).route, undefined);
    assert.equal(diagnosticCode({ code: 'ERR_WORKER_OUT_OF_MEMORY' }), 'ERR_WORKER_OUT_OF_MEMORY');
    assert.equal(diagnosticCode({ code: 'EADDRINUSE' }), 'EADDRINUSE');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('diagnostic summary distinguishes timeout, stopped service and request failure without inventing zero counts', async () => {
  let calls = 0;
  const stopped = { status: () => ({ status: 'stopped' }), call: () => { calls++; } };
  assert.deepEqual(await collectDiagnosticSummary(stopped), { available: false, unavailableReason: 'service-stopped' });
  assert.equal(calls, 0);
  assert.deepEqual(await collectDiagnosticSummary(undefined), { available: false, unavailableReason: 'service-unavailable' });
  const running = call => ({ status: () => ({ status: 'running' }), call });
  const timedOut = await collectDiagnosticSummary(running(() => new Promise(() => {})), { timeoutMs: 10 });
  assert.deepEqual(timedOut, { available: false, unavailableReason: 'timeout' });
  assert.equal(Object.hasOwn(timedOut, 'products'), false);
  const failed = await collectDiagnosticSummary(running(() => Promise.reject(Object.assign(new Error('Private message'), { code: 'ERR_STRING_TOO_LONG' }))));
  assert.deepEqual(failed, { available: false, unavailableReason: 'request-failed', errorCode: 'ERR_STRING_TOO_LONG' });
  const saved = { available: true, products: 4662, jobs: 2348 };
  assert.equal(await collectDiagnosticSummary(running(() => Promise.resolve(saved))), saved);
  for (const summary of [timedOut, failed]) {
    const sanitized = sanitizeDiagnosticReport({ ...report(), summary });
    assert.equal(sanitized.summary.unavailableReason, summary.unavailableReason);
    assert.equal(sanitized.summary.available, false);
    assert.doesNotMatch(JSON.stringify(sanitized), /Private message/);
  }
});

test('diagnostics allowlist removes private payloads and classifies customer failures without exporting raw errors', () => {
  const result = sanitizeDiagnosticReport({ ...report(), password: 'PRIVATE_PASSWORD', cookies: ['PRIVATE_COOKIE'], products: ['PRIVATE_TITLE'],
    note: '上架失败\n密码：PRIVATE_PASSWORD\nhttps://a.example/private?token=PRIVATE_TOKEN\nC:\\private\\data\nprivate@example.com',
    events: [null, { at: new Date().toISOString(), event: 'publish-failed', code: 'PUBLISH_IMAGE_REJECTED', stage: 'specifications', message: 'PRIVATE_TITLE', url: 'PRIVATE_URL' }],
    summary: { available: true, failures: [null, { code: 'ENOSPC', count: 2, password: 'PRIVATE_PASSWORD' }] } });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|private@example|C:\\|https:/);
  assert.equal(result.events[1].stage, 'specifications');
  assert.deepEqual(sanitizeDiagnosticReport(result), result);
  for (const bad of [null, [], {}, { ...report(), reportId: '../secret' }]) assert.throws(() => sanitizeDiagnosticReport(bad), { status: 400 });
  assert.equal(diagnosticCode(new Error('Cannot create a string longer than 0x1fffffe8 characters')), 'ERR_STRING_TOO_LONG');
  assert.equal(diagnosticCode({ message: '国际站页面语言设置暂未生效' }), 'PUBLISH_LANGUAGE_NOT_READY');
  assert.equal(diagnosticCode({ message: '错误项产品图片1项' }), 'PUBLISH_IMAGE_REJECTED');
  assert.equal(diagnosticCode(null), 'UNKNOWN_ERROR');
  const summary = diagnosticSummaryFromState({ products: [{ status: 'publish_failed', title: 'PRIVATE_TITLE', publishResult: { message: '错误项产品图片1项' } }], jobs: [{ status: 'running' }] });
  assert.deepEqual(summary.failures, [{ code: 'PUBLISH_IMAGE_REJECTED', count: 1 }]);
  assert.equal(summary.activeJobs, 1);
});

test('diagnostic preview and log rotation remain bounded for a corrupt file above the V8 string limit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-tail-'));
  try {
    const file = path.join(root, 'runtime.log');
    const fd = fs.openSync(file, 'w');
    try {
      fs.writeSync(fd, '\n' + JSON.stringify({ event: 'main-exception', code: 'ERR_STRING_TOO_LONG', at: new Date().toISOString() }) + '\n', 0x20000000);
    } finally { fs.closeSync(fd); }
    assert.equal(readDiagnosticTail(file).length, 1);
    const preview = buildDiagnosticReport({ version: '1.4.83', files: [file], dataDirectory: root });
    assert.equal(preview.events[0].code, 'ERR_STRING_TOO_LONG');
    createRuntimeDiagnostics(file)('publish-failed', { stage: '正在上传产品图片', code: 'PUBLISH_IMAGE_REJECTED' });
    assert.ok(fs.statSync(file).size < 65536);
    assert.equal(readDiagnosticTail(file).at(-1).stage, 'images');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('diagnostic storage is idempotent per account/device and enforces retention, quotas and size', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-store-'));
  let now = Date.now();
  const owner = { account: 'qa', device: 'fixture-hash' };
  try {
    const store = createDiagnosticStore(root, { now: () => now, maxReports: 3, hourlyLimit: 2 });
    const first = report(); const receipt = store.put(first, owner);
    assert.deepEqual(store.put(first, owner), receipt);
    const second = store.put(report(), owner);
    assert.notEqual(second.id, receipt.id);
    assert.throws(() => store.put(report(), owner), { status: 429 });
    assert.throws(() => store.put({ ...report(), note: 'x'.repeat(8 * 1024 * 1024) }, owner), { status: 413 });
    assert.throws(() => store.get('../secret'), { status: 400 });
    assert.equal(store.list('qa').total, 2);
    assert.equal(store.get(receipt.id).device, undefined);
    now += 3600001;
    store.put(report(), owner); now += 1; store.put(report(), owner);
    assert.equal(store.list().total, 3);
    now += 31 * 86400000;
    assert.equal(store.prune(), 0); assert.equal(fs.readdirSync(root).length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('one-click diagnostics deduplicate concurrent uploads, retain failed retries and clear only on request', async () => {
  let active = { username: 'qa', token: 'token-a' }; let calls = 0; let built = 0; let cleared = false; let uploaded;
  let fail = true;
  const controller = createDiagnosticController({ session: () => active,
    buildReport: async note => { built += 1; return sanitizeDiagnosticReport({ ...report(), note }); },
    upload: async (value, token) => { calls += 1; uploaded = { value, token }; if (fail) throw Error('offline'); return { id: 'LOG-' + 'A'.repeat(24) }; },
    clear: async () => { cleared = true; } });
  const first = controller.upload('test'); const retry = controller.upload('test');
  await Promise.all([assert.rejects(first, /offline/), assert.rejects(retry, /offline/)]);
  assert.equal(calls, 1); assert.equal(built, 1); const original = uploaded.value.reportId;
  fail = false; await controller.upload('test'); assert.equal(uploaded.value.reportId, original); assert.equal(built, 1);
  await controller.clear(); assert.equal(cleared, true);
  active = null; await assert.rejects(controller.upload('test'), /授权登录/);
  assert.equal(typeof controller.preview, 'undefined'); assert.equal(typeof controller.export, 'undefined');
});

test('failure reports preserve product content, sources, SKU prices and screenshots but strip credentials', () => {
  const product = { id: 'product-1', title: '4G Phone', sourceUrl: 'https://www.alibaba.com/product-detail/Phone_123.html',
    descriptionHtml: '<table><tr><td>Camera</td><td>14MP</td></tr></table>', attributes: [{ name: 'Camera', value: '14MP' }],
    skus: [{ color: 'Red', price: 25, stock: 10 }], password: 'PRIVATE_PASSWORD', cookies: 'PRIVATE_COOKIE' };
  const value = sanitizeDiagnosticReport({ ...report(), failures: [{ product, source: product, error: { message: '图片1项', cookies: 'PRIVATE_COOKIE' },
    screenshots: [{ label: '发布页', data: '/9j/AA==', type: 'text/html' }, { data: '<svg>BAD</svg>' }] }] });
  assert.equal(value.failures[0].product.descriptionHtml, product.descriptionHtml);
  assert.equal(value.failures[0].product.sourceUrl, product.sourceUrl);
  assert.deepEqual(value.failures[0].product.skus, product.skus);
  assert.equal(value.failures[0].screenshots.length, 1); assert.equal(value.failures[0].screenshots[0].type, 'image/jpeg');
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_|svg/);
  assert.equal(diagnosticProduct({ description: 'a'.repeat(300000) }).truncated, true);
});

test('normal activity expires daily while failure files are isolated by account and bounded to seven days', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-retention-'));
  const now = Date.now();
  try {
    const file = path.join(root, 'runtime.log');
    fs.writeFileSync(file, [{ event: 'publish-completed', at: new Date(now - 2 * 86400000).toISOString() },
      { event: 'publish-failed', at: new Date(now - 2 * 86400000).toISOString() },
      { event: 'publish-failed', at: new Date(now - 8 * 86400000).toISOString() }].map(v => JSON.stringify(v)).join('\n'));
    pruneRuntimeDiagnostics(file, now); assert.equal(readDiagnosticTail(file).length, 1);
    const a = createPublishDiagnosticStore(root, 'a'), b = createPublishDiagnosticStore(root, 'b');
    a.write({ product: { title: 'Account A' } }); b.write({ product: { title: 'Account B' } });
    assert.equal(a.read().failures[0].product.title, 'Account A');
    a.clear(); assert.equal(a.read().failures.length, 0); assert.equal(b.read().failures.length, 1);
    const summary = diagnosticSummaryFromState({ products: [{ id: 'old', title: 'Already cleared', status: 'publish_failed', updatedAt: new Date(now - 1000).toISOString() }] });
    assert.equal(buildDiagnosticReport({ dataDirectory: root, account: 'a', summary }).failures.length, 0, 'Uploading after clearing must not recreate old evidence from the workspace');
    pruneAllPublishDiagnostics(root, now + 8 * 86400000); assert.equal(b.read().failures.length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('publish reports retain the newest failure and diverse error fields before repeated specification failures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-diversity-'));
  const account = 'diversity-fixture';
  const directory = path.join(root, 'diagnostics', crypto.createHash('sha256').update(account).digest('hex').slice(0, 24));
  try {
    const store = createPublishDiagnosticStore(root, account);
    const failures = [
      { product: { title: 'Width fixture' }, error: { code: 'PUBLISH_REQUIRED_DATA_MISSING', requiredFields: ['Writing width'] } },
      { product: { title: 'Sheets fixture' }, error: { code: 'PUBLISH_REQUIRED_DATA_MISSING', requiredFields: ['张数'] } },
      { product: { title: 'Delivery fixture' }, stage: '填写包装和物流属性', error: { code: 'PUBLISH_FIELD_NOT_READY' } },
      { product: { title: 'Price fixture' }, stage: '填写价格阶梯 2/3', error: { code: 'PUBLISH_CONTROL_RESULT_UNKNOWN' } },
      ...Array.from({ length: 4 }, (_, i) => ({ product: { title: `Specification fixture ${i}` },
        stage: `已填写规格 Body Color：${i + 1}/7`, error: { code: 'PUBLISH_FIELD_NOT_READY' } })),
    ];
    for (let index = 0; index < failures.length; index++) {
      store.write(failures[index]);
      const file = fs.readdirSync(directory).map(name => path.join(directory, name))
        .find(file => JSON.parse(fs.readFileSync(file, 'utf8')).product.title === failures[index].product.title);
      const time = new Date(Date.now() - 100000 + index * 1000);
      fs.utimesSync(file, time, time);
    }
    const result = store.read();
    assert.deepEqual(result.failures.map(row => row.product.title), ['Specification fixture 3', 'Price fixture', 'Delivery fixture', 'Sheets fixture', 'Width fixture']);
    assert.equal(result.omittedFailures, 3);
    assert.equal(fs.readdirSync(directory).length, 8, 'Selection must not delete the local evidence');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('publish report selection fills spare slots with recent repeats and respects byte limits and unreadable records', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-selection-'));
  const account = 'selection-fixture';
  const directory = path.join(root, 'diagnostics', crypto.createHash('sha256').update(account).digest('hex').slice(0, 24));
  try {
    const store = createPublishDiagnosticStore(root, account);
    for (let index = 0; index < 7; index++) {
      const title = `Different product ${index}`;
      store.write({ product: { title }, stage: `填写规格 ${title} ${index}/7`, error: { code: 'PUBLISH_FIELD_NOT_READY' },
        screenshots: [{ label: 'Fixture', data: '/9j/' + 'A'.repeat(12000) }] });
      const file = fs.readdirSync(directory).map(name => path.join(directory, name))
        .find(file => JSON.parse(fs.readFileSync(file, 'utf8')).product.title === title);
      const time = new Date(Date.now() - 100000 + index * 1000);
      fs.utimesSync(file, time, time);
    }
    const corrupt = path.join(directory, crypto.randomUUID() + '.json');
    fs.writeFileSync(corrupt, '{');
    const result = store.read();
    assert.deepEqual(result.failures.map(row => row.product.title), [6, 5, 4, 3, 2].map(index => `Different product ${index}`));
    assert.equal(result.omittedFailures, 3);
    const limit = 27000;
    const bounded = store.read(limit);
    assert.deepEqual(bounded.failures.map(row => row.product.title), ['Different product 6', 'Different product 5']);
    assert.ok(Buffer.byteLength(JSON.stringify(bounded.failures)) <= limit);
    assert.equal(bounded.omittedFailures, 6);
    assert.equal(store.read(0).failures.length, 0);
    assert.equal(store.read(0).omittedFailures, 8);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('client diagnostic HTTP upload is authenticated, admin-readable, sanitized and revoked with the license', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-http-'));
  const database = process.env.AUTH_TEST_DATABASE_URL;
  if (database && !/^\/auth_qa_[a-z0-9_]+$/.test(new URL(database).pathname)) throw new Error('Diagnostics tests require an isolated auth_qa_ database');
  const child = spawn(process.execPath, [database ? 'auth-server/index.js' : 'auth-server/dev.js'], { windowsHide: true,
    env: { ...process.env, PORT: '0', BIND_HOST: '127.0.0.1', AUTH_DEV_STATE_FILE: path.join(root, 'state.json'), KUA_YIPU_DIAGNOSTIC_DIR: path.join(root, 'reports'),
      ...(database ? { DATABASE_URL: database, PGSSL: 'disable', KUA_YIPU_AUTH_SECRET: 'isolated-diagnostic-test-secret-2026' } : {}),
      KUA_YIPU_ADMIN_USERNAME: 'test', KUA_YIPU_ADMIN_PASSWORD: 'local-test-password' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Auth test did not start')), 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    });
    const api = async (route, body, auth = '', method = 'POST') => {
      const response = await fetch(url + route, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() };
    };
    const admin = (await api('/api/admin/login', { username: 'test', password: 'local-test-password' })).data.token;
    assert.ok(admin);
    const account = 'diagnostic-' + crypto.randomBytes(4).toString('hex');
    const license = (await api('/api/admin/licenses', { alibabaAccount: account, days: 10 }, admin)).data;
    const client = (await api('/api/client/login', { username: account, activationCode: license.activationCode, deviceId: 'diagnostic-device' })).data.token;
    assert.ok(client);
    const payload = { ...report(), note: '<img src=x onerror=alert(1)>', password: 'PRIVATE_PASSWORD', account: 'forged-owner' };
    assert.equal((await api('/api/client/diagnostics', payload)).status, 401);
    assert.equal((await api('/api/client/diagnostics', payload, admin)).status, 401);
    assert.equal((await api('/api/admin/diagnostics', undefined, client, 'GET')).status, 401);
    assert.equal((await api('/api/client/diagnostics', {}, client)).status, 400);
    assert.equal((await api('/api/client/diagnostics', { ...report(), note: 'x'.repeat(8 * 1024 * 1024) }, client)).status, 413);
    const [a, b] = await Promise.all([api('/api/client/diagnostics', payload, client), api('/api/client/diagnostics', payload, client)]);
    assert.equal(a.status, 201); assert.deepEqual(a.data, b.data);
    const items = (await api('/api/admin/diagnostics?search=' + a.data.id, undefined, admin, 'GET')).data;
    assert.equal(items.total, 1); assert.equal(items.items[0].account, account);
    const readback = (await api('/api/admin/diagnostics/' + a.data.id, undefined, admin, 'GET')).data;
    assert.equal(readback.report.note, payload.note); assert.doesNotMatch(JSON.stringify(readback), /PRIVATE_PASSWORD|forged-owner/);
    assert.equal((await api('/api/admin/licenses/' + license.id, { action: 'pause' }, admin, 'PATCH')).status, 200);
    assert.equal((await api('/api/client/diagnostics', report(), client)).status, 403);
  } finally { child.kill(); await exited; fs.rmSync(root, { recursive: true, force: true }); }
});
