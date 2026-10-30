import fs from 'node:fs/promises';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const source = new URL('../public/brand.svg', import.meta.url);
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map((size) => sharp(fileURLToPath(source)).resize(size, size).png().toBuffer()));
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (const [index, size] of sizes.entries()) {
  const entry = 6 + index * 16;
  header[entry] = size === 256 ? 0 : size;
  header[entry + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[index].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += images[index].length;
}
await fs.writeFile(new URL('../public/brand.png', import.meta.url), images.at(-1));
await fs.mkdir(new URL('../assets/', import.meta.url), { recursive: true });
await fs.writeFile(new URL('../assets/brand.ico', import.meta.url), Buffer.concat([header, ...images]));
console.log('Brand PNG and Windows multi-resolution ICO generated');
