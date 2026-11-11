import test from 'node:test';
import assert from 'node:assert/strict';
import { currentDescriptionStructure, descriptionSourceHash, syncStructuredDescriptionImages } from '../server/description-structure.js';
import { preparePublishProduct } from '../server/publisher.js';

const urls = ['product-a', 'product-b', 'company-a'].map(name => `https://sc04.alicdn.com/kf/${name}.jpg`);
const fixture = () => {
  const html = urls.map(url => `<img src="${url}">`).join('');
  return { detailImages: [...urls], descriptionHtml: html, structuredDescription: {
    version: 1, sourceHtmlHash: descriptionSourceHash(html), modules: [
      { type: 'highlights', items: ['Current edited selling point'] },
      { type: 'gallery', scope: 'product', title: 'Detail shot', images: urls.slice(0, 2).map(url => ({ url, caption: '' })) },
      { type: 'company', text: 'Current company introduction' },
      { type: 'gallery', scope: 'company', title: 'Company overview', images: [{ url: urls[2], caption: '' }] },
      { type: 'faq', items: [{ question: 'Custom question?', answer: 'Current answer.' }] },
    ],
  } };
};

function edit(product, detailImages, restoreStructure = null) {
  const html = detailImages.map(url => `<img src="${url}">`).join('');
  return { ...product, detailImages, descriptionHtml: html, imageEdits: { detail: true },
    structuredDescription: syncStructuredDescriptionImages(product, { beforeImages: product.detailImages, detailImages, html, restoreStructure }) };
}
const galleries = product => currentDescriptionStructure(product).modules.filter(module => module.type === 'gallery');

test('detail image deletions survive persistence and publish preparation with native scopes and current text intact', () => {
  const original = fixture(), before = structuredClone(original);
  const edited = edit(original, [urls[1], urls[2]]);
  const reopened = preparePublishProduct(JSON.parse(JSON.stringify(edited)));
  assert.deepEqual(reopened.detailImages, [urls[1], urls[2]]);
  assert.deepEqual(galleries(reopened).map(module => [module.title, module.scope, module.images.map(image => image.url)]), [
    ['Detail shot', 'product', [urls[1]]], ['Company overview', 'company', [urls[2]]],
  ]);
  assert.deepEqual(currentDescriptionStructure(reopened).modules.filter(module => module.type !== 'gallery'), original.structuredDescription.modules.filter(module => module.type !== 'gallery'));
  assert.deepEqual(original, before);
});

test('watermark replacement and selected order update gallery URLs without moving company images into product galleries', () => {
  const original = fixture();
  const edited = edit(original, [urls[1], urls[0], '/media/company-watermark.png']);
  assert.deepEqual(galleries(edited).map(module => module.images.map(image => image.url)), [[urls[1], urls[0]], ['/media/company-watermark.png']]);
  const added = edit(edited, [...edited.detailImages, '/media/new-detail.png']);
  assert.deepEqual(galleries(added).find(module => module.title === 'Other product images'), { type: 'gallery', scope: 'product', title: 'Other product images', images: [{ url: '/media/new-detail.png', caption: '' }] });
});

test('clear and restore use selected source gallery membership without resurrecting old text or mutating source', () => {
  const original = fixture(), source = structuredClone(original.structuredDescription);
  source.modules[0].items = ['Original source selling point'];
  const sourceBefore = structuredClone(source);
  const cleared = edit(original, []);
  assert.deepEqual(galleries(cleared), []);
  assert.deepEqual(preparePublishProduct(cleared).detailImages, []);
  const restored = edit(cleared, [...urls], source);
  assert.deepEqual(galleries(restored), galleries(original));
  assert.deepEqual(currentDescriptionStructure(restored).modules.map(module => module.type), original.structuredDescription.modules.map(module => module.type));
  assert.deepEqual(currentDescriptionStructure(restored).modules.find(module => module.type === 'highlights').items, ['Current edited selling point']);
  assert.deepEqual(source, sourceBefore);
  assert.equal(syncStructuredDescriptionImages({ ...original, descriptionHtml: '<p>Manual rich text replacement</p>' }, {
    beforeImages: urls, detailImages: urls, html: '<p>Manual rich text replacement</p>', restoreStructure: source,
  }), null);
});

test('deleting a duplicated detail image removes only the selected occurrence from native galleries', () => {
  const original = fixture();
  original.detailImages.splice(1, 0, urls[0]);
  original.structuredDescription.modules[1].images.splice(1, 0, { url: urls[0], caption: '' });
  const edited = edit(original, urls);
  assert.deepEqual(galleries(edited).flatMap(module => module.images.map(image => image.url)), urls);
});

test('publish preparation repairs previously saved native deletions only with explicit image edit provenance', () => {
  const product = { ...fixture(), detailImages: [urls[1]], imageEdits: { detail: true } };
  const before = structuredClone(product);
  const prepared = preparePublishProduct(product);
  assert.deepEqual(prepared.detailImages, [urls[1]]);
  assert.deepEqual(galleries(prepared).flatMap(module => module.images.map(image => image.url)), [urls[1]]);
  assert.deepEqual(product, before);
  const cleared = preparePublishProduct({ ...product, detailImages: [] });
  assert.deepEqual(galleries(cleared), []);
  assert.deepEqual(cleared.detailImages, []);
  const unknown = preparePublishProduct({ ...product, imageEdits: {} });
  assert.deepEqual(new Set(unknown.detailImages), new Set(urls));
});
