import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { startLocalService } from '../electron/local-service.js';

// Deliberate heap exhaustion is isolated in a tiny child worker. Require a
// small process heap so running this tool cannot consume normal machine RAM.
assert.ok(v8.getHeapStatistics().heap_size_limit < 128 * 1024 * 1024,
  'Run with node --max-old-space-size=48 tools/local-service-memory-qa.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'service-memory-qa-'));
const workspace = path.join(root, 'workspace.json');
const original = JSON.stringify({ products: [{ id: 'synthetic-saved', title: 'Saved before failure' }], jobs: [] });
fs.writeFileSync(workspace, original);
const fixture = path.join(root, 'fixture.mjs');
fs.writeFileSync(fixture, `
  export const serverReady = Promise.resolve({ address: () => ({ port: 1 }) });
  export const diagnosticSummary = () => {
    queueMicrotask(() => {
      const allocation = [];
      while (true) allocation.push(new Array(100000).fill('bounded-memory-test'));
    });
    return new Promise(() => {});
  };
`);
let finish;
const exited = new Promise(resolve => { finish = resolve; });
const service = startLocalService({ entry: fixture, env: { ...process.env, DATA_DIR: root }, handlers: {},
  onEvent: (event, fields) => finish({ event, ...fields }) });
const timeout = setTimeout(() => { void service.terminate(); }, 20000);
try {
  await service.ready;
  await assert.rejects(service.call('diagnosticSummary'), { code: 'ERR_WORKER_OUT_OF_MEMORY' });
  const event = await exited;
  assert.equal(event.event, 'service-stopped');
  assert.equal(event.code, 'ERR_WORKER_OUT_OF_MEMORY');
  assert.equal(event.expected, false);
  assert.equal(event.reason, 'oom');
  assert.equal(fs.readFileSync(workspace, 'utf8'), original);
  const result = { ok: true, actualHeapExhaustion: true, parentStillRunning: true, savedDataUnchanged: true,
    heapLimit: v8.getHeapStatistics().heap_size_limit, event };
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, root }));
} finally {
  clearTimeout(timeout);
  await service.terminate();
}
