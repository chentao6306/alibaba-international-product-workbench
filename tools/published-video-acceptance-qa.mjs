// Verify published video positions and decoded playback from observed media URLs.
// Does not save, submit, or change any product or video association.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SellerPublisher } from '../server/publisher.js';
import { matchesAlibabaSession } from '../electron/alibaba-identity.js';
import { readPrivateSession, writePrivateSession } from '../server/private-session-storage.js';

const root = process.env.QA_OUTPUT_DIR, userData = process.env.QA_DESKTOP_USER_DATA_DIR;
assert.ok(root && userData && process.env.QA_EXPECTED_ACCOUNT);
const state = JSON.parse(fs.readFileSync(process.env.QA_WORKSPACE_FILE || path.join(userData, '.data/workspace.json')));
const receipt = state.jobs.find(job => job.id === process.env.QA_JOB_ID)?.results?.[process.env.QA_LOCAL_PRODUCT_ID];
assert.equal(receipt?.status, 'published');
const productId = new URL(receipt.url).searchParams.get('primaryId');
assert.equal(productId, receipt.videoAssociation.productId);
const expected = receipt.videoAssociation.items || [receipt.videoAssociation];
fs.mkdirSync(root, { recursive: true });
const session = path.join(root, 'alibaba-cookies.json');
writePrivateSession(session, readPrivateSession(path.join(userData, 'alibaba-cookies.json')));
process.env.KUA_YIPU_ALIBABA_COOKIES_FILE = session;
const publisher = new SellerPublisher(root);
const report = { productId, readOnly: true, expected: expected.map(({ id, role }) => ({ id, role })), linked: [], playback: [] };
const save = () => fs.writeFileSync(path.join(root, 'video-acceptance.json'), JSON.stringify(report, null, 2));
try {
  const page = await publisher.currentSellerPage('', { backgroundPublishing: true });
  assert.ok(matchesAlibabaSession(await page.context().cookies(), process.env.QA_EXPECTED_ACCOUNT, page.url()));
  for (const item of expected) {
    await page.goto(`https://hz-productposting.alibaba.com/product/videobank/linked_products.htm?videoId=${item.id}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const row = page.locator('tbody tr').filter({ has: page.locator(`a[href*="_${productId}.html"]`) });
    await row.waitFor({ state: 'visible', timeout: 30000 });
    const text = await row.innerText();
    assert.match(text, item.role === 'main' ? /Primary video|主图视频/i : /Details? video|Video for product details?|详情视频|详情页视频/i);
    report.linked.push({ id: item.id, role: item.role, text }); save();
  }
  const source = await publisher.readSourceProduct(page, { sourcePlatform: 'alibaba.com', sourceId: productId,
    sourceUrl: `https://www.alibaba.com/product-detail/product_${productId}.html` });
  report.title = source.title;
  report.publicVideos = source.videos;
  report.publicUrl = page.url(); save();
  for (const item of expected) {
    const sameRole = source.videos.filter(video => video.role === item.role && video.source === 'dom');
    const exact = sameRole.find(video => video.url.includes(`/${item.id}.mp4`));
    // The native main player exposes Alibaba's transcoded CDN URL without VID.
    // Its unique main position is corroborated by the exact bank product/role.
    const video = exact || (item.role === 'main' && sameRole.length === 1 && /^https:\/\/gv\.videocdn\.alibaba\.com\//.test(sameRole[0].url) ? sameRole[0] : null);
    assert.ok(video, `Published ${item.role} module must contain video ${item.id}`);
    const playback = await page.context().newPage();
    try {
      await playback.setContent('<video controls muted autoplay playsinline style="width:640px;height:480px"></video>');
      const player = playback.locator('video');
      await player.evaluate((node, url) => { node.src = url; node.load(); }, video.url);
      await player.evaluate(async node => {
        let timer;
        try { await Promise.race([node.play(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Video play timed out')), 30000); })]); }
        finally { clearTimeout(timer); }
      });
      await playback.waitForFunction(() => {
        const video = document.querySelector('video');
        if (video.error) throw new Error(`Video decode failed: ${video.error.code}`);
        return video.ended && video.videoWidth > 0 && video.currentTime > 0;
      }, undefined, { timeout: 120000 });
      report.playback.push({ id: item.id, role: item.role, sourceUrl: video.url,
        identityEvidence: exact ? 'exact-video-id-in-native-module' : 'exact-bank-product-role-and-unique-native-main-player',
        ...await player.evaluate(node => ({ currentTime: node.currentTime, duration: node.duration, ended: node.ended,
          readyState: node.readyState, width: node.videoWidth, height: node.videoHeight, error: node.error?.code || null })) });
      save();
    } finally { await playback.close(); }
  }
  report.ok = true;
} catch (error) { report.error = { message: error.message, code: error.code }; process.exitCode = 1; }
finally {
  await publisher.shutdown(); fs.rmSync(session, { force: true }); save();
  console.log(JSON.stringify({ reportFile: path.join(root, 'video-acceptance.json'), ok: report.ok, error: report.error }));
}
