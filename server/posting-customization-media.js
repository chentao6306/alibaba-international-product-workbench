import { choosePostingFile, clickPostingControl } from './posting-interaction.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { customizationFormModel } from './posting-extras.js';

const acceptedImages = new WeakMap();
const acceptedHotspots = new WeakMap();

// Read coordinates only. All changes still go through the editor's mouse controls.
export function readHotspotCanvas(node) {
  let fiber = node[Object.keys(node).find(key => key.startsWith('__reactFiber'))];
  for (let depth = 0; fiber && depth < 14; depth++, fiber = fiber.return) {
    for (let hook = fiber.memoizedState; hook; hook = hook.next) {
      const canvas = hook.memoizedState?.current;
      if (canvas?.lowerCanvasEl !== node) continue;
      const shapes = canvas._objects?.filter(item => item.type === 'rect' && item.selectable);
      if (shapes?.length !== 1 || !canvas.backgroundImage) return null;
      const shape = shapes[0], background = canvas.backgroundImage;
      const point = name => shape.oCoords?.[name] ? { x: shape.oCoords[name].x, y: shape.oCoords[name].y } : null;
      const corner = shape.getPointByOrigin('left', 'top');
      return { width: canvas.width, height: canvas.height,
        image: background.getBoundingRect(),
        area: { x: corner.x, y: corner.y, width: shape.width * shape.scaleX, height: shape.height * shape.scaleY },
        handles: { mr: point('mr'), mb: point('mb') } };
    }
  }
  return null;
}

export function hotspotMatches(image, expected, tolerancePercent = 0.5) {
  const area = image?.customizableAreas?.[0], size = image?.imageSize;
  if (image?.customizableAreas?.length !== 1 || area?.shape !== 'rect' || !(size?.width > 0 && size?.height > 0)) return false;
  return ['x', 'y', 'width', 'height'].every(key => {
    const total = key === 'x' || key === 'width' ? size.width : size.height;
    return Math.abs(Number(area[key]) / total * 100 - Number(expected[key])) <= tolerancePercent;
  });
}

export async function positionCustomizationHotspot(page, frame, hotspot) {
  const canvas = frame.locator('canvas.upper-canvas');
  const lower = frame.locator('canvas.lower-canvas');
  await canvas.waitFor({ timeout: 20000 });
  const read = () => lower.evaluate(readHotspotCanvas);
  let state = await read();
  if (!state) throw failure('无法确认定制区域的实际位置');
  const target = { x: state.image.left + state.image.width * Number(hotspot.x) / 100,
    y: state.image.top + state.image.height * Number(hotspot.y) / 100,
    width: state.image.width * Number(hotspot.width) / 100, height: state.image.height * Number(hotspot.height) / 100 };
  const box = await canvas.boundingBox();
  const screen = point => ({ x: box.x + point.x * box.width / state.width, y: box.y + point.y * box.height / state.height });
  const drag = async (from, to) => {
    const a = screen(from), b = screen(to);
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    try { await page.mouse.move(b.x, b.y, { steps: 12 }); } finally { await page.mouse.up(); }
  };
  // Side handles avoid Fabric's proportional corner scaling for non-square areas.
  for (let pass = 0; pass < 4; pass++) {
    state = await read();
    if (!state) throw failure('定制区域编辑器结构发生变化');
    const center = screen({ x: state.area.x + state.area.width / 2, y: state.area.y + state.area.height / 2 });
    await page.mouse.click(center.x, center.y);
    for (const [dimension, handle, axis] of [['width', 'mr', 'x'], ['height', 'mb', 'y']]) {
      state = await read();
      const from = state?.handles[handle];
      if (!from) throw failure('定制区域缩放手柄未就绪');
      const delta = target[dimension] - state.area[dimension];
      if (Math.abs(delta) > 1) await drag(from, { ...from, [axis]: from[axis] + delta });
    }
    state = await read();
    const from = { x: state.area.x + state.area.width / 2, y: state.area.y + state.area.height / 2 };
    if (Math.abs(state.area.x - target.x) > 1 || Math.abs(state.area.y - target.y) > 1) {
      await drag(from, { x: from.x + target.x - state.area.x, y: from.y + target.y - state.area.y });
    }
    state = await read();
    if (Object.keys(target).every(key => Math.abs(state.area[key] - target[key]) <= 2)) return;
  }
  throw failure('平台未接受指定的定制区域位置和大小');
}

