import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { AnnouncementInbox } from '../server/announcements.js';

test('deleted announcements disappear on refresh and next login with receipts pruned for every account', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'announcement-sync-'));
  let items = [{ id: 'notice', revision: 1, title: 'Notice', content: 'Text', kind: 'popup' }];
  const server = http.createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(items)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const file = path.join(root, 'reads.json');
  try {
    const inbox = new AnnouncementInbox(file, url, 'A');
    assert.equal((await inbox.list())[0].read, false);
    inbox.markRead('notice', 1); inbox.account = 'B'; inbox.markRead('notice', 1);
    items = [];
    assert.deepEqual(await inbox.list({ refresh: true }), []);
    assert.deepEqual(inbox.readState(), { A: {}, B: {} });
    assert.throws(() => inbox.markRead('notice', 1), /公告已更新/);
    assert.deepEqual(await new AnnouncementInbox(file, url, 'A').list(), []);
    items = [{ id: 'new', revision: 1, title: 'New', content: 'Text' }];
    assert.equal((await inbox.list({ refresh: true }))[0].read, false);
    inbox.markRead('new', 1);
    items = [{ id: 'bad' }];
    await assert.rejects(inbox.list({ refresh: true }), /格式异常/);
    assert.equal(inbox.readState().B.new, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
