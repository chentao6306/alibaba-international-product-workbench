import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDescriptionStructure, currentDescriptionStructure, requireDescriptionStructure } from '../server/description-structure.js';
import { extractAlibabaDescription } from '../server/alibaba-source-data.js';
import { compileNativeDescription } from '../server/native-description-fields.js';
import { sanitizeCollectedProduct, preparePublishProduct } from '../server/publisher.js';

const module = html => `<div module-name="icbu-pc-detailStructured">${html}</div>`;
const source = module('<div class="comp-highlights-title">Highlights at a glance</div><div class="comp-highlights-list"><ul><li>TPE Material: Durable protection.</li><li>Vented Design: Keeps legs cool.</li></ul></div>')
  + module('<div class="comp-navigation-sib">Detail shot</div>')
  + module('<img class="comp-singleimg-img" src="https://sc01.alicdn.com/kf/product.jpg">')
  + module('<span class="comp-companyintroduction-title">About this supplier</span><span class="comp-companyintroduction-text">Established in 2019.</span>')
  + '<div data-component-group-name="company-gallery@_@Company overview@_@123@_@navigation">'
  + module('<div class="comp-navigation-sib">Company overview</div>') + '</div>'
  + module('<img class="comp-singleimg-img" src="https://sc01.alicdn.com/kf/company.jpg">')
  + module('<div class="comp-faq-title">FAQs</div><div class="comp-faq-card"><div class="comp-faq-question">Who are we?</div><div class="comp-faq-answer">A trading company.</div></div>');

test('preserves native highlights, product and company galleries, introduction and FAQ identities in source order', () => {
  const parsed = extractDescriptionStructure(source);
  assert.deepEqual(parsed.modules.map(m => m.type), ['highlights', 'gallery', 'company', 'gallery', 'faq']);
  assert.deepEqual(parsed.modules[0].items, ['TPE Material: Durable protection.', 'Vented Design: Keeps legs cool.']);
  assert.equal(parsed.modules[3].scope, 'company');
  assert.equal(parsed.modules[3].images[0].url, 'https://sc01.alicdn.com/kf/company.jpg');
  assert.deepEqual(parsed.modules[4].items, [{ question: 'Who are we?', answer: 'A trading company.' }]);
});

test('rejects flattened text as a substitute for saved native description modules', () => {
  const parsed = extractDescriptionStructure(source);
  assert.throws(() => requireDescriptionStructure(parsed, { modules: [{ type: 'html', html: source }] }), { code: 'PUBLISH_DESCRIPTION_STRUCTURE_MISMATCH' });
  const changed = structuredClone(parsed); changed.modules[3].scope = 'product';
  assert.throws(() => requireDescriptionStructure(parsed, changed), /未完整保存/);
  requireDescriptionStructure(parsed, structuredClone(parsed));
});

test('does not infer structured modules from arbitrary headings or restore stale structure over manual edits', () => {
  assert.equal(extractDescriptionStructure('<h2>FAQs</h2><p>Plain source paragraph</p>'), null);
  assert.equal(extractDescriptionStructure(module('<div class="comp-singletext-text">Plain source paragraph</div>')), null);
  assert.equal(currentDescriptionStructure({ descriptionHtml: '<p>Edited</p>', structuredDescription: extractDescriptionStructure(source) }), null);
  assert.equal(currentDescriptionStructure({ descriptionHtml: source, descriptionTemplate: { id: 'manual' } }), null);
});

test('native module identities survive collection cleanup, JSON persistence and preparation without reviving overwritten text', () => {
  const original = extractDescriptionStructure(source);
  const collected = sanitizeCollectedProduct({ descriptionHtml: source, structuredDescription: original });
  assert.doesNotMatch(collected.descriptionHtml, /class=/);
  const reopened = JSON.parse(JSON.stringify(collected));
  requireDescriptionStructure(original, currentDescriptionStructure(reopened));
  requireDescriptionStructure(original, currentDescriptionStructure(preparePublishProduct(reopened)));
  reopened.descriptionHtml = '<p>Manual replacement</p>';
  assert.equal(currentDescriptionStructure(sanitizeCollectedProduct(reopened)), null);
});

test('native collection and publishing separate confirmed video posters from galleries without losing real or edited images', () => {
  const poster = 'https://sc01.alicdn.com/kf/poster.jpg';
  const gallery = ['https://sc01.alicdn.com/kf/product.jpg', 'https://sc01.alicdn.com/kf/company.jpg'];
  const videos = [{ role: 'detail', url: 'https://play.video.alibaba.com/global/play/6000321660417.mp4', poster, source: 'dom' }];
  const product = { descriptionHtml: source, structuredDescription: extractDescriptionStructure(source),
    detailImages: [poster, ...gallery], videos };
  const before = structuredClone(product);
  const collected = sanitizeCollectedProduct(product);
  assert.deepEqual(collected.detailImages, gallery);
  assert.deepEqual(collected.videos, videos);
  for (const uploadProductVideos of [true, false]) {
    const prepared = preparePublishProduct(product, { uploadProductVideos });
    assert.deepEqual(prepared.detailImages, gallery);
    requireDescriptionStructure(product.structuredDescription, currentDescriptionStructure(prepared));
  }
  const withRealImage = { ...product, detailImages: [...product.detailImages, 'https://sc01.alicdn.com/kf/extra.jpg'] };
  assert.ok(preparePublishProduct(withRealImage).detailImages.includes('https://sc01.alicdn.com/kf/extra.jpg'));
  assert.deepEqual(sanitizeCollectedProduct({ ...product, imageEdits: { detail: true } }).detailImages, product.detailImages);
  assert.deepEqual(sanitizeCollectedProduct({ ...product, videos: [{ ...videos[0], poster: gallery[0] }] }).detailImages, product.detailImages);
  assert.deepEqual(sanitizeCollectedProduct({ ...product, descriptionHtml: '<p>Old detail</p>', structuredDescription: null }).detailImages, product.detailImages);
  assert.deepEqual(product, before);
});

