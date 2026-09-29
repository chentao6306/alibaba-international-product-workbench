// Shared by the API and category picker. IDs, rather than translated names,
// identify nodes; a category is selectable only when the source marks it a leaf.
export function createCategoryCatalog(nodes) {
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > 50000) throw new Error('类目目录为空或格式无效');
  const byId = new Map();
  const children = new Map();
  for (const input of nodes) {
    const id = String(input?.id ?? '');
    const parentId = String(input?.parentId ?? '0');
    const name = String(input?.name || '').trim();
    if (!/^[1-9]\d{0,11}$/.test(id) || !/^(?:0|[1-9]\d{0,11})$/.test(parentId) || !name || name.length > 300 || typeof input.leaf !== 'boolean') {
      throw new Error('类目目录含无效节点');
    }
    if (byId.has(id)) throw new Error(`类目 ID 重复：${id}`);
    const node = { id, parentId, name, nameZh: String(input.nameZh || '').trim(), leaf: input.leaf, unavailable: input.unavailable === true };
    byId.set(id, node);
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(node);
  }
  const paths = new Map();
  function ancestry(id, visited = new Set()) {
    if (paths.has(id)) return paths.get(id);
    if (visited.has(id) || visited.size >= 12) throw new Error('类目目录层级循环或过深');
    const node = byId.get(id);
    if (!node) throw new Error(`类目目录缺少上级：${id}`);
    visited.add(id);
    const path = [...(node.parentId === '0' ? [] : ancestry(node.parentId, visited)), node];
    paths.set(id, path);
    return path;
  }
  for (const node of byId.values()) {
    const descendants = children.get(node.id) || [];
    if ((node.leaf && descendants.length) || (!node.leaf && !descendants.length && !node.unavailable) || (node.unavailable && (node.leaf || descendants.length))) throw new Error(`类目末级标记与子类目不一致：${node.id}`);
    ancestry(node.id);
  }
  const ordered = (items) => [...items].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  for (const [id, items] of children) children.set(id, ordered(items));
  const leaves = ordered([...byId.values()].filter((node) => node.leaf));
  const option = (id) => {
    const node = byId.get(String(id));
    if (!node?.leaf) return null;
    const path = paths.get(node.id);
    return { id: node.id, path: path.map((part) => part.name).join(' >> '), pathZh: path.map((part) => part.nameZh || part.name).join(' >> ') };
  };
  const searchable = leaves.map((node) => ({ node, text: `${node.id} ${option(node.id).path} ${option(node.id).pathZh}`.toLocaleLowerCase() }));
  return {
    size: byId.size,
    leafCount: leaves.length,
    get: (id) => byId.get(String(id)) || null,
    children: (id = '0') => children.get(String(id)) || [],
    path: (id) => paths.get(String(id)) || [],
    option,
    search(query, limit = 100) {
      const normalized = String(query || '').trim().toLocaleLowerCase();
      const terms = normalized.split(/\s+/).filter(Boolean);
      if (!terms.length) return { total: 0, items: [] };
      const matches = searchable.filter((entry) => terms.every((term) => entry.text.includes(term)));
      matches.sort((a, b) => Number(b.node.id === normalized) - Number(a.node.id === normalized));
      return { total: matches.length, items: matches.slice(0, Math.max(1, Math.min(500, Number(limit) || 100))).map((entry) => entry.node) };
    },
  };
}
