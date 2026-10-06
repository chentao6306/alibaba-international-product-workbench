import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import sharp from 'sharp';

const MAX_BYTES = 12 * 1024 * 1024;
const imageOptions = { limitInputPixels: 100000000, animated: false };
const OUTPUT_PIXELS = 16000000;
export const imageError = (message, status = 400) => Object.assign(new Error(message), { status });

export function friendlyImageError(error) {
  if (error.status) return error;
  if (/pixel limit/i.test(error.message)) return imageError('图片超过 1 亿像素，请缩小尺寸后重试（文件大小小不代表像素少）');
  if (/unsupported image|corrupt|bad seek|premature|invalid|Vips|pngload|jpegload|webpload/i.test(error.message)) return imageError('图片损坏或格式不受支持，请重新上传 JPG、PNG 或 WebP 图片');
  if (/timeout|aborted|ECONN|ENOTFOUND|fetch failed/i.test(error.message)) return imageError('图片下载失败或超时，请检查网络后重试');
  return imageError(`图片处理失败：${error.message}`);
}

// Decode large sources with a bounded input limit, and shrink before allocating
// raw pixels/compositing. Tall detail images retain their aspect ratio.
async function imagePipeline(buffer) {
  try {
    const metadata = await sharp(buffer, imageOptions).metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format)) throw imageError('仅支持 JPG、PNG 或 WebP 图片');
    const rotated = [5, 6, 7, 8].includes(metadata.orientation);
    const width = rotated ? metadata.height : metadata.width, height = rotated ? metadata.width : metadata.height;
    const scale = Math.min(1, Math.sqrt(OUTPUT_PIXELS / (width * height)), 16000 / width, 16000 / height);
    return sharp(buffer, imageOptions).rotate().resize({ width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), fit: 'inside', withoutEnlargement: true });
  } catch (error) { throw friendlyImageError(error); }
}

export function isPublicImageAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127
      || a === 198 && [18, 19].includes(b));
  }
  // Reject mapped IPv4 and local IPv6; only global unicast is usable here.
  return net.isIPv6(address) && /^[23][0-9a-f]{3}:/i.test(address);
}

