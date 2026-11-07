import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWorkbenchStartup, workbenchErrorMessage } from '../electron/workbench-startup.js';

const url = 'http://127.0.0.1:8787/';
function fixture(handler) {
  const window = new EventEmitter();
  const contents = new EventEmitter();
  window.webContents = contents;
  window.destroyed = false;
  window.isDestroyed = contents.isDestroyed = () => window.destroyed;
  window.urls = [];
  contents.url = '';
  contents.getURL = () => contents.url;
  contents.executeJavaScript = async () => contents.rendered || false;
  window.loadURL = async (next) => {
    window.urls.push(next);
    if (handler) return handler(next, window);
    contents.url = next;
    contents.rendered = next === url;
    contents.emit('did-finish-load');
  };
  return window;
}
const options = { url, loadingUrl: 'data:text/html,loading', ensureServer: async () => {}, navigationTimeoutMs: 80, retryDelayMs: 1, renderAttempts: 1 };

test('concurrent entry calls share the placeholder, service start and workbench navigation', async () => {
  let starts = 0, release;
  const service = new Promise((resolve) => { release = resolve; });
  const loader = createWorkbenchStartup({ ...options, ensureServer: async () => { starts++; await service; } });
  const window = fixture();
  const runs = Array.from({ length: 20 }, () => loader.start(window));
  assert.ok(runs.every((run) => run === runs[0]));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(starts, 1);
  release();
  assert.ok((await Promise.all(runs)).every(Boolean));
  assert.deepEqual(window.urls, [options.loadingUrl, url]);
  assert.equal(await loader.start(window), true);
  assert.equal(window.urls.length, 2, 'Entering an already rendered workbench must not reload user edits');
});

test('placeholder and subframe events cannot consume the real completion listener after ERR_ABORTED', async () => {
  const window = fixture(async (next, w) => {
    w.webContents.url = next;
    if (next !== url) return;
    w.webContents.url = options.loadingUrl;
    w.webContents.emit('did-finish-load');
    w.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://image.example/', false);
    w.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', url, true);
    setTimeout(() => {
      w.webContents.url = url; w.webContents.rendered = true;
      w.webContents.emit('did-finish-load');
    }, 15);
    throw Object.assign(new Error(`ERR_ABORTED (-3) loading '${url}'`), { errno: -3 });
  });
  const errors = [];
  const loader = createWorkbenchStartup({ ...options, onError: (error) => errors.push(error) });
  assert.equal(await loader.start(window), true);
  assert.equal(window.urls.filter((next) => next === url).length, 1);
  assert.deepEqual(errors, []);
  assert.equal(window.webContents.listenerCount('did-finish-load'), 0);
  assert.equal(window.webContents.listenerCount('did-fail-load'), 0);
});

test('a real service failure displays one bounded error and a later entry can recover', async () => {
  const window = fixture();
  let available = false;
  const loader = createWorkbenchStartup({ ...options, ensureServer: async () => { if (!available) throw new Error('本地服务暂时不可用'); } });
  assert.equal(await loader.start(window), false);
  assert.match(decodeURIComponent(window.urls.at(-1)), /本地服务暂时不可用/);
  loader.showError(window, new Error(`ERR_ABORTED (-3) loading '${window.urls.at(-1)}'`));
  assert.equal(window.urls.length, 2, 'An error-page cancellation must not recursively replace its own page');
  available = true;
  assert.equal(await loader.start(window), true);
  assert.equal(window.webContents.url, url);
});

test('late completion from a failed startup cannot replace a newer error view', async () => {
  let release;
  const window = fixture();
  const loader = createWorkbenchStartup({ ...options, ensureServer: () => new Promise((resolve) => { release = resolve; }) });
  const run = loader.start(window);
  await new Promise((resolve) => setTimeout(resolve, 5));
  loader.showError(window, new Error('工作台页面异常停止'));
  release();
  assert.equal(await run, false);
  assert.equal(window.urls.includes(url), false);
  assert.match(decodeURIComponent(window.urls.at(-1)), /工作台页面异常停止/);
});

test('a second renderer failure remains recoverable after using the retry button', async () => {
  const window = fixture();
  const loader = createWorkbenchStartup(options);
  await loader.start(window);
  loader.showError(window, new Error('第一次渲染失败'));
  await window.loadURL(url);
  loader.showError(window, new Error('第二次渲染失败'));
  assert.match(decodeURIComponent(window.urls.at(-1)), /第二次渲染失败/);
});

test('closed windows stop navigation and unresolved aborts eventually produce a retryable error', async () => {
  const window = fixture(async (next, w) => {
    w.webContents.url = next;
    if (next === url) throw Object.assign(new Error('ERR_ABORTED'), { errno: -3 });
  });
  const loader = createWorkbenchStartup({ ...options, navigationTimeoutMs: 10 });
  assert.equal(await loader.start(window), false);
  assert.equal(window.urls.filter((next) => next === url).length, 3);
  assert.match(decodeURIComponent(window.urls.at(-1)), /页面加载超时/);
  window.destroyed = true;
  assert.equal(await loader.start(window), false);
});

test('startup error messages never embed local page markup, URLs or unbounded nested errors', () => {
  for (const message of ["ERR_ABORTED (-3) loading 'data:text/html,%3Chtml...'", "ERR_FAILED loading 'http://127.0.0.1:8787/'", 'data:text/html,' + 'a'.repeat(10000)]) {
    const text = workbenchErrorMessage(new Error(message));
    assert.ok(text.length < 100);
    assert.doesNotMatch(text, /ERR_|data:|127\.0\.0\.1|%3C/);
  }
  assert.equal(workbenchErrorMessage(new Error('本地磁盘空间不足')), '本地磁盘空间不足');
});
