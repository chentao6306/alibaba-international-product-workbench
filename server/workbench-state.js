import { createHash } from 'node:crypto';
import { categoryReadiness, CATEGORY_SCHEMA_MAX_AGE_MS } from './category-readiness.js';
import { workbenchProducts } from './published-cleanup.js';
import { cloneWorkspaceValue } from './workspace-clone.js';
import { publishCounts } from './publish-progress.js';

const DETAIL_FIELDS = new Set(['source', 'working', 'auditTrail', 'publishHistory', 'sourceLanguageEvidence',
  'descriptionHtml', 'structuredDescription', 'description', 'skus', 'postingRequirements', 'categoryReference', 'aiMapping', 'aiCollection']);
const JOB_FIELDS = ['id', 'type', 'status', 'progress', 'total', 'message', 'createdAt', 'updatedAt',
  'currentProductId', 'waitingForDelay', 'verificationState', 'pauseAfterCurrent', 'collectionStage', 'discovered'];
const JOB_METADATA_FIELDS = ['groupId', 'groupName', 'sourcePlatform', 'sourcePlatforms', 'collectionMethod',
  'collectionFolderId', 'mode', 'listingMode', 'publishDelay', 'sellerGroup', 'productIds', 'stockPolicy'];
const OMITTED_STATE_FIELDS = new Set(['jobs', 'products', 'postingSchemas', 'descriptionTemplates']);
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value && Object.hasOwn(value, key)).map(key => [key, value[key]]));

export function summarizeJob(job) {
  const metadata = pick(job.metadata, JOB_METADATA_FIELDS);
  if (job.metadata?.failures) metadata.failures = job.metadata.failures.map(failure => pick(failure, ['url', 'source', 'error']));
  const summary = { ...pick(job, JOB_FIELDS), metadata, summary: true };
  if (job.results) {
    summary.outcomeCounts = publishCounts(job);
    const active = ['queued', 'running', 'pause_requested', 'paused'].includes(job.status);
    // Active result keys drive queued/current-product display. Completed task
    // rows need counts and unresolved video actions, not every saved receipt.
    summary.results = Object.fromEntries(Object.entries(job.results).flatMap(([id, result]) => {
      const pendingVideo = result.status === 'published' && result.videoAssociation
        && !result.videoAssociation.associated && !result.videoAssociation.pendingPublication;
      if (!active && !pendingVideo) return [];
      return [[id, { status: result.status, ...(pendingVideo ? {
        title: result.title, url: result.url,
        videoAssociation: pick(result.videoAssociation, ['associated', 'pendingPublication', 'warning']),
      } : {}) }]];
    }));
  }
  return summary;
}

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
  let cached;
  let revision;
  let previousFields = [];
  let previousProducts;
  let expiresAt = 0;
  let previousTime = 0;
  const productCache = new WeakMap();
  const jobCache = new WeakMap();
  return (clientRevision) => {
    // snapshot refreshes on external disk changes. References below are only
    // read; API callers always receive detached summaries.
    const state = store.snapshot();
    const now = Date.now();
    const fields = Object.entries(state).filter(([key]) => !OMITTED_STATE_FIELDS.has(key));
    const restChanged = fields.length !== previousFields.length || fields.some(([key, value], index) =>
      key !== previousFields[index]?.[0] || value !== previousFields[index]?.[1]);
    if (!cached || previousProducts !== state.products || restChanged || now >= expiresAt || now < previousTime) {
      const hash = createHash('sha256');
      const rest = Object.fromEntries(fields);
      hash.update(JSON.stringify(rest));
      expiresAt = Infinity;
      const products = workbenchProducts(state.products).map(product => {
        let entry = productCache.get(product);
        if (!entry || now >= entry.expiresAt || now < previousTime) {
          const captured = Date.parse(product.postingRequirements?.capturedAt);
          const deadline = captured > now ? captured : captured + CATEGORY_SCHEMA_MAX_AGE_MS + 1;
          const summary = cloneWorkspaceValue(summarizeProduct(product));
          entry = { summary, expiresAt: deadline > now ? deadline : Infinity,
            hash: createHash('sha256').update(JSON.stringify(summary)).digest('hex') };
          productCache.set(product, entry);
        }
        hash.update(entry.hash);
        expiresAt = Math.min(expiresAt, entry.expiresAt);
        return entry.summary;
      });
      cached = { ...cloneWorkspaceValue(rest), products };
      revision = `summary:${hash.digest('hex')}`;
      previousFields = fields;
      previousProducts = state.products;
    }
    previousTime = now;
    const jobs = state.jobs.map(job => {
      if (!jobCache.has(job)) jobCache.set(job, cloneWorkspaceValue(summarizeJob(job)));
      return jobCache.get(job);
    });
    return cloneWorkspaceValue(clientRevision === revision ? { unchanged: true, revision, jobs } : { ...cached, revision, jobs });
  };
}