async function download(url, redirects = 0) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.port && !['80', '443'].includes(target.port)) throw imageError('图片地址不受支持');
  const host = target.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !isPublicImageAddress(host)) throw imageError('不能读取本地网络图片地址');
  return new Promise((resolve, reject) => {
    const request = (target.protocol === 'https:' ? https : http).get(target, {
      signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'Mozilla/5.0', accept: 'image/*' },
      lookup(hostname, options, callback) {
        dns.lookup(hostname, { all: true }, (error, addresses) => {
          if (error) return callback(error);
          if (!addresses.length || addresses.some(({ address }) => !isPublicImageAddress(address))) return callback(imageError('不能读取本地网络图片地址'));
          callback(null, ...(options.all ? [addresses] : [addresses[0].address, addresses[0].family]));
        });
      },
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (redirects >= 3 || !response.headers.location) return reject(imageError('图片地址重定向过多'));
        download(new URL(response.headers.location, target).href, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) { response.resume(); return reject(imageError(`图片下载失败（HTTP ${response.statusCode}），可改用本地上传`)); }
      const chunks = []; let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) { response.destroy(); reject(imageError('图片超过 12 MB')); }
        else chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

export async function localImagePath(mediaDir, url) {
  if (!/^\/media\/[a-zA-Z0-9_-]+\.(?:png|jpe?g|webp)$/.test(url)) throw imageError('本地图片地址无效');
  try {
    const root = await fs.realpath(mediaDir);
    const file = path.join(root, path.basename(url));
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(file) !== file) throw imageError('本地图片路径无效');
    return file;
  } catch (error) {
    if (error.code === 'ENOENT') throw imageError('本地图片不存在，请重新上传');
    throw error;
  }
}

export async function readImage(mediaDir, url) {
  let buffer;
  if (String(url).startsWith('/media/')) {
    const file = await localImagePath(mediaDir, url);
    if ((await fs.stat(file)).size > MAX_BYTES) throw imageError('图片超过 12 MB');
    buffer = await fs.readFile(file);
  } else buffer = await download(url);
  if (!buffer.length || buffer.length > MAX_BYTES) throw imageError('图片为空或超过 12 MB');
  const metadata = await sharp(buffer, imageOptions).metadata().catch((error) => { throw friendlyImageError(error); });
  if (!['jpeg', 'png', 'webp'].includes(metadata.format)) throw imageError('仅支持 JPG、PNG 或 WebP 图片');
  return buffer;
}

export async function uploadImage(mediaDir, data) {
  const match = String(data || '').match(/^data:image\/(?:jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) throw imageError('仅支持 JPG、PNG 或 WebP 图片');
  const buffer = Buffer.from(match[1], 'base64');
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) throw imageError('上传图片不能超过 5 MB');
  const metadata = await sharp(buffer, imageOptions).metadata().catch((error) => { throw friendlyImageError(error); });
  if (!['jpeg', 'png', 'webp'].includes(metadata.format)) throw imageError('图片内容无效');
  const extension = metadata.format === 'jpeg' ? 'jpg' : metadata.format;
  const url = `/media/${randomUUID()}.${extension}`;
  // Decode/re-encode to validate the full image, remove metadata and apply EXIF orientation.
  await (await imagePipeline(buffer)).toFile(path.join(mediaDir, path.basename(url))).catch((error) => { throw friendlyImageError(error); });
  return url;
}

const escapeMarkup = (value) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
export function watermarkSettings(value = {}) {
  if (!value || typeof value !== 'object') throw imageError('水印设置无效');
  const type = value.type ?? 'text';
  if (!['text', 'image'].includes(type)) throw imageError('水印类型无效');
  const text = String(value.text || '').trim();
  const size = Number(value.size), opacity = Number(value.opacity);
  if (!Number.isFinite(size) || size < 2 || size > (type === 'image' ? 60 : 20) || !Number.isFinite(opacity) || opacity < 0.1 || opacity > 1) throw imageError('水印大小或透明度无效');
  if (!['northwest', 'northeast', 'center', 'southwest', 'southeast'].includes(value.position)) throw imageError('水印位置无效');
  if (type === 'image') {
    if (typeof value.imageUrl !== 'string' || !/^\/media\/[a-zA-Z0-9_-]+\.(?:png|jpe?g|webp)$/.test(value.imageUrl)) throw imageError('请先上传水印图片');
    return { type, imageUrl: value.imageUrl, size, opacity, position: value.position };
  }
  if (!text || text.length > 80 || /[\r\n\x00-\x1f]/.test(text)) throw imageError('水印文字需为 1～80 个字符，不能换行');
  if (!/^#[0-9a-f]{6}$/i.test(value.color || '')) throw imageError('水印颜色无效');
  return { type, text, size, opacity, color: value.color, position: value.position };
}

async function imageWatermarkOverlay(buffer, width, height, settings) {
  if (!buffer) throw imageError('水印图片不存在，请重新上传');
  const { data, info } = await sharp(buffer, imageOptions).rotate().resize({
    width: Math.max(1, Math.round(width * settings.size / 100)),
    height: Math.max(1, Math.floor(height * 0.8)), fit: 'inside',
  }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  // Scale only alpha: transparent PNG/WebP edges retain their original shape.
  let visible = false;
  for (let i = 3; i < data.length; i += 4) {
    data[i] = Math.round(data[i] * settings.opacity);
    if (data[i]) visible = true;
  }
  if (!visible) throw imageError('水印图片完全透明或缩小后不可见，请更换图片或调大尺寸');
  return sharp(data, { raw: info }).png().toBuffer();
}

export async function addWatermark(buffer, value, watermarkImage) {
  const settings = watermarkSettings(value);
  const base = await (await imagePipeline(buffer)).png().toBuffer();
  const { width, height } = await sharp(base).metadata();
  if (settings.type === 'image') return compositeWatermark(base, await imageWatermarkOverlay(watermarkImage, width, height, settings), settings);
  const fontSize = Math.max(8, Math.round(Math.min(width, height) * settings.size / 100));
  const text = `<span foreground="${settings.color}" alpha="${Math.round(settings.opacity * 65535)}">${escapeMarkup(settings.text)}</span>`;
  const overlay = await sharp({ text: { text, font: `${process.platform === 'win32' ? 'Microsoft YaHei' : 'sans'} ${fontSize}`, rgba: true } })
    .resize({ width: Math.max(1, Math.floor(width * 0.9)), height: Math.max(1, Math.floor(height * 0.5)), fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  return compositeWatermark(base, overlay, settings);
}

async function compositeWatermark(base, overlay, settings) {
  const { width, height } = await sharp(base).metadata();
  const dims = await sharp(overlay).metadata();
  const margin = Math.max(1, Math.floor(Math.min(width, height) * 0.03));
  const left = settings.position.endsWith('west') ? margin : settings.position.endsWith('east') ? width - dims.width - margin : Math.floor((width - dims.width) / 2);
  const top = settings.position.startsWith('north') ? margin : settings.position.startsWith('south') ? height - dims.height - margin : Math.floor((height - dims.height) / 2);
  return sharp(base).composite([{ input: overlay, left: Math.max(0, Math.min(width - dims.width, left)), top: Math.max(0, Math.min(height - dims.height, top)) }]).png().toBuffer();
}

export function repairRegion(value) {
  const region = Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, Number(value?.[key])]));
  if (Object.values(region).some((v) => !Number.isFinite(v)) || region.x < 0 || region.y < 0
    || region.width <= 0 || region.height <= 0 || region.x + region.width > 1.000001 || region.y + region.height > 1.000001
    || region.width * region.height > 0.25) throw imageError('请框选水印区域，面积不超过图片的 25%');
  return region;
}

export async function repairWatermark(buffer, selection) {
  const region = repairRegion(selection);
  const { data, info } = await (await imagePipeline(buffer)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (width < 8 || height < 8) throw imageError('图片太小，无法修复');
  const x0 = Math.min(width - 1, Math.floor(region.x * width)), y0 = Math.min(height - 1, Math.floor(region.y * height));
  const x1 = Math.min(width - 1, Math.ceil((region.x + region.width) * width) - 1), y1 = Math.min(height - 1, Math.ceil((region.y + region.height) * height) - 1);
  if (x0 === 0 && x1 === width - 1 || y0 === 0 && y1 === height - 1) throw imageError('修复区域需保留周围背景');
  const original = Buffer.from(data);
  // Boundary interpolation reconstructs simple backgrounds without changing pixels
  // outside the mask. No cloud upload or claim of recovering hidden source pixels.
  for (let y = y0; y <= y1; y++) {
    if ((y - y0) % 16 === 0) await new Promise((resolve) => setImmediate(resolve));
    for (let x = x0; x <= x1; x++) {
      const samples = [];
      if (x0 > 0) samples.push([x0 - 1, y, 1 / (x - x0 + 1) ** 2]);
      if (x1 < width - 1) samples.push([x1 + 1, y, 1 / (x1 - x + 1) ** 2]);
      if (y0 > 0) samples.push([x, y0 - 1, 1 / (y - y0 + 1) ** 2]);
      if (y1 < height - 1) samples.push([x, y1 + 1, 1 / (y1 - y + 1) ** 2]);
      const total = samples.reduce((sum, item) => sum + item[2], 0);
      for (let channel = 0; channel < channels; channel++) data[(y * width + x) * channels + channel] = Math.round(samples.reduce((sum, [sx, sy, weight]) => sum + original[(sy * width + sx) * channels + channel] * weight, 0) / total);
    }
  }
  return sharp(data, { raw: info }).png().toBuffer();
}

export async function imageHistory(mediaDir, url) {
  if (!/^\/media\/[a-zA-Z0-9_-]+\.png$/.test(url)) return null;
  try { return JSON.parse(await fs.readFile(path.join(mediaDir, `${path.basename(url)}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function saveImage(mediaDir, buffer, history) {
  if (buffer.length > MAX_BYTES) throw imageError('处理结果超过 12 MB，请先缩小图片后重试');
  const url = `/media/${randomUUID()}.png`, file = path.join(mediaDir, path.basename(url));
  try {
    await fs.writeFile(file, buffer, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(`${file}.json`, JSON.stringify(history), { flag: 'wx', mode: 0o600 });
  } catch (error) { await fs.rm(file, { force: true }); throw error; }
  return url;
}

export async function processImage(mediaDir, { url, action, watermark, region }) {
  if (!['watermark', 'remove-watermark', 'repair'].includes(action)) throw imageError('不支持的图片处理操作');
  const previous = await imageHistory(mediaDir, url);
  if (action === 'remove-watermark') return { url: previous?.watermarkBase || url, changed: Boolean(previous?.watermarkBase) };
  // Reapplying replaces our layer instead of burning a second watermark into it.
  let base = previous?.watermarkBase || url;
  const input = await readImage(mediaDir, base);
  if (!base.startsWith('/media/')) {
    // Preserve original bytes for exact watermark removal, without decoding a
    // large remote image a second time just to take a snapshot.
    const { format } = await sharp(input, imageOptions).metadata();
    base = `/media/${randomUUID()}.${format === 'jpeg' ? 'jpg' : format}`;
    await fs.writeFile(path.join(mediaDir, path.basename(base)), input, { flag: 'wx', mode: 0o600 });
  }
  let output, history;
  if (action === 'watermark') {
    watermark = watermarkSettings(watermark);
    output = await addWatermark(input, watermark, watermark.type === 'image' ? await readImage(mediaDir, watermark.imageUrl) : undefined);
    history = { parent: url, watermarkBase: base, watermark };
  } else {
    output = await repairWatermark(input, region);
    history = { parent: url, repairBase: base };
    if (previous?.watermark) {
      const repaired = await saveImage(mediaDir, output, history);
      const settings = watermarkSettings(previous.watermark);
      output = await addWatermark(output, settings, settings.type === 'image' ? await readImage(mediaDir, settings.imageUrl) : undefined);
      history = { parent: url, watermarkBase: repaired, watermark: settings };
    }
  }
  return { url: await saveImage(mediaDir, output, history), changed: true };
}
