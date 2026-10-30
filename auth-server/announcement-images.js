import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import sharp from 'sharp';
import { ANNOUNCEMENT_IMAGE_PATH } from './announcement-content.js';

const MAX_UPLOAD = 8 * 1024 * 1024;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function registerAnnouncementImages(app, { requireAdmin, directory, isPublished }) {
  const storage = path.resolve(directory);
  const fileFor = src => {
    if (!ANNOUNCEMENT_IMAGE_PATH.test(src)) throw fail('公告图片地址无效');
    return path.join(storage, path.basename(src));
  };
  app.post('/api/admin/announcement-images', requireAdmin, express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_UPLOAD }), async (request, response) => {
    if (!Buffer.isBuffer(request.body) || !request.body.length) throw fail('请选择 JPG、PNG 或 WebP 图片，单张不超过 8 MB');
    let image;
    try {
      const input = sharp(request.body, { limitInputPixels: 40000000, failOn: 'error' });
      const info = await input.metadata();
      if (!['jpeg', 'png', 'webp'].includes(info.format) || (info.pages || 1) > 1) throw Error('Unsupported image');
      image = await input.rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).webp({ quality: 90 }).toBuffer({ resolveWithObject: true });
    } catch { throw fail('图片无法读取，请使用有效的 JPG、PNG 或静态 WebP 图片（最多 4000 万像素）'); }
    const name = `${crypto.createHash('sha256').update(image.data).digest('hex')}.webp`;
    await fs.mkdir(storage, { recursive: true });
    const temporary = path.join(storage, `${crypto.randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, image.data, { flag: 'wx', mode: 0o600 });
      // Complete the write before exposing the final content-addressed file.
      await fs.rename(temporary, path.join(storage, name));
    } finally { await fs.rm(temporary, { force: true }); }
    response.status(201).json({ src: `/api/announcement-images/${name}`, width: image.info.width, height: image.info.height });
  });
  async function sendImage(request, response, next, admin) {
    const src = `/api/announcement-images/${request.params.name}`;
    if (!ANNOUNCEMENT_IMAGE_PATH.test(src) || (!admin && !await isPublished(src))) throw fail('公告图片不存在或尚未发布', 404);
    response.set({ 'Content-Type': 'image/webp', 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'cross-origin' });
    response.sendFile(path.basename(fileFor(src)), { root: storage }, error => {
      if (error && !response.headersSent) next(fail('公告图片不存在', error.status === 404 ? 404 : 500));
    });
  }
  app.get('/api/announcement-images/:name', (request, response, next) => sendImage(request, response, next, false));
  app.get('/api/admin/announcement-images/:name', requireAdmin, (request, response, next) => sendImage(request, response, next, true));
  return async blocks => {
    for (const block of blocks) if (block.type === 'image') {
      try { await fs.access(fileFor(block.src)); }
      catch { throw fail('公告图片不存在，请重新上传后保存'); }
    }
  };
}
