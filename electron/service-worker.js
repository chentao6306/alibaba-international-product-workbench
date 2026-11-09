import { parentPort, workerData, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createRuntimeDiagnostics } from '../server/runtime-diagnostics.js';
import { diagnosticCode } from '../auth-server/diagnostic-schema.js';

// Observe without handling: an uncaught exception must still stop the worker.
// This record captures the worker heap, unlike the exit event in the UI process.
let readyReceived = false;
if (process.env.DATA_DIR) {
  const runtimeDiagnostic = createRuntimeDiagnostics(path.join(process.env.DATA_DIR, 'service-runtime.log'));
  process.on('uncaughtExceptionMonitor', (error) => runtimeDiagnostic('service-exception', { code: diagnosticCode(error), reason: 'exception', ...(!readyReceived ? { stage: 'startup' } : {}) }));
}

// Electron-specific APIs are owned by main.js. This worker owns the complete
// API/store/automation lifecycle, including atomic persistence and shutdown.
if (workerData.resourcesPath && !process.resourcesPath) process.resourcesPath = workerData.resourcesPath;
let sequence = 0;
const pending = new Map();
function bridge(method, args = [], extra = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = extra.timeoutMs && setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error('桌面状态暂未响应，正在重新读取；已保存进度保留，请勿重复提交'), {
        code: 'LOCAL_SERVICE_DESKTOP_TIMEOUT', status: 503,
      }));
    }, extra.timeoutMs);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); }, onProgress: extra.onProgress });
    parentPort.postMessage({ type: 'bridge', id, method, args, ...(extra.cancelled ? { cancelled: extra.cancelled } : {}) });
  });
}
function syncBridge(method, args = []) {
  // Only the worker waits. The native window thread remains free to handle
  // paint, input, authorization heartbeats and the bridge response.
  const { port1, port2 } = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  try {
    parentPort.postMessage({ type: 'bridge', method, args, replyPort: port2, signal: signal.buffer }, [port2]);
    const deadline = performance.now() + 15000;
    while (!Atomics.load(signal, 0)) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error('桌面连接暂未响应，请稍后继续');
      Atomics.wait(signal, 0, 0, remaining);
    }
    const reply = receiveMessageOnPort(port1)?.message;
    if (!reply) throw new Error('桌面连接暂未响应，请稍后继续');
    if (reply.error) throw Object.assign(new Error(reply.error.message), reply.error);
    return reply.value;
  } finally { port1.close(); }
}
globalThis.__KUA_YIPU_SECURE_STORAGE = {
  encrypt: (value) => Buffer.from(syncBridge('secure.encrypt', [value])),
  decrypt: (value) => syncBridge('secure.decrypt', [value]),
};
globalThis.__KUA_YIPU_AUTHORIZATION = {
  check: async () => {
    const state = await bridge('authorization', [], { timeoutMs: 2000 });
    process.env.KUA_YIPU_ACCOUNT = state.account || 'local';
    return state;
  },
  valid: () => {
    const state = syncBridge('authorization');
    process.env.KUA_YIPU_ACCOUNT = state.account || 'local';
    return state.valid;
  },
  canRead: () => syncBridge('authorization').canRead,
};
globalThis.__KUA_YIPU_SELLER_BRIDGE = Object.fromEntries(
  ['open', 'openSource', 'sync', 'bind', 'captureReference'].map((name) => [name, (...args) => bridge(`seller.${name}`, args)])
);
globalThis.__KUA_YIPU_SELLER_BRIDGE.status = () => syncBridge('seller.status');
globalThis.__KUA_YIPU_SELLER_BRIDGE.readStatus = () => bridge('seller.status', [], { timeoutMs: 2000 });
globalThis.__KUA_YIPU_SELLER_BRIDGE.humanVerification = async (url, options = {}) => {
  const cancelled = new Int32Array(new SharedArrayBuffer(4));
  const update = () => Atomics.store(cancelled, 0, options.shouldStop?.() ? 1 : 0);
  update();
  const timer = setInterval(update, 200);
  try {
    return await bridge('seller.humanVerification', [url, { userAgent: options.userAgent, requestCookies: options.requestCookies }],
      { cancelled: cancelled.buffer, onProgress: options.onWaiting });
  } finally { clearInterval(timer); Atomics.store(cancelled, 0, 1); }
};
const service = import(pathToFileURL(workerData.entry).href);
parentPort.on('message', async (message) => {
  if (message.type === 'result') {
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request?.reject(Object.assign(new Error(message.error.message), message.error));
    else request?.resolve(message.value);
  } else if (message.type === 'progress') {
    const request = pending.get(message.id);
    try { request?.onProgress?.(message.value); }
    catch (error) {
      pending.delete(message.id);
      request?.reject(error);
    }
  }
  else if (message.type === 'call') {
    try {
      if (!['suspendAuthorizedWork', 'shutdownServer', 'prepareForUpdate', 'cancelUpdatePreparation', 'diagnosticSummary'].includes(message.method)) throw new Error('不支持的后台服务请求');
      const module = await service;
      const value = await module[message.method](...message.args);
      parentPort.postMessage({ type: 'result', id: message.id, value });
    } catch (error) { parentPort.postMessage({ type: 'result', id: message.id, error: { message: error.message, code: error.code } }); }
  }
});
const module = await service;
const listener = await module.serverReady;
const address = listener.address();
if (!address || typeof address !== 'object') throw Object.assign(new Error('本地服务未能监听，请重新加载工作台'), { code: 'LOCAL_SERVICE_NOT_LISTENING' });
readyReceived = true;
parentPort.postMessage({ type: 'ready', port: address.port });
