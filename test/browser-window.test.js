import test from 'node:test';
import assert from 'node:assert/strict';
import { revealPage, hidePage } from '../server/browser-runtime.js';

test('restores a minimized publishing window before maximizing and always releases the debug session', async () => {
  const commands = []; let detached = 0; let broughtForward = false;
  const page = { isClosed: () => false, bringToFront: async () => { broughtForward = true; }, context: () => ({ newCDPSession: async () => ({
    send: async (command, args) => {
      if (command === 'Browser.getWindowForTarget') return { windowId: 7, bounds: { windowState: 'minimized' } };
      commands.push(args.bounds.windowState);
      if (commands[0] !== 'normal') throw new Error('Window must be restored before maximizing');
    }, detach: async () => { detached++; },
  }) }) };
  assert.equal(await revealPage(page), true);
  assert.deepEqual(commands, ['normal', 'maximized']);
  assert.equal(broughtForward, true); assert.equal(detached, 1);
  page.context = () => ({ newCDPSession: async () => ({ send: async () => { throw new Error('Target gone'); }, detach: async () => { detached++; } }) });
  assert.equal(await revealPage(page), false);
  assert.equal(detached, 2);
});

test('moves a hidden collection window off screen using Chromium bounds names', async () => {
  let bounds;
  const page = { isClosed: () => false, context: () => ({ newCDPSession: async () => ({
    send: async (command, args) => { if (args) bounds = args.bounds; return { windowId: 1 }; }, detach: async () => {},
  }) }) };
  assert.equal(await hidePage(page), true);
  assert.deepEqual(bounds, { windowState: 'normal', left: -32000, top: -32000, width: 1280, height: 900 });
});
