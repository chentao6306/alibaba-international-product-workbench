import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import sharp from 'sharp';
import { announcementInput } from '../auth-server/policy.js';
import { announcementBlocks, nextAnnouncementPopup } from '../auth-server/announcement-content.js';
import { AnnouncementInbox } from '../server/announcements.js';

const imagePath = `/api/announcement-images/${'a'.repeat(64)}.webp`;

test('announcements accept legacy text, images alone and ordered text/image blocks with explicit popup frequency', () => {
  const text = announcementInput({ title: 'Text', content: 'Plain <b>text</b>' });
  assert.deepEqual(text.blocks, [{ type: 'text', text: 'Plain <b>text</b>' }]);
  assert.deepEqual(announcementBlocks({ content: 'Old notice', blocks: [] }), [{ type: 'text', text: 'Old notice' }]);
  const blocks = [{ type: 'text', text: 'Before' }, { type: 'image', src: imagePath, alt: 'Picture' }, { type: 'text', text: 'After' }];
  const mixed = announcementInput({ title: 'Mixed', blocks, kind: 'popup', popup_policy: 'every-login' });
  assert.deepEqual(mixed.blocks, blocks);
  assert.equal(mixed.popup_policy, 'every-login');
  assert.match(mixed.content, /Before[\s\S]*图片[\s\S]*After/);
  assert.equal(announcementInput({ title: 'Image', blocks: [blocks[1]] }).blocks.length, 1);
  assert.equal(announcementInput({ title: 'Text', content: 'T', popup_policy: 'every-login' }).popup_policy, 'once');
});

test('announcement blocks reject remote or executable images, oversized content and unknown popup policies', () => {
  const invalid = [
    {}, { blocks: null }, { blocks: 'text' }, { blocks: [{ type: 'html', text: '<img onerror=alert(1)>' }] },
    ...['https://evil.test/a.webp', 'javascript:alert(1)', 'data:image/svg+xml,xxx', '/api/announcement-images/../../file', `${imagePath}?x=1`].map(src => ({ blocks: [{ type: 'image', src }] })),
    { blocks: Array.from({ length: 11 }, () => ({ type: 'image', src: imagePath })) },
    { blocks: Array.from({ length: 41 }, () => ({ type: 'text', text: 'T' })) },
    { blocks: [{ type: 'text', text: 'x'.repeat(20001) }] },
    { content: 'T', popup_policy: 'forever' },
  ];
  for (const item of invalid) assert.throws(() => announcementInput({ title: 'Test', ...item }), { status: 400 });
});

test('every-entry popups ignore old read receipts but are dismissed once per entry and revision', () => {
  const once = { id: 'once', revision: 1, kind: 'popup', read: true };
  const always = { id: 'always', revision: 1, kind: 'popup', popup_policy: 'every-login', read: true };
  const list = { ...always, id: 'list', kind: 'notice' };
  const seen = new Set();
  assert.equal(nextAnnouncementPopup([once, list, always], seen), always);
  seen.add('always:1');
  assert.equal(nextAnnouncementPopup([once, list, always], seen), null);
  assert.equal(nextAnnouncementPopup([once, always], new Set()), always);
  assert.equal(nextAnnouncementPopup([{ ...always, revision: 2 }], seen).revision, 2);
  assert.equal(nextAnnouncementPopup([{ ...once, read: false }], seen).id, 'once');
});

