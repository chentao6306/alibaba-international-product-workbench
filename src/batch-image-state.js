export const PRODUCT_PAGE_SIZE = 12;
export const IMAGE_PAGE_SIZE = 8;
export const UNDO_BYTE_LIMIT = 8 * 1024 * 1024;
export const UNDO_STEP_LIMIT = 20;

const keys = ['mainImages', 'detailImages'];
const equalList = (a, b) => a === b || a.length === b.length && a.every((url, i) => url === b[i]);

// Keep only changed image lists. Unchanged products, metadata and revisions are
// shared with the current draft instead of being retained by every undo step.
export function imageUndoEntry(before, after) {
  const patches = [];
  let bytes = 0;
  for (let i = 0; i < before.length; i++) {
    const previous = before[i], next = after[i];
    if (previous === next) continue;
    const lists = {};
    for (const key of keys) {
      if (equalList(previous[key], next[key])) continue;
      lists[key] = previous[key];
      bytes += previous[key].reduce((total, url) => total + String(url).length * 2 + 16, 32);
    }
    if (Object.keys(lists).length) { patches.push({ id: previous.id, ...lists }); bytes += 96; }
  }
  return { patches, bytes };
}

export function appendImageUndo(history, entry, byteLimit = UNDO_BYTE_LIMIT) {
  if (!entry.patches.length) return history;
  // A skipped oversized step must clear earlier history: undoing past that step
  // would otherwise restore a state the user did not ask to restore.
  if (entry.bytes > byteLimit) return [];
  const next = [...history.slice(-(UNDO_STEP_LIMIT - 1)), entry];
  let bytes = next.reduce((total, item) => total + item.bytes, 0);
  while (bytes > byteLimit) bytes -= next.shift().bytes;
  return next;
}

export function undoImageEntry(drafts, entry) {
  const patches = new Map(entry.patches.map((patch) => [patch.id, patch]));
  return drafts.map((product) => patches.has(product.id) ? { ...product, ...patches.get(product.id) } : product);
}

export function replaceImageTargets(drafts, results) {
  const changed = new Map();
  for (const { target, result, error } of results) {
    if (error || !result || result.url === target.url) continue;
    if (!changed.has(target.id)) changed.set(target.id, []);
    changed.get(target.id).push({ target, result });
  }
  return drafts.map((product) => {
    if (!changed.has(product.id)) return product;
    const next = { ...product }, copied = new Set();
    for (const { target, result } of changed.get(product.id)) {
      if (!copied.has(target.key)) { next[target.key] = [...product[target.key]]; copied.add(target.key); }
      next[target.key][target.index] = result.url;
    }
    return next;
  });
}
