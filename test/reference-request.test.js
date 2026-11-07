import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceRequest } from '../src/reference-request.js';

test('reference reads time out through response and body reads without retrying or saving', async () => {
  for (const bodyHangs of [false, true]) {
    let calls = 0;
    const fetchImpl = (_url, { signal }) => {
      calls++;
      const pending = new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return bodyHangs ? Promise.resolve({ ok: true, json: () => pending }) : pending;
    };
    await assert.rejects(referenceRequest('/api/products/reference/preview', { ids: ['one'] }, { timeoutMs: 10, fetchImpl }), /超时.*尚未保存/);
    assert.equal(calls, 1);
  }
});

test('reference saving never retries an uncertain response and requires result verification', async () => {
  let calls = 0;
  await assert.rejects(referenceRequest('/api/products/reference', { previewToken: 'reviewed' }, { timeoutMs: 10,
    fetchImpl: (_url, { signal }) => { calls++; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); },
  }), /保存响应超时.*核对.*勿重复保存/);
  assert.equal(calls, 1);
  await assert.rejects(referenceRequest('/api/products/reference', {}, {
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
  }), /保存结果尚未确认.*核对/);
});

test('reference request preserves stale-token rejection and sends exact preview pagination', async () => {
  const body = { ids: ['one', 'two'], referenceId: 'r', page: 2, pageSize: 30 };
  assert.deepEqual(await referenceRequest('/api/products/reference/preview', body, { fetchImpl: async (url, options) => {
    assert.equal(url, '/api/products/reference/preview');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), body);
    return { ok: true, json: async () => ({ token: 'all-ids-token', total: 2, totalChanged: 1, items: [] }) };
  } }), { token: 'all-ids-token', total: 2, totalChanged: 1, items: [] });
  await assert.rejects(referenceRequest('/api/products/reference', {}, { fetchImpl: async () => ({ ok: false, status: 409,
    json: async () => ({ error: '商品或引用内容已变化，请重新预览后保存' }) }),
  }), { message: '商品或引用内容已变化，请重新预览后保存', status: 409 });
});

test('closing a reference dialog aborts its pending read without presenting a timeout', async () => {
  const controller = new AbortController();
  const promise = referenceRequest('/api/references', undefined, { signal: controller.signal,
    fetchImpl: (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  });
  controller.abort();
  await assert.rejects(promise, { name: 'AbortError' });
});
