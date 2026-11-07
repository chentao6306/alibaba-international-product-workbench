import { Worker } from 'node:worker_threads';
import { diagnosticCode } from '../auth-server/diagnostic-schema.js';

// The API and browser automation must never execute on Electron's window
// thread. Only the narrow session/window/encryption bridge stays on that thread.
export function startLocalService({ entry, env, resourcesPath, handlers, onEvent = () => {}, workerUrl = new URL('./service-worker.js', import.meta.url) }) {
  const worker = new Worker(workerUrl, { workerData: { entry, resourcesPath }, env });
  const pending = new Map();
  let sequence = 0;
  let stopped = false;
  let readyReceived = false;
  let terminationRequested = false;
  let terminalError;
  let termination;
  let state = { status: 'starting', message: '本地服务启动中' };
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const stop = (error, expected = false) => {
    if (stopped) return;
    stopped = true;
    const classified = diagnosticCode(error);
    state = { status: 'stopped', code: classified === 'UNKNOWN_ERROR' ? 'LOCAL_SERVICE_STOPPED' : classified,
      message: error.message, expected };
    rejectReady(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  worker.on('error', (error) => {
    terminalError = error;
    stop(error);
  });
  worker.on('exit', (exitCode) => {
    // A clean exit is still unexpected unless this owner requested it. An
    // observed exception must not be hidden by a later cleanup terminate().
    const expected = terminationRequested && !terminalError;
    const error = terminalError || Object.assign(new Error(expected
      ? '本地后台服务已按请求关闭，已保存进度保留'
      : '后台任务服务已停止，请重新打开软件；已保存进度保留'), {
      code: expected ? 'LOCAL_SERVICE_TERMINATED' : 'LOCAL_SERVICE_STOPPED',
    });
    stop(error, expected);
    const classified = diagnosticCode(error);
    state = { ...state, code: classified === 'UNKNOWN_ERROR' ? 'LOCAL_SERVICE_STOPPED' : classified,
      message: error.message, exitCode, expected };
    try { onEvent(expected ? 'service-exited' : 'service-stopped', {
      code: state.code, exitCode, expected,
      reason: expected ? 'requested' : state.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'oom' : terminalError ? 'exception' : 'exit',
      ...(!readyReceived ? { stage: 'startup' } : {}),
    }); } catch {}
  });
  worker.on('message', async (message) => {
    if (stopped) return;
    if (message.type === 'ready') { readyReceived = true; state = { status: 'running' }; resolveReady(message.port); return; }
    if (message.type === 'result') {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(Object.assign(new Error(message.error.message), message.error));
      else request?.resolve(message.value);
      return;
    }
    if (message.type !== 'bridge') return;
    let reply;
    try {
      const handler = Object.hasOwn(handlers, message.method) && handlers[message.method];
      if (typeof handler !== 'function') throw new Error('不支持的桌面服务请求');
      const args = message.args || [];
      if (message.method === 'seller.humanVerification') {
        const cancelled = new Int32Array(message.cancelled);
        args[1] = { ...args[1], shouldStop: () => stopped || Atomics.load(cancelled, 0) === 1,
          onWaiting: (value) => { if (!stopped) worker.postMessage({ type: 'progress', id: message.id, value }); } };
      }
      reply = { value: await handler(...args) };
    } catch (error) { reply = { error: { message: error.message, code: error.code } }; }
    if (message.replyPort) {
      message.replyPort.postMessage(reply);
      message.replyPort.close();
      const signal = new Int32Array(message.signal);
      Atomics.store(signal, 0, 1);
      Atomics.notify(signal, 0);
    } else if (!stopped) worker.postMessage({ type: 'result', id: message.id, ...reply });
  });
  function call(method, ...args) {
    if (stopped) return Promise.reject(Object.assign(new Error('后台任务服务已停止，已保存进度保留'), { code: state.code }));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ type: 'call', id, method, args });
    });
  }
  function terminate() {
    if (!termination) {
      terminationRequested = true;
      if (!terminalError) stop(Object.assign(new Error('本地后台服务已按请求关闭，已保存进度保留'), { code: 'LOCAL_SERVICE_TERMINATED' }), true);
      termination = worker.terminate();
    }
    return termination;
  }
  return { ready, call, status: () => ({ ...state }), terminate };
}