const schemas = {
  textDesc: { maxLength: 2000 }, companyDesc: { maxLength: 2000 },
  companyFaqDesc: { maxItem: 8, questionLength: 150, answerLength: 500 },
  detailImage: { maxGalleryItem: 3, maxImageItem: 30, dataSource: [{ value: '350', enName: 'Other product images', cnName: '其他商品图片' }] },
  companyImage: { maxGalleryItem: 3, maxImageItem: 30, dataSource: [{ value: '400', enName: 'Company overview', cnName: '公司介绍' }] },
};

test('accepts all built-in company galleries while retaining actual image and custom gallery limits', () => {
  const names=['Company overview','Competitive advantages','Factory profile','Production workflow','Trade show participation'];
  const schema={...schemas,companyImage:{...schemas.companyImage,maxGalleryItem:3,maxCustomGalleryItem:1,supportCustomGallery:true,maxGalleryNameLength:50,
    dataSource:names.map((enName,i)=>({value:String(400+i*50),enName}))}};
  const structure={modules:names.map((title,i)=>({type:'gallery',scope:'company',title,images:[{url:`https://sc04.alicdn.com/kf/${i}.jpg`}]}))};
  const plan=compileNativeDescription(structure,schema);
  assert.equal(plan.galleries.length,5);
  assert.deepEqual(plan.galleries.map(g=>g.name),names);
  assert.throws(()=>compileNativeDescription(structure,{...schema,companyImage:{...schema.companyImage,maxImageItem:4}}),/共 5 张图片.*4 张/);
  const custom={modules:[...structure.modules,...['Custom A','Custom B'].map(title=>({type:'gallery',scope:'company',title,images:[{url:title}]}))]};
  assert.throws(()=>compileNativeDescription(custom,schema),/自定义图集数量/);
});

test('collects SSR highlights, company gallery and FAQ through lazy source data without flattening or importing recommendations', () => {
  const description = extractAlibabaDescription({ nodeMap: { module_description: { privateData: {
    viewOrder: ['productDescription', 'companyInfo', 'faqInfo', 'recommendProductInfo'],
    productDescription: { title: 'Product Description', details: [{ type: 'text', text: 'TPE: Lightweight.' }, { type: 'text', text: 'Vented: Keeps cool.' }, { type: 'image', url: 'https://sc04.alicdn.com/kf/product.png' }] },
    companyInfo: { title: 'About this supplier', details: [{ type: 'text', text: 'Founded in 2019.' }], imageSetDetails: [{ title: 'Company overview', details: [{ type: 'image', url: 'https://sc04.alicdn.com/kf/company.png' }] }] },
    faqInfo: { title: 'FAQs', details: [{ type: 'qa', question: 'Who are we?', answer: 'A trading company.' }, { type: 'qa', question: 'What do we supply?', answer: 'Motorcycle parts.' }] },
    recommendProductInfo: { details: [{ type: 'text', text: 'NOT THE SOURCE PRODUCT' }] },
  } } } });
  const structure = extractDescriptionStructure(description.html);
  assert.deepEqual(structure.modules.map(module => module.type), ['highlights', 'gallery', 'company', 'gallery', 'faq']);
  const plan = compileNativeDescription(structure, schemas);
  assert.equal(plan.textDesc, 'TPE: Lightweight.\nVented: Keeps cool.');
  assert.equal(plan.companyDesc, 'Founded in 2019.');
  assert.deepEqual(plan.galleries.map(group => [group.rootId, group.value, group.images.length]), [['detailImage', '350', 1], ['companyImage', '400', 1]]);
  assert.deepEqual(plan.companyFaqDesc.map(item => item.answers), ['A trading company.', 'Motorcycle parts.']);
  assert.doesNotMatch(description.html, /NOT THE SOURCE PRODUCT/);
});

test('validates native module and current form limits before any form changes instead of dropping content', () => {
  const highlights = { modules: [{ type: 'highlights', items: ['a'.repeat(2001)] }] };
  assert.throws(() => compileNativeDescription(highlights, schemas), /2000/);
  assert.throws(() => compileNativeDescription({ modules: [{ type: 'html', html: '<table><tr><td>Keep this</td></tr></table>' }] }, schemas), /额外模块/);
  assert.throws(() => compileNativeDescription({ modules: [{ type: 'faq', items: [{ question: 'Q?', answer: '' }] }] }, schemas), /不完整/);
  const gallery = { modules: [{ type: 'gallery', scope: 'company', title: 'Factory profile', images: [{ url: 'https://sc04.alicdn.com/kf/factory.png' }] }] };
  assert.throws(() => compileNativeDescription(gallery, schemas), /无法唯一匹配/);
  gallery.modules[0].title = 'Company overview';
  gallery.modules[0].images[0].caption = 'Keep this caption';
  assert.throws(() => compileNativeDescription(gallery, schemas), /图片文字/);
});
