// Independently compare captured public-page labels/values with collected data.
// This is an audit of explicit live captures, not a simulated collecting test.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const root = path.resolve(process.argv[2]);
const ledger = JSON.parse(fs.readFileSync(path.join(root, 'report.json')));
const report = { cases: [], media: [], startedAt: new Date().toISOString() };
const key = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const assets = new Map();
const selected = process.env.QA_CASE_FILTER?.split(',');
report.excludedCases = ledger.cases.filter(row => selected && !selected.includes(row.kind)).map(row => ({ kind: row.kind, reason: 'Outside explicit audit selection; see original report for its outcome' }));
for (const row of ledger.cases.filter(row => !selected || selected.includes(row.kind))) {
  const { product, evidence } = JSON.parse(fs.readFileSync(path.join(root, `${row.sourceId}-source.json`)));
  const block = evidence.attributeSections.filter(section => section.startsWith('Key attributes')).sort((a, b) => b.length - a.length)[0];
  assert.ok(block, `${row.kind}: captured public attribute table required`);
  const lines = block.split('\n').map(line => line.trim()).filter(line => line && !/^(Key attributes|Packaging and delivery|Show more)$/.test(line));
  assert.equal(lines.length % 2, 0, 'Unexpected public attribute layout; review before counting pairs');
  const expected = [];
  for (let i = 0; i < lines.length; i += 2) expected.push({ name: lines[i], value: lines[i + 1] });
  const missing = expected.filter(item => !product.attributes.some(attribute => key(attribute.name) === key(item.name)
    && [...new Set([attribute.value].flat().map(key))].join(', ') === key(item.value)));
  const missingVideos = evidence.media.filter(item => item.url && !product.videos.some(video => video.url === item.url));
  report.cases.push({ kind: row.kind, sourceId: row.sourceId, visibleAttributePairs: expected.length,
    missing, visibleVideoUrls: evidence.media.length, missingVideos,
    mainImageUrls: product.mainImages.length, detailImageUrls: product.detailImages.length,
    specifications: (product.variantGroups || []).map(group => ({ name: group.name, options: group.options.length,
      images: Object.values(group.optionImages || {}).filter(Boolean).length })), skuRows: product.skus.length,
    sourceTradeAvailability: product.sourceTradeAvailability });
  for (const url of [...product.mainImages, ...product.detailImages, ...(product.variantGroups || []).flatMap(group => Object.values(group.optionImages || {}))]) {
    if (url && !assets.has(url)) assets.set(url, { url, referer: product.sourceUrl, kind: 'image' });
  }
  for (const video of product.videos) if (!assets.has(video.url)) assets.set(video.url, { url: video.url, referer: product.sourceUrl, kind: 'video' });
}
for (const asset of assets.values()) {
  const result = { url: asset.url, kind: asset.kind };
  try {
    const response = await fetch(asset.url, { headers: { 'user-agent': 'Mozilla/5.0', referer: asset.referer,
      ...(asset.kind === 'video' ? { range: 'bytes=0-1023' } : {}) }, signal: AbortSignal.timeout(20000) });
    result.status = response.status;
    result.contentType = response.headers.get('content-type');
    assert.ok(response.ok, `Media HTTP ${response.status}`);
    if (asset.kind === 'video') {
      // Some CDNs ignore Range: do not download an entire video for a probe.
      const reader = response.body.getReader(); const chunk = await reader.read(); await reader.cancel();
      assert.ok(chunk.value?.length, 'Empty video response');
      assert.match(result.contentType || '', /video|octet-stream/i);
      result.probedBytes = chunk.value.length;
    } else {
      const image = Buffer.from(await response.arrayBuffer());
      const metadata = await sharp(image).metadata();
      assert.ok(metadata.width > 0 && metadata.height > 0, 'Image could not be decoded');
      result.width = metadata.width; result.height = metadata.height; result.bytes = image.length;
    }
    result.ok = true;
  } catch (error) { result.ok = false; result.error = error.message; }
  report.media.push(result);
  if (report.media.length % 20 === 0) console.log(JSON.stringify({ inspected: report.media.length, total: assets.size }));
}
report.ok = report.cases.every(row => !row.missing.length && !row.missingVideos.length) && report.media.every(row => row.ok);
report.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(root, 'source-evidence-audit.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: report.ok, cases: report.cases.map(({ kind, visibleAttributePairs, missing, missingVideos }) => ({ kind, visibleAttributePairs, missing, missingVideos })),
  media: report.media.length, failures: report.media.filter(row => !row.ok) }));
if (!report.ok) process.exitCode = 1;
