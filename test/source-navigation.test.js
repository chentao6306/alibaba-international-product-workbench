import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { navigateSourceWindow, sourceProductUrl } from '../electron/source-navigation.js';

const product = 'https://www.alibaba.com/product-detail/Product_1601424068521.html';
function fixture(load) {
  const contents = new EventEmitter();
  let url = 'about:blank', shown = false, destroyed = false;
  contents.getURL = () => url;
  contents.isDestroyed = () => destroyed;
  const commit = (target = product) => {
    contents.emit('did-start-navigation', {}, target, false, true);
    url = target;
    contents.emit('did-navigate', {}, target);
    contents.emit('dom-ready');
  };
  const window = { webContents: contents, setSkipTaskbar() {}, show() { shown = true; }, restore() {}, maximize() {}, focus() {},
    isMinimized: () => true, isVisible: () => shown, isDestroyed: () => destroyed,
    loadURL: async target => { assert.equal(shown, true); await load({ contents, commit, target }); } };
  return { window, contents, close() { destroyed = true; contents.emit('destroyed'); } };
}

test('source URLs reject credentials, unsupported protocols and lookalike hosts', () => {
  assert.equal(sourceProductUrl(product), product);
  for (const bad of ['file://www.alibaba.com/product-detail/test', 'https://alibaba.com.evil.test/product-detail/x',
    'https://name:secret@www.alibaba.com/product-detail/x', 'javascript:alert(1)', 'https://www.alibaba.com/login']) {
    assert.throws(() => sourceProductUrl(bad));
  }
});

test('shows source window immediately and accepts a committed redirect after ERR_ABORTED', async () => {
  const { window, contents } = fixture(async ({ commit }) => {
    setTimeout(() => commit('https://www.alibaba.com/product-detail/New_1601424068521.html'), 15);
    throw Object.assign(new Error('ERR_ABORTED'), { errno: -3 });
  });
  assert.equal((await navigateSourceWindow(window, product, { timeoutMs: 1000 })).visible, true);
  assert.equal(contents.eventNames().length, 0);
});

test('aborted navigation alone cannot report success or mistake the previous document for the new one', async () => {
  const { window, contents } = fixture(async ({ contents }) => {
    contents.emit('dom-ready');
    throw new Error('ERR_ABORTED');
  });
  await assert.rejects(navigateSourceWindow(window, product, { timeoutMs: 30 }), /加载超时/);
  assert.equal(window.isVisible(), true);
  assert.equal(contents.eventNames().length, 0);
});

test('real network errors and closing the window release all pending listeners', async () => {
  const network = fixture(async ({ contents }) => {
    contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', product, true);
    throw new Error('ERR_NAME_NOT_RESOLVED');
  });
  await assert.rejects(navigateSourceWindow(network.window, product), /ERR_NAME_NOT_RESOLVED/);
  assert.equal(network.contents.eventNames().length, 0);
  const closed = fixture(async () => new Promise(() => {}));
  const waiting = navigateSourceWindow(closed.window, product);
  closed.close();
  await assert.rejects(waiting, /窗口已关闭/);
  assert.equal(closed.contents.eventNames().length, 0);
});

test('a newer source click supersedes the old request without a misleading failure', async () => {
  let calls = 0;
  const { window, contents } = fixture(async ({ commit }) => {
    if (++calls === 1) return new Promise(() => {});
    commit();
  });
  const first = navigateSourceWindow(window, product);
  await Promise.resolve();
  const second = navigateSourceWindow(window, product);
  assert.equal((await first).superseded, true);
  assert.equal((await second).visible, true);
  assert.equal(contents.eventNames().length, 0);
});
