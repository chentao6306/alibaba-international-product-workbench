import test from 'node:test';
import assert from 'node:assert/strict';
import { localFetch, localConnectionMessage } from '../src/local-api.js';

test('a disconnected submission is not retried and tells users to check progress before submitting again', async t => {
  const mocked = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(localFetch('/api/publish', { method: 'POST', body: '{}' }), error => error.code === 'LOCAL_API_UNREACHABLE' && /请勿重复提交/.test(error.message));
  assert.equal(mocked.mock.calls.length, 1);
});

test('timeouts and desktop service failures report local causes separately from product validation', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('timed out', 'TimeoutError'); });
  await assert.rejects(localFetch('/api/state'), { code: 'LOCAL_API_TIMEOUT' });
  assert.match(localConnectionMessage({ status: 'stopped', freeBytes: 1000 }), /磁盘空间不足/);
  assert.match(localConnectionMessage({ status: 'stopped', freeBytes: 1e9 }), /后台服务已停止.*最后一次/);
  assert.match(localConnectionMessage({ status: 'running' }, true), /响应超时/);
  const workerMemory = localConnectionMessage({ status: 'stopped', code: 'ERR_WORKER_OUT_OF_MEMORY' });
  assert.match(workerMemory, /堆内存限制.*图片保存/);
  assert.doesNotMatch(workerMemory, /关闭其他/);
  const stringLimit = localConnectionMessage({ status: 'stopped', code: 'ERR_STRING_TOO_LONG' });
  assert.match(stringLimit, /数据处理失败.*字符串长度限制.*进度保留.*不要重复提交/);
  assert.doesNotMatch(stringLimit, /关闭其他|内存不足/);
});
