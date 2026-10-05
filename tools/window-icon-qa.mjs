import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export async function readWindowIcons(processId) {
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./window-icon-probe.ps1', import.meta.url)), '-ProcessId', String(processId)],
  { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout.replace(/^\uFEFF/, ''));
}

export async function readExecutableIcon(file) {
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./window-icon-probe.ps1', import.meta.url)), '-Executable', file],
  { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

export async function assertBrandIcon(encoded) {
  assert.ok(encoded, 'Native window icon is missing');
  const { data, info } = await sharp(Buffer.from(encoded, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const expected = await sharp(fileURLToPath(new URL('../public/brand.png', import.meta.url)))
    .resize(info.width, info.height).ensureAlpha().raw().toBuffer();
  let difference = 0;
  for (let i = 0; i < data.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) {
      difference += Math.abs(data[i + channel] * data[i + 3] / 255 - expected[i + channel] * expected[i + 3] / 255);
    }
    difference += Math.abs(data[i + 3] - expected[i + 3]);
  }
  assert.ok(info.width >= 16 && info.height >= 16);
  // Allow native premultiplication/resampling at small Windows icon sizes.
  assert.ok(difference / data.length < 8, `Native icon differs from 抄得快 brand: mean pixel error ${difference / data.length}`);
}
