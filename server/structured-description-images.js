import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const MAX_BYTES = 5 * 1024 * 1024;
const MIN_EDGE = 600;
const imageOptions = { animated: false, limitInputPixels: 40000000 };
const accepted = (metadata, size) => ['jpeg', 'png'].includes(metadata.format)
  && metadata.width >= MIN_EDGE && metadata.height >= MIN_EDGE && size <= MAX_BYTES
  && (!metadata.orientation || metadata.orientation === 1);

// Native galleries validate both edges. Do not reuse the legacy 960px-wide
// derivative: a 1200x600 source would otherwise become an invalid 960x480.
// Pad short edges without stretching/cropping or modifying the source file.
export async function prepareStructuredDescriptionImages(files, onProgress = () => {}) {
  const prepared = [], adjustments = [];
  for (const [index, file] of files.entries()) {
    try {
      const input = await fs.readFile(file);
      const metadata = await sharp(input, imageOptions).metadata();
      if (accepted(metadata, input.length)) { prepared.push(file); continue; }
      const digest = createHash('sha256').update(input).update('native-gallery-pad-v1').digest('hex').slice(0, 20);
      const target = path.join(path.dirname(file), `${path.parse(file).name}-native-${digest}.jpg`);
      let output;
      try {
        const cached = await fs.readFile(target);
        if (accepted(await sharp(cached, imageOptions).metadata(), cached.length)) output = cached;
      } catch { /* Missing or interrupted derived cache: recreate from source. */ }
      if (!output) {
        const rotated = [5, 6, 7, 8].includes(metadata.orientation);
        const width = rotated ? metadata.height : metadata.width;
        const height = rotated ? metadata.width : metadata.height;
        if (!width || !height) throw new Error('无法读取图片尺寸');
        for (const quality of [90, 82, 72, 60]) {
          output = await sharp(input, imageOptions).rotate().flatten({ background: '#ffffff' })
            .extend({ left: Math.floor(Math.max(0, MIN_EDGE - width) / 2), right: Math.ceil(Math.max(0, MIN_EDGE - width) / 2),
              top: Math.floor(Math.max(0, MIN_EDGE - height) / 2), bottom: Math.ceil(Math.max(0, MIN_EDGE - height) / 2), background: '#ffffff' })
            .jpeg({ quality, mozjpeg: true }).toBuffer();
          if (output.length <= MAX_BYTES) break;
        }
        if (!accepted(await sharp(output, imageOptions).metadata(), output.length)) throw new Error('保留完整画面后仍超过 5 MB，请调整原图');
        await fs.writeFile(target, output);
      }
      const actual = await sharp(output, imageOptions).metadata();
      adjustments.push({ index, sourceWidth: metadata.width, sourceHeight: metadata.height,
        width: actual.width, height: actual.height, bytes: output.length,
        padded: metadata.width < MIN_EDGE || metadata.height < MIN_EDGE });
      prepared.push(target);
      onProgress(`检查新版详情图片 ${index + 1}/${files.length}，已适配 ${adjustments.length} 张`);
    } catch (error) {
      throw Object.assign(new Error(`新版结构化详情：第 ${index + 1} 张图片预处理失败：${error.message}`), {
        code: 'PUBLISH_DESCRIPTION_IMAGE_INVALID', diagnostics: { reason: 'native-image-preparation', index },
      });
    }
  }
  return { files: prepared, adjustments };
}
