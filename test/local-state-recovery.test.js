import test from 'node:test';
import assert from 'node:assert/strict';
import { localConnectionFailure, localConnectionLabel, localFetch } from '../src/local-api.js';
import { createStateRefresher } from '../src/state-refresh.js';

test('a hung desktop diagnostic does not keep failed state reads in flight or prevent recovery', { timeout: 3000 }, async t => {
  let requests = 0, connection;
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    if (!requests++) throw new DOMException('State read timed out', 'TimeoutError');
    return { json: async () => ({ progress: 7 }) };
  });
  const refresh = createStateRefresher(async () => {
    try {
      const result = await (await localFetch('/api/state')).json();
      connection = { status: 'running' };
      return result;
    } catch (error) {
      connection = await localConnectionFailure(error, () => new Promise(() => {}), { timeoutMs: 20 });
      throw error;
    }
  });
  const first = refresh({ fresh: false });
  assert.equal(refresh({ fresh: false }), first);
  await assert.rejects(first, { code: 'LOCAL_API_TIMEOUT' });
  assert.equal(localConnectionLabel(connection), '本地服务响应超时');
  assert.deepEqual(await refresh({ fresh: false }), { progress: 7 });
  assert.equal(localConnectionLabel(connection), '运行正常');
  assert.equal(fetch.mock.calls.length, 2);
  assert.ok(fetch.mock.calls.every(call => call.arguments[0] === '/api/state'
    && !call.arguments[1].method), 'recovery must only reread progress');
});

test('late, rejected and synchronous diagnostic errors cannot replace the original connection failure', async () => {
  const error = Object.assign(new Error('Local API unavailable'), { code: 'LOCAL_API_UNREACHABLE' });
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const failure = await localConnectionFailure(error, () => pending, { timeoutMs: 10 });
  resolve({ status: 'stopped', code: 'ERR_WORKER_OUT_OF_MEMORY' });
  await Promise.resolve();
  assert.equal(failure.kind, 'unreachable');
  assert.equal(failure.code, 'LOCAL_API_UNREACHABLE');
  for (const read of [undefined, () => { throw Error('IPC unavailable'); }, () => Promise.reject(Error('IPC unavailable'))]) {
    const result = await localConnectionFailure(error, read);
    assert.equal(result.kind, 'unreachable');
    assert.match(result.message, /暂时无法连接本地服务/);
  }
});

test('confirmed worker stops, authorization failures and stopped tasks have distinct labels', async () => {
  const error = Object.assign(new Error('Local API unavailable'), { code: 'LOCAL_API_UNREACHABLE' });
  const stopped = await localConnectionFailure(error, async () => ({ status: 'stopped', code: 'ERR_WORKER_OUT_OF_MEMORY' }));
  assert.equal(localConnectionLabel(stopped), '本地服务已停止');
  assert.match(stopped.message, /运行时堆内存限制/);
  let diagnosticCalls = 0;
  const denied = await localConnectionFailure({ status: 401, message: '授权连接中断' }, () => { diagnosticCalls++; });
  assert.equal(localConnectionLabel(denied), '授权待恢复');
  assert.equal(diagnosticCalls, 0, 'an HTTP authorization response proves the local service responded');
  const desktop = await localConnectionFailure({ status: 503, code: 'LOCAL_SERVICE_DESKTOP_TIMEOUT', message: '桌面状态暂未响应' }, () => { diagnosticCalls++; });
  assert.equal(localConnectionLabel(desktop), '桌面连接响应超时');
  assert.equal(diagnosticCalls, 0, 'a bridge timeout must not be reported as a stopped service or another unreachable IPC');
  assert.equal(localConnectionLabel({ status: 'error', kind: 'task' }), '后台任务已停止');
  assert.equal(localConnectionLabel({ status: 'error', kind: 'task', code: 'ENOSPC' }), '存储异常');
  const readFailure = await localConnectionFailure({ status: 500, message: '读取失败', code: 'ERR_STRING_TOO_LONG' });
  assert.equal(localConnectionLabel(readFailure), '进度读取异常');
  assert.equal(readFailure.message, '读取失败');
});
