import { Worker } from 'node:worker_threads';

// The API and browser automation must never execute on Electron's window
// thread. Only the narrow session/window/encryption bridge stays on that thread.
export function startLocalService({ entry, env, resourcesPath, handlers, onEvent = () => {}, workerUrl = new URL('./service-worker.js', import.meta.url) }) {
  const worker = new Worker(workerUrl, { workerData: { entry, resourcesPath }, env });
  const pending = new Map();
  let sequence = 0;
  let stopped = false;
  let state = { status: 'starting', message: '本地服务启动中' };
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const fail = (error) => {
    if (stopped) return;
    stopped = true;
    state = { status: 'stopped', code: error.code || 'LOCAL_SERVICE_STOPPED', message: error.message };
    try { onEvent('service-stopped', { code: state.code }); } catch {}
    rejectReady(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  worker.on('error', fail);
  worker.on('exit', () => fail(new Error('后台任务服务已停止，请重新打开软件；已保存进度保留')));
  worker.on('message', async (message) => {
    if (message.type === 'ready') { state = { status: 'running' }; resolveReady(message.port); return; }
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
    if (stopped) return Promise.reject(new Error('后台任务服务已停止，已保存进度保留'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ type: 'call', id, method, args });
    });
  }
  return { ready, call, status: () => ({ ...state }), terminate: () => worker.terminate() };
}
