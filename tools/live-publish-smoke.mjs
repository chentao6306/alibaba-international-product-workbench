import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { SellerPublisher, hasCompleteSourceData, sanitizeCollectedProduct } from '../server/publisher.js';
import { resolvePublishRoute } from '../server/category-routing.js';

const args = process.argv.slice(2);
const submit = args.includes('--submit');
const query = args.find((value) => !value.startsWith('--')) || '';
const dataDir = path.resolve(process.env.DATA_DIR || '.data');
if (!query) throw new Error('请提供商品 ID、来源 ID 或标题关键词');

const store = new JsonStore(path.join(dataDir, 'workspace.json'));
const state = store.read();
const product = state.products.find((item) => [item.id, item.sourceId].includes(query))
  || state.products.find((item) => String(item.title || '').toLowerCase().includes(query.toLowerCase()));
if (!product) throw new Error(`没有找到测试商品：${query}`);

const publisher = new SellerPublisher(dataDir);
try {
  let testProduct = sanitizeCollectedProduct(structuredClone(product));
  if (!hasCompleteSourceData(testProduct)) {
    [testProduct] = await publisher.enrichSourceProducts([testProduct], (progress) => {
      process.stdout.write(`${JSON.stringify(progress)}\n`);
    });
  }
  const route = resolvePublishRoute(testProduct, { publishBindings: {} });
  process.stdout.write(`${JSON.stringify({
    stage: 'route', mode: submit ? 'submit' : 'draft',
    product: { id: testProduct.id, sourceId: testProduct.sourceId, title: testProduct.title },
    categoryId: route.categoryId, category: route.category, url: route.url, automatic: route.automatic,
    sourceFields: {
      mainImages: testProduct.mainImages?.length || 0,
      detailImages: testProduct.detailImages?.length || 0,
      attributes: testProduct.attributes?.length || 0,
      variants: testProduct.variantGroups?.length || 0,
      skus: testProduct.skus?.length || 0,
      priceTiers: testProduct.priceTiers?.length || 0
    }
  })}\n`);
  if (route.error || !route.url) throw new Error(route.error || '无法自动生成发布页');
  try {
    const result = await publisher.publishProduct(testProduct, route.url, submit ? 'submit' : 'draft', route.category, 'live-smoke');
    process.stdout.write(`${JSON.stringify({ stage: 'result', result })}\n`);
  } catch (error) {
    const form = await publisher.inspectCurrentForm().catch(() => null);
    const diagnostics = form?.diagnostics;
    process.stdout.write(`${JSON.stringify({
      stage: 'failure',
      error: String(error?.message || error),
      diagnostics: diagnostics ? {
        mainImageState: diagnostics.mainImageState,
        saleSpecControls: diagnostics.saleSpecControls,
        visibleCheckboxControls: diagnostics.visibleCheckboxControls?.filter((item) => item.checked),
        errors: diagnostics.errors,
        mainImageHtml: diagnostics.mainImageHtml,
        fileInputs: diagnostics.fileInputs?.map((item) => ({ accept: item.accept, multiple: item.multiple, ancestors: item.ancestors?.slice(0, 2) }))
      } : null
    })}\n`);
    throw error;
  }
} finally {
  await publisher.shutdown();
}