const failure = (message) => Object.assign(new Error(`定制图片未完成：${message}`), { code: 'PUBLISH_FIELD_NOT_READY', fieldName: '定制图片' });
const waitUntil = async (page, test, timeout = 60000) => {
  const end = Date.now() + timeout;
  do { if (await test()) return; await page.waitForTimeout(250); } while (Date.now() < end);
  throw failure('等待平台接收图片超时');
};

export async function uploadCustomizationImage(page, card, url, download) {
  const [file] = await download([url], 'customization', 1);
  if (!file) throw failure('示例图无法下载');
  const area = card.locator('.cardItem-container-right');
  const existing = await area.locator('img[src]').getAttribute('src').catch(() => '');
  const cached = acceptedImages.get(page)?.get(url);
  if (existing && cached === existing) return;
  let input = area.locator('input[type="file"]');
  if (await input.count()) await input.last().setInputFiles(file);
  else {
    const chooser = await choosePostingFile(page, area.locator('.next-upload-list-item-thumbnail').first());
    if (chooser) await chooser.setFiles(file);
    else {
      const iframe = page.locator('.icbu-photobank iframe');
      if (!await iframe.count()) throw failure('示例图上传入口未打开');
      await iframe.waitFor({ timeout: 15000 });
      let bank = await iframe.elementHandle().then(node => node.contentFrame());
      if (!bank) throw failure('图片银行未打开');
      await bank.locator('input[role="searchbox"]').waitFor({ timeout: 20000 });
      const filename = `customization${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0,24)}`;
      let bankName = filename;
      let bankUrl = '';
      const find = async () => {
        await bank.locator('input[role="searchbox"]').fill(bankName);
        await bank.locator('input[role="searchbox"]').press('Enter');
        await page.waitForTimeout(350);
        await bank.locator('.next-loading.next-open').waitFor({ state: 'hidden', timeout: 20000 });
        const items = bank.locator('.photo-grid-item');
        const index = await items.evaluateAll((nodes, expected) => nodes.findIndex(node => {
          const name = node.querySelector('.display-name')?.getAttribute('title');
          const src = node.querySelector('img')?.src || '';
          return name === expected.name && (!expected.url || src.startsWith(expected.url));
        }), { name: bankName, url: bankUrl });
        return index < 0 ? items.filter({ hasText: /^__no_matching_image__$/ }) : items.nth(index);
      };
      let selected = await find();
      if (!await selected.count()) {
        const href = await bank.getByRole('link', { name: /^(?:Image bank|图片银行)$/i }).getAttribute('href');
        if (!href) throw failure('未找到图片银行管理入口');
        const manager = await page.context().newPage();
        const uploadPath = path.join(path.dirname(file), `${filename}.jpg`);
        fs.copyFileSync(file, uploadPath);
        try {
          await manager.goto(new URL(href, bank.url()).href, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await clickPostingControl(manager, manager.getByRole('button', { name: /^(?:Upload images|上传图片)$/i }));
          const uploader = manager.locator('.icbu-photo-select iframe');
          await uploader.waitFor({ timeout: 15000 });
          const frame = await uploader.elementHandle().then(node => node.contentFrame());
          await frame.locator('input[type="file"]').waitFor({ state: 'attached', timeout: 20000 });
          await frame.locator('input[type="file"]').setInputFiles(uploadPath);
          await clickPostingControl(manager, frame.getByRole('button', { name: /^(?:Upload Now|确认上传|立即上传)/i }));
          await waitUntil(manager, async () => {
            const duplicate = frame.locator('.uploader-duplicate-item a');
            if (await duplicate.count()) {
              if (await duplicate.count() !== 1) throw failure('图片银行返回了多张重复图片，无法确认目标');
              bankName = (await duplicate.innerText()).trim();
              bankUrl = new URL(await duplicate.getAttribute('href'), frame.url()).href;
              return true;
            }
            return !await uploader.isVisible();
          });
          if (!bankUrl) await manager.locator(`.display-name[title="${filename}"]`).waitFor({ timeout: 20000 });
        } finally { await manager.close(); fs.rmSync(uploadPath, { force: true }); }
        await bank.goto(bank.url(), { waitUntil: 'domcontentloaded', timeout: 45000 });
        selected = await find();
      }
      if (await selected.count() !== 1) throw failure('图片银行未返回唯一的已上传示例图');
      await selected.hover();
      await clickPostingControl(page, selected.locator('label.next-radio-wrapper'));
      if (!await selected.locator('input[type="radio"]').isChecked()) throw failure('示例图未勾选');
      await clickPostingControl(page, bank.locator('button#confirm'));
      await iframe.waitFor({ state: 'hidden', timeout: 20000 });
    }
  }
  await waitUntil(page, async () => area.locator('img[src]').evaluateAll(nodes => nodes.some(node => /^https?:\/\//.test(node.src)
    && !node.closest('.uploading, .next-upload-list-item-uploading, .next-upload-list-item-error'))));
  if (!acceptedImages.has(page)) acceptedImages.set(page, new Map());
  acceptedImages.get(page).set(url, await area.locator('img[src]').getAttribute('src'));
}

export async function fillCustomizationHotspot(page, section, group, download) {
  const signature = JSON.stringify([group.baseImage, group.hotspot]);
  const accepted = acceptedHotspots.get(page)?.get(group.baseImage);
  const previous = await section.locator('.base-map .preview-item:not(.add-more) img').first().getAttribute('src').catch(() => '');
  const savedImage = async () => {
    const root = section.locator('xpath=ancestor::*[@id="lightCustomizedServices" or @id="newCustomizedServices"][1]');
    const values = await customizationFormModel(root);
    const preview = await section.locator('.base-map .preview-item:not(.add-more) img').first().getAttribute('src').catch(() => '');
    return values.flatMap(value => value.hotImages || []).find(image => image.previewImageUrl === preview);
  };
  if (accepted?.preview === previous && accepted.signature === signature && hotspotMatches(await savedImage(), group.hotspot)) return;
  const [file] = await download([group.baseImage], 'customization-background', 1);
  if (!file) throw failure('商品底图无法下载');
  await clickPostingControl(page, section.locator('.base-map .hot-area').first());
  const iframe = page.locator('#smartCustomization');
  await iframe.waitFor({ timeout: 20000 });
  const frame = await iframe.elementHandle().then(node => node.contentFrame());
  if (!frame) throw failure('定制区域编辑器未就绪');
  const upload = frame.locator('input[type="file"]').first();
  await frame.locator('[data-testid="layout-save-button"]').waitFor({ timeout: 20000 });
  if (!await upload.count() && accepted?.preview !== previous) {
    // Replace this service's existing background through its editor. Never
    // reuse an unrelated image merely because it already has a default region.
    const images = frame.locator('[data-testid^="image-frame-wrapper-"]');
    if (await images.count() !== 1) throw failure('底图数量不一致，无法唯一确认要替换的图片');
    await images.hover();
    await frame.getByTestId('image-frame-0-delete-trigger').click();
    await frame.getByText(/^(?:Delete the custom image\?|删除定制图片？|删除自定义图片？)$/).waitFor({ timeout: 10000 });
    await frame.getByText(/^(?:Delete|删除)$/, { exact: true }).click();
    await upload.waitFor({ state: 'attached', timeout: 10000 });
  }
  if (await upload.count()) await upload.setInputFiles(file);
  const canvas = frame.locator('canvas.upper-canvas');
  await waitUntil(page, async () => {
    const next = frame.getByText(/^(?:Continue editing hotspot|继续编辑热区)$/);
    if (await next.isVisible().catch(() => false)) await next.click();
    return canvas.isVisible().catch(() => false);
  });
  const rectangle = frame.locator('button[role="radio"][value="rect"]');
  if (await rectangle.getAttribute('aria-checked') !== 'true') await rectangle.click();
  await positionCustomizationHotspot(page, frame, group.hotspot);
  await frame.getByTestId('layout-save-button').click();
  await iframe.waitFor({ state: 'hidden', timeout: 30000 });
  const preview = section.locator('.base-map .preview-item:not(.add-more)');
  if (!await preview.count()) throw failure('已保存的底图未出现在定制服务中');
  await waitUntil(page, async () => Boolean(await preview.locator('.success-icon').count()));
  const errors = await section.locator('.sell-error-message:visible, .next-form-item-help:visible').allTextContents();
  if (errors.some(text => /未设置热区|必填|不能为空|失败|required|invalid/i.test(text))) throw failure(errors.join('；'));
  await waitUntil(page, async () => hotspotMatches(await savedImage(), group.hotspot));
  if (!acceptedHotspots.has(page)) acceptedHotspots.set(page, new Map());
  acceptedHotspots.get(page).set(group.baseImage, { signature, preview: await preview.locator('img').first().getAttribute('src') });
}
