import { sourceAttributeForField } from './category-attributes.js';

// One session per product attempt. Re-read dependent controls, bound model
// requests across all stages, and never treat a proposal as a committed edit.
export function createAttributeAiSession({ resolve, readSchema, fill, matches, onAudit = async () => {}, onProgress = () => {} }) {
  const audits = [];
  const seen = new Set();
  let requests = 0;
  return {
    audits,
    async run(product, { phase = 'preflight', feedback } = {}) {
      if (!resolve) return { product, changed: false };
      let changed = false;
      for (let pass = 0; pass < 2 && requests < 4; pass++) {
        const current = await readSchema();
        const schema = current.map(field => {
          const source = sourceAttributeForField(product, field);
          return { ...field, needsMapping: Boolean(source && !source.conflict && !matches(field, source)) };
        });
        const signature = JSON.stringify({ category: product.categoryId || product.targetCategoryId || product.sourceCategoryId,
          attributes: product.attributes, fields: schema.map(({ id, label, labels, values, hasValue, options, required, disabled, controlType, multiple, maxLength, needsMapping }) =>
            ({ id, label, labels, values, hasValue, options, required, disabled, controlType, multiple, maxLength, needsMapping })), feedback });
        if (seen.has(signature)) break;
        seen.add(signature);
        const mapped = await resolve(product, schema, { feedback });
        if (mapped.audit) {
          requests++;
          mapped.audit.stage = phase;
          audits.push(mapped.audit);
          await onAudit(audits);
          if (mapped.audit.message) onProgress(mapped.audit.message);
        }
        if (!mapped.audit?.accepted?.length) break;
        product = mapped.product;
        onProgress('填写并复核 AI 辅助映射的属性');
        try {
          await fill(product);
        } finally {
          const committed = await readSchema();
          mapped.audit.readback = mapped.audit.accepted.map(item => {
            const field = committed.find(field => field.id === item.id);
            return { id: item.id, accepted: Boolean(field && matches(field, { ...item, matchedById: true })), values: field?.values || [] };
          });
          await onAudit(audits);
          const verifiedChange = mapped.audit.readback.every(item => item.accepted)
            && mapped.audit.readback.some(item => JSON.stringify(item.values) !== JSON.stringify(current.find(field => field.id === item.id)?.values || []));
          changed = changed || verifiedChange;
        }
      }
      return { product, changed };
    },
  };
}
