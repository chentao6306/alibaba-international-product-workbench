import { parentPort, workerData, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

// Electron-specific APIs are owned by main.js. This worker owns the complete
// API/store/automation lifecycle, including atomic persistence and shutdown.
if (workerData.resourcesPath && !process.resourcesPath) process.resourcesPath = workerData.resourcesPath;
let sequence = 0;
const pending = new Map();
function bridge(method, args = [], extra = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress: extra.onProgress });
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
globalThis.__KUA_YIPU_SELLER_BRIDGE.humanVerification = async (url, options = {}) => {
  const cancelled = new Int32Array(new SharedArrayBuffer(4));
  const update = () => Atomics.store(cancelled, 0, options.shouldStop?.() ? 1 : 0);
  update();
  const timer = setInterval(update, 200);
  try {
    return await bridge('seller.humanVerification', [url, { userAgent: options.userAgent, requestCookies: options.requestCookies }],
      { cancelled: cancelled.buffer, onProgress: options.onWaiting });
  } finally { clearInterval(timer); }
};
const service = import(pathToFileURL(workerData.entry).href);
parentPort.on('message', async (message) => {
  if (message.type === 'result') {
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request?.reject(Object.assign(new Error(message.error.message), message.error));
    else request?.resolve(message.value);
  } else if (message.type === 'progress') pending.get(message.id)?.onProgress?.(message.value);
  else if (message.type === 'call') {
    try {
      if (!['suspendAuthorizedWork', 'shutdownServer'].includes(message.method)) throw new Error('不支持的后台服务请求');
      const module = await service;
      const value = await module[message.method](...message.args);
      parentPort.postMessage({ type: 'result', id: message.id, value });
    } catch (error) { parentPort.postMessage({ type: 'result', id: message.id, error: { message: error.message, code: error.code } }); }
  }
});
const module = await service;
const listener = await module.serverReady;
parentPort.postMessage({ type: 'ready', port: listener.address().port });
