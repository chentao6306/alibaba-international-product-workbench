import { createHash } from 'node:crypto';
import { categoryReadiness, CATEGORY_SCHEMA_MAX_AGE_MS } from './category-readiness.js';
import { workbenchProducts } from './published-cleanup.js';

const DETAIL_FIELDS = new Set(['source', 'working', 'auditTrail', 'publishHistory', 'sourceLanguageEvidence',
  'descriptionHtml', 'structuredDescription', 'description', 'skus', 'postingRequirements', 'categoryReference', 'aiMapping', 'aiCollection']);

export function summarizeProduct(product) {
  const savedReadiness = product.quality?.categoryReadiness;
  const schemaAge = Date.now() - Date.parse(product.postingRequirements?.capturedAt);
  const useSavedReadiness = savedReadiness?.categoryId === String(product.categoryId || product.sourceCategoryId || '')
    && savedReadiness?.capturedAt === product.postingRequirements?.capturedAt
    && schemaAge >= 0 && schemaAge <= CATEGORY_SCHEMA_MAX_AGE_MS;
  return {
    ...Object.fromEntries(Object.entries(product).filter(([key]) => !DETAIL_FIELDS.has(key))),
    summary: true,
    description: String(product.description || '').slice(0, 80),
    skuCount: (product.skus || []).length,
    hasDescription: Boolean(product.description || product.descriptionHtml || product.structuredDescription?.html),
    categoryReadiness: useSavedReadiness ? savedReadiness : categoryReadiness(product),
    publishedSuccessfully: product.status === 'published' || (product.publishHistory || []).some((entry) =>
      ['published', 'submitted', 'success'].includes(String(entry.result?.status || entry.status || '').toLowerCase())),
  };
}

export function createWorkbenchStateReader(store) {
  let diskRevision;
  let cached;
  let revision;
  return (clientRevision) => {
    const nextRevision = store.revision();
    if (nextRevision !== diskRevision) {
      // Select before cloning: immutable captures and publication snapshots
      // belong to the detail endpoint, not the 1.5-second task polling loop.
      cached = store.read(({ jobs, products, postingSchemas, descriptionTemplates, ...rest }) => ({ ...rest, products: workbenchProducts(products).map(summarizeProduct) }));
      revision = `summary:${createHash('sha256').update(JSON.stringify(cached)).digest('hex')}`;
      diskRevision = nextRevision;
    }
    const jobs = store.read((state) => state.jobs);
    return clientRevision === revision ? { unchanged: true, revision, jobs } : { ...cached, revision, jobs };
  };
}
