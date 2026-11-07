import test from 'node:test';
import assert from 'node:assert/strict';
import { readImageDrafts } from '../src/image-draft-request.js';

test('image draft reads time out during both response and body reads', async () => {
  for (const bodyHangs of [false, true]) {
    const fetchImpl = (_url, { signal }) => {
      const hanging = new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return bodyHangs ? Promise.resolve({ ok: true, json: () => hanging }) : hanging;
    };
    await assert.rejects(readImageDrafts(['A'], { timeoutMs: 10, fetchImpl }), /读取商品图片超时.*重新读取图片/);
  }
});

test('closing the image editor cancels its pending read and a new batch reads independently', async () => {
  const controller = new AbortController();
  const pending = readImageDrafts(['A'], { signal: controller.signal, fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(await readImageDrafts(['B'], { fetchImpl: async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body).ids, ['B']);
    assert.equal(options.signal.aborted, false);
    return { ok: true, json: async () => [{ id: 'B' }] };
  } }), [{ id: 'B' }]);
});
