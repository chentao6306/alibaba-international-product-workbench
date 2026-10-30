// Read-only live QA: compare persisted platform pixels with the saved watermark
// and its original. This never changes a product or platform image.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';

async function corner(buffer) {
  const metadata = await sharp(buffer, { limitInputPixels: 40000000 }).metadata();
  const side = Math.max(1, Math.min(metadata.width, metadata.height, Math.round(metadata.width * 0.2)));
  const pixels = await sharp(buffer).extract({ left: metadata.width - side, top: metadata.height - side, width: side, height: side })
    .resize(128, 128).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer();
  return { pixels, width: metadata.width, height: metadata.height };
}

const difference = (a, b) => {
  assert.equal(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
};

export async function verifyWatermarkedReadback(product, remote, workspaceDirectory) {
  const checks = [];
  for (const key of ['mainImages', 'detailImages']) {
    const urls = product[key] || [];
    assert.equal(remote[key].length, urls.length);
    for (const [index, url] of urls.entries()) {
      if (!url.startsWith('/media/')) continue;
      const file = path.join(workspaceDirectory, 'media', path.basename(url));
      let history;
      try { history = JSON.parse(await fs.readFile(`${file}.json`, 'utf8')); } catch { continue; }
      if (!history.watermarkBase) continue;
      assert.equal(history.watermark.position, 'southeast', 'This acceptance fixture checks a lower-right watermark');
      const source = new URL(remote[key][index], 'https://www.alibaba.com/');
      assert.equal(source.protocol, 'https:');
      const response = await fetch(source, { signal: AbortSignal.timeout(20000) });
      assert.equal(response.status, 200);
      const buffer = Buffer.from(await response.arrayBuffer());
      assert.ok(buffer.length > 0 && buffer.length <= 20 * 1024 * 1024);
      const [actual, expected, original] = await Promise.all([
        corner(buffer), corner(await fs.readFile(file)),
        corner(await fs.readFile(path.join(workspaceDirectory, 'media', path.basename(history.watermarkBase)))),
      ]);
      const matched = difference(actual.pixels, expected.pixels), unwatermarked = difference(actual.pixels, original.pixels);
      checks.push({ kind: key, index: index + 1, width: actual.width, height: actual.height,
        expectedDifference: matched, originalDifference: unwatermarked });
      assert.ok(actual.width >= Math.min(expected.width, 960) * 0.9, `${key} ${index + 1}: saved image was reduced to a thumbnail`);
      assert.ok(Math.abs(actual.height / actual.width - expected.height / expected.width) < 0.02,
        `${key} ${index + 1}: saved image aspect ratio changed`);
      assert.ok(matched < 16 && matched < unwatermarked * 0.6,
        `${key} ${index + 1}: watermark pixels differ (${matched.toFixed(2)} vs original ${unwatermarked.toFixed(2)})`);
    }
  }
  assert.ok(checks.length > 0, 'The selected sample must have watermarked images');
  return checks;
}
