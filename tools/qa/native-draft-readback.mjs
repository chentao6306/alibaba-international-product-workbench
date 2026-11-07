// An authorized isolated draft check. Requires a caller-supplied real product
// and native-module fixture; never treats a saved receipt as content readback.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { preparePublishProduct, dismissPostingOverlays, requireCategoryAttributes, mainImageFormState } from '../../server/publisher.js';
import { currentDescriptionStructure } from '../../server/description-structure.js';
import { nativeDescriptionText, readNativeDescriptionFields, requireNativeDescriptionAccepted } from '../../server/native-description-fields.js';
import { revealDescriptionSection } from '../../server/posting-readiness.js';

export async function verifyNativeDraft({ publisher, page, product: source, evidenceDir, resumeDraft = false }) {
  const product = preparePublishProduct(source, { uploadProductVideos: false });
  const structure = currentDescriptionStructure(product);
  assert.ok(structure?.modules.length);
  const report = resumeDraft ? JSON.parse(fs.readFileSync(path.join(evidenceDir, 'native-draft-report.json')))
    : { sourceId: product.sourceId, categoryId: product.categoryId, stages: [], startedAt: new Date().toISOString() };
  if (report.error) { report.previousCheckError = report.error; delete report.error; }
  const save = () => fs.writeFileSync(path.join(evidenceDir, 'native-draft-report.json'), JSON.stringify(report, null, 2));
  const receipts = [];
  const onRequest = request => {
    if (new URL(request.url()).pathname !== '/product/submitDraft.json') return;
    receipts.push(readNativeDescriptionFields(page).then(fields => { report.submittedFields = fields; save(); }));
  };
  const onResponse = response => {
    if (new URL(response.url()).pathname !== '/product/submitDraft.json') return;
    receipts.push(response.json().then(body => { report.receipt = { success: body.success, data: body.data }; save(); }).catch(() => {}));
  };
  page.on('response', onResponse);
  page.on('request', onRequest);
  try {
    const started = Date.now();
    if (!resumeDraft) {
      report.result = await publisher.publishProduct(product,
        `https://post.alibaba.com/product/publish.htm?catId=${product.categoryId}&language=zh_CN`, 'draft', '', '',
        stage => { report.stages.push({ stage, elapsedMs: Date.now() - started }); save(); },
        { uploadProductVideos: false, listingMode: 'auto' });
    }
    save();
    await Promise.allSettled(receipts);
    assert.equal(report.result.status, 'drafted');
    // A success toast can precede the platform's draft URL navigation.
    // Wait for that navigation without creating another draft.
    await page.waitForURL(url => /^\d+$/.test(url.searchParams.get('itemId') || ''), { timeout: 15000 });
    report.draftId = new URL(page.url()).searchParams.get('itemId');
    assert.match(report.draftId || '', /^\d+$/);
    save();
    await page.goto(`https://post.alibaba.com/product/publish.htm?itemId=${report.draftId}&pubAction=draft&language=zh_CN`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('input#productTitle').waitFor({ timeout: 45000 });
    await dismissPostingOverlays(page);
    await requireCategoryAttributes(page, product);
    report.mainImages = await mainImageFormState(page);
    await revealDescriptionSection(page);
    const fields = await readNativeDescriptionFields(page);
    report.readback = fields;
    await requireNativeDescriptionAccepted(page);
    report.platformFieldsAccepted = true;
    report.mode = await page.evaluate(() => window.GlobalStore?.engine?.getModels()?.formValues?.productDescType?.value);
    assert.equal(report.mode, 4);
    const highlights = nativeDescriptionText(structure.modules.find(m => m.type === 'highlights')?.items.join('\n'));
    const company = nativeDescriptionText(structure.modules.find(m => m.type === 'company')?.text);
    const faq = (structure.modules.find(m => m.type === 'faq')?.items || []).map(item => ({ question: nativeDescriptionText(item.question), answers: nativeDescriptionText(item.answer) }));
    assert.equal(fields.textDesc, highlights);
    assert.equal(fields.companyDesc, company);
    assert.deepEqual(fields.companyFaqDesc, faq);
    assert.ok(report.submittedFields, 'Capture the accepted fields at the save request');
    report.imageReadback = [];
    for (const [scope, field] of [['product', 'detailImage'], ['company', 'companyImage']]) {
      const expected = structure.modules.filter(m => m.type === 'gallery' && m.scope === scope);
      assert.deepEqual((fields[field] || []).map(g => [g.enName, g.imageList.length]), expected.map(g => [g.title, g.images.length]));
      assert.ok((fields[field] || []).flatMap(g => g.imageList).every(image => /^https:\/\//.test(image.imgURL)));
      const before = report.submittedFields[field] || [], after = fields[field] || [];
      assert.deepEqual(after.map(g => g.enName), before.map(g => g.enName));
      for (const [groupIndex, group] of after.entries()) {
        assert.equal(group.imageList.length, before[groupIndex].imageList.length);
        for (const [index, image] of group.imageList.entries()) {
          const original = before[groupIndex].imageList[index];
          // Alibaba assigns permanent bank IDs/URLs after saving. Compare
          // committed metadata and actual bytes, never counts alone.
          const hashes = [];
          for (const url of [original.imgURL, image.imgURL]) {
            assert.ok(/^https:\/\/(?:[\w-]+\.)*alicdn\.com\//.test(url));
            const response = await page.request.get(url, { timeout: 30000 });
            try {
              assert.equal(response.status(), 200);
              assert.match(response.headers()['content-type'] || '', /^image\//);
              const body = await response.body();
              assert.ok(body.length > 0 && body.length <= 20 * 1024 * 1024);
              hashes.push(createHash('sha256').update(body).digest('hex'));
            } finally { await response.dispose(); }
          }
          assert.equal(hashes[0], hashes[1], `${field}/${groupIndex}/${index} image content and order`);
          report.imageReadback.push({ field, group: group.enName, index, sha256: hashes[0], sameBytes: true });
          save();
        }
      }
    }
    report.ok = true;
    return { ok: true, draftId: report.draftId, mode: report.mode, highlights: highlights.split('\n').length,
      faq: faq.length, galleries: (fields.detailImage || []).map(g => ({ name: g.enName, images: g.imageList.length })) };
  } catch (error) {
    report.error = { message: error.message, code: error.code, diagnostics: error.diagnostics };
    throw error;
  } finally { await Promise.allSettled(receipts); page.off('response', onResponse); page.off('request', onRequest); save(); }
}
