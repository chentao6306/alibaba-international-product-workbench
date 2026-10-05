import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRelease } from '../website/src/release.js';

const origin = 'https://example.test';
const artifact = { schema: 1, product: 'com.kua-yipu.workbench', platform: 'win32', arch: 'x64', version: '1.4.58', filename: 'chaodekuai-1.4.58-setup.exe', size: 267371008 };
const feed = (changes = {}, url = '/updates/chaodekuai/files/12345678-abcd-abcd-abcd-123456789abc.exe') => ({ release: {
  envelope: { payload: Buffer.from(JSON.stringify({ ...artifact, ...changes })).toString('base64') },
  url, title: '中文更新说明', notes: '1. 修复\n2. 优化', publishedAt: '2026-10-05T00:00:00.000Z',
} });

test('website displays the public release metadata and handles withdrawal without a built-in fallback', () => {
  const release = parseRelease(feed(), origin);
  assert.equal(release.version, '1.4.58');
  assert.equal(release.title, '中文更新说明');
  assert.equal(release.notes, '1. 修复\n2. 优化');
  assert.equal(release.size, 267371008);
  assert.equal(release.url, origin + feed().release.url);
  assert.equal(parseRelease({ release: null }, origin), null);
});

test('website rejects unrelated downloads, malformed packages and unsupported platforms', () => {
  for (const url of ['https://other.test/package.exe', '//other.test/updates/chaodekuai/files/package.exe', 'javascript:alert(1)', '/admin.js', '/updates/chaodekuai/files/package.exe?redirect=1', '/updates/chaodekuai/files/package.exe#other']) {
    assert.throws(() => parseRelease(feed({}, url), origin));
  }
  for (const changes of [{ schema: 2 }, { product: 'another-app' }, { platform: 'darwin' }, { arch: 'arm64' }, { version: '1.4.58-beta' }, { filename: '../wrong.exe' }, { size: 0 }, { size: '100' }]) {
    assert.throws(() => parseRelease(feed(changes), origin));
  }
  assert.throws(() => parseRelease({ release: { envelope: { payload: 'not-json' } } }, origin));
});
