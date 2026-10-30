// Workspace data is JSON-shaped. Detach mutable containers while reusing
// immutable string values: structuredClone copies the backing storage of every
// long description/history string, multiplying memory during transactions.
export function cloneWorkspaceValue(value, seen = new Map()) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol') return structuredClone(value);
    return value;
  }
  if (seen.has(value)) return seen.get(value);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return structuredClone(value);
  const copy = Array.isArray(value) ? new Array(value.length) : {};
  seen.set(value, copy);
  for (const key of Object.keys(value)) Object.defineProperty(copy, key, {
    value: cloneWorkspaceValue(value[key], seen), writable: true, configurable: true, enumerable: true,
  });
  return copy;
}