test('uploaded notice images remain private until publication and survive editing and service restart', { timeout: 45000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-media-'));
  const database = process.env.AUTH_TEST_DATABASE_URL;
  if (database && !/^\/auth_qa_[a-z0-9_]+$/.test(new URL(database).pathname)) throw Error('Use an isolated auth_qa_ database');
  let child, exited, endpoint, token;
  async function start() {
    child = spawn(process.execPath, [database ? 'auth-server/index.js' : 'auth-server/dev.js'], { windowsHide: true, env: {
      ...process.env, PORT: '0', BIND_HOST: '127.0.0.1', AUTH_DEV_STATE_FILE: path.join(root, 'state.json'),
      KUA_YIPU_ANNOUNCEMENT_DIR: path.join(root, 'images'), KUA_YIPU_UPDATE_DIR: path.join(root, 'updates'),
      KUA_YIPU_ADMIN_USERNAME: 'test', KUA_YIPU_ADMIN_PASSWORD: 'local-test-password',
      ...(database ? { DATABASE_URL: database, PGSSL: 'disable', KUA_YIPU_AUTH_SECRET: 'isolated-auth-test-signing-secret-2026' } : {}),
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    exited = once(child, 'exit');
    endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Notice test service failed to start')), 10000);
      child.stdout.on('data', chunk => { const url = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; if (url) { clearTimeout(timer); resolve(url); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    token = (await json('/api/admin/login', { username: 'test', password: 'local-test-password' })).data.token;
    assert.ok(token);
  }
  async function json(route, body, method = 'POST') {
    const response = await fetch(endpoint + route, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token || ''}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  const upload = (body, credential = token, type = 'image/png') => fetch(endpoint + '/api/admin/announcement-images', { method: 'POST', headers: { 'content-type': type, authorization: `Bearer ${credential}` }, body });
  try {
    await start();
    const bytes = await sharp({ create: { width: 100, height: 60, channels: 4, background: '#118363' } }).png().toBuffer();
    assert.equal((await upload(bytes, '')).status, 401);
    assert.equal((await upload(Buffer.from('<svg onload="alert(1)"></svg>'))).status, 400);
    assert.equal((await upload(Buffer.alloc(8 * 1024 * 1024 + 1))).status, 413);
    const result = await upload(bytes); assert.equal(result.status, 201);
    const image = await result.json();
    assert.equal(image.width, 100);
    assert.equal((await upload(bytes)).status, 201, 're-uploading the same image remains valid');
    assert.equal((await fetch(endpoint + image.src)).status, 404, 'unattached uploads are private');
    const adminImage = await fetch(endpoint + image.src.replace('/api/', '/api/admin/'), { headers: { authorization: `Bearer ${token}` } });
    assert.equal(adminImage.status, 200);
    assert.match(adminImage.headers.get('content-type'), /image\/webp/);
    assert.equal((await sharp(Buffer.from(await adminImage.arrayBuffer())).metadata()).width, 100);
    assert.equal((await json('/api/admin/announcements', { title: 'Missing', blocks: [{ type: 'image', src: imagePath }] })).status, 400);
    const draft = (await json('/api/admin/announcements', { title: 'Image notice', blocks: [{ type: 'image', src: image.src, alt: '<script>literal</script>' }], kind: 'popup', popup_policy: 'every-login' })).data;
    assert.ok(draft.id);
    assert.equal((await fetch(endpoint + image.src)).status, 404);
    const published = (await json(`/api/admin/announcements/${draft.id}`, { ...draft, status: 'published' }, 'PATCH')).data;
    assert.equal((await fetch(endpoint + image.src)).status, 200);
    const inbox = new AnnouncementInbox(path.join(root, 'reads.json'), endpoint, 'test');
    const [item] = await inbox.list();
    assert.equal(item.blocks[0].src, endpoint + image.src, 'client resolves images against the authorization server, not its local API');
    assert.equal(item.popup_policy, 'every-login');
    inbox.markRead(item.id, item.revision);
    assert.equal((await inbox.list())[0].read, true);
    child.kill(); await exited; await start();
    assert.equal((await fetch(endpoint + image.src)).status, 200);
    await json(`/api/admin/announcements/${draft.id}`, { ...published, status: 'withdrawn' }, 'PATCH');
    assert.equal((await fetch(endpoint + image.src)).status, 404, 'withdrawal immediately stops public delivery');
    await json(`/api/admin/announcements/${draft.id}`, { ...published, blocks: [{ type: 'text', text: 'Before' }, ...draft.blocks, { type: 'text', text: 'After' }] }, 'PATCH');
    assert.deepEqual((await json('/api/announcements', null, 'GET')).data[0].blocks.map(block => block.type), ['text', 'image', 'text']);
    assert.equal((await fetch(endpoint + image.src)).status, 200);
    await json(`/api/admin/announcements/${draft.id}`, null, 'DELETE');
    assert.equal((await fetch(endpoint + image.src)).status, 404);
  } finally {
    if (child?.exitCode === null) { child.kill(); await exited; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
