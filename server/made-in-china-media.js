import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { load } from 'cheerio';

const MAX_BYTES = 12 * 1024 * 1024;
function sourceImageUrl(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && url.hostname === 'image.made-in-china.com'
      && !url.username && !url.password && !url.port ? url.href : '';
  } catch { return ''; }
}

// Save CDN images before the renderer or Alibaba encounters hotlink protection.
// Keep the remote originals in the immutable source snapshot and image history.
export async function cacheMadeInChinaImages(product, dataDir, { fetcher = fetch } = {}) {
  const mediaDir = path.join(dataDir, 'media');
  await fs.mkdir(mediaDir, { recursive: true });
  const original = structuredClone(product);
  const urls = [...new Set([
    ...(product.mainImages || []), ...(product.detailImages || []),
    ...(product.skus || []).map((sku) => sku.image),
    ...(product.variantGroups || []).flatMap((group) => Object.values(group.optionImages || {})),
  ].filter((url) => sourceImageUrl(url)))];
  const mapped = new Map();
  let cursor = 0;
  let failed = 0;
  const deadline = Date.now() + 90000;
  const download = async (url) => {
    const basename = 'mic-' + createHash('sha256').update(url).digest('hex').slice(0, 32);
    for (const extension of ['webp', 'png', 'jpg']) {
      const file = path.join(mediaDir, `${basename}.${extension}`);
      try {
        const stat = await fs.stat(file);
        if (stat.size > 0 && stat.size <= MAX_BYTES) {
          await sharp(file, { limitInputPixels: 40000000 }).metadata();
          return `/media/${path.basename(file)}`;
        }
      } catch { /* Missing or interrupted downloads are fetched again. */ }
    }
    let target = url;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!sourceImageUrl(target) || Date.now() >= deadline) throw new Error('图片地址无效或下载超时');
      const response = await fetcher(target, { redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, Math.min(20000, deadline - Date.now()))) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        target = new URL(response.headers.get('location'), target).href;
        continue;
      }
      if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES) {
        await response.body?.cancel().catch(() => {});
        throw new Error('图片下载失败');
      }
      const chunks = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > MAX_BYTES) throw new Error('图片超过 12 MB');
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      const metadata = await sharp(buffer, { limitInputPixels: 40000000, animated: false }).metadata();
      if (!['jpeg', 'png', 'webp'].includes(metadata.format)) throw new Error('图片格式不支持');
      const extension = metadata.format === 'jpeg' ? 'jpg' : metadata.format;
      const file = path.join(mediaDir, `${basename}.${extension}`);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, buffer); await fs.rename(temporary, file); }
      finally { await fs.unlink(temporary).catch(() => {}); }
      await fs.writeFile(file + '.json', JSON.stringify({ source: url }));
      return `/media/${path.basename(file)}`;
    }
    throw new Error('图片重定向过多');
  };
  await Promise.all(Array.from({ length: Math.min(3, urls.length) }, async () => {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      try { mapped.set(url, await download(url)); } catch { failed += 1; }
    }
  }));
  const local = (url) => mapped.get(url) || url;
  const mainImages = (product.mainImages || []).map(local);
  const $ = load(product.descriptionHtml || '', null, false);
  $('img').each((_, node) => { $(node).attr('src', local($(node).attr('src'))); });
  return { ...product, mainImages, images: mainImages, mainImage: mainImages[0] || '',
    detailImages: (product.detailImages || []).map(local), descriptionHtml: $.root().html() || '',
    skus: (product.skus || []).map((sku) => ({ ...sku, ...(sku.image ? { image: local(sku.image) } : {}) })),
    variantGroups: (product.variantGroups || []).map((group) => ({ ...group, ...(group.optionImages ? { optionImages: Object.fromEntries(Object.entries(group.optionImages).map(([key, url]) => [key, local(url)])) } : {}) })),
    collectWarning: [product.collectWarning, failed ? `${failed} 张来源图片未能保存到本地，请重新采集或替换图片后发布` : ''].filter(Boolean).join('；'),
    _collectedSnapshot: original,
  };
}
