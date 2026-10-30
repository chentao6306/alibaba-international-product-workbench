import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installWorkbenchRequestGate, showWindowWhenReady } from '../electron/window-lifecycle.js';

function fixture(session, id) {
  const window = new EventEmitter(), contents = new EventEmitter();
  let destroyed = false;
  Object.assign(contents, { id, session, isDestroyed: () => destroyed });
  Object.defineProperty(window, 'webContents', { get() { if (destroyed) throw new Error('Object has been destroyed'); return contents; } });
  window.isDestroyed = () => destroyed;
  window.show = () => { assert.equal(destroyed, false); window.shown = true; };
  window.destroy = () => { destroyed = true; contents.emit('destroyed'); window.emit('closed'); };
  return window;
}

test('late session requests after workbench destruction complete without touching native objects or adding authorization', () => {
  let callback;
  const session = { webRequest: { onBeforeSendHeaders: (_filter, listener) => { callback = listener; } } };
  const first = fixture(session, 1);
  installWorkbenchRequestGate(first, { port: 8787, gate: 'first-gate' });
  const request = (id, url = 'http://127.0.0.1:8787/api/state') => {
    let result, replies = 0;
    assert.doesNotThrow(() => callback({ webContentsId: id, url, requestHeaders: {} }, value => { result = value; replies++; }));
    assert.equal(replies, 1);
    return result.requestHeaders;
  };
  assert.equal(request(1)['X-Kua-Yipu-Gate'], 'first-gate');
  assert.deepEqual(request(99), {});
  const replacement = fixture(session, 2);
  installWorkbenchRequestGate(replacement, { port: 8787, gate: 'replacement-gate' });
  first.destroy();
  assert.deepEqual(request(1), {});
  assert.equal(request(2)['X-Kua-Yipu-Gate'], 'replacement-gate');
  assert.deepEqual(request(2, 'https://www.alibaba.com/api/state'), {});
  replacement.destroy();
  assert.deepEqual(request(2), {});
});

test('a delayed ready event from a closed login window never displays it or its replacement', () => {
  const old = fixture({}, 1), next = fixture({}, 2);
  showWindowWhenReady(old); showWindowWhenReady(next);
  old.destroy();
  assert.doesNotThrow(() => old.emit('ready-to-show'));
  assert.equal(next.shown, undefined);
  next.emit('ready-to-show');
  assert.equal(next.shown, true);
});
