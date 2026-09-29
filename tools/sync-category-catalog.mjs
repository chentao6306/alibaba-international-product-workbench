// Maintainer tool: read the official directory from an already logged-in local
// test browser. It neither logs in nor submits products; no account data is saved.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createCategoryCatalog } from '../server/category-catalog-model.js';

const endpoint = new URL(process.argv[2] || 'http://127.0.0.1:9235');
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') throw new Error('仅支持本机测试浏览器');
const destination = process.argv[3] || fileURLToPath(new URL('../server/category-catalog-data.js', import.meta.url));
const browser = await chromium.connectOverCDP(endpoint.href);
const page = browser.contexts().flatMap((context) => context.pages()).find((page) => {
  try { const url = new URL(page.url()); return url.protocol === 'https:' && url.hostname === 'post.alibaba.com'; } catch { return false; }
});
if (!page) throw new Error('请先在测试浏览器登录国际站并打开产品类目页面');

const nodes = new Map();
const pending = ['0'];
const fetched = new Set();
async function readChildren(ids, language) {
  const result = await page.evaluate(async ({ ids, language }) => {
    const url = new URL('/product/category/subCat.jsonp', location.origin);
    url.searchParams.set('catIds', ids.join(',')); url.searchParams.set('language', language);
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('官方目录请求失败');
    return response.json();
  }, { ids, language });
  if (result.success !== true || result.code !== 200) throw new Error('官方目录未返回有效数据，请检查登录状态');
  return result.data || {};
}
while (pending.length) {
  const ids = pending.splice(0, 30);
  const translated = {};
  for (const language of ['en_US', 'zh_CN']) {
    translated[language] = await readChildren(ids, language);
  }
  for (const parentId of ids) {
    let english = translated.en_US[parentId], chinese = translated.zh_CN[parentId];
    if (!english?.length || !chinese?.length) {
      english = (await readChildren([parentId], 'en_US'))[parentId];
      chinese = (await readChildren([parentId], 'zh_CN'))[parentId];
      // An explicit successful empty reply is not evidence that a folder is a
      // leaf. Keep it visible but unselectable and record the missing branch.
      if (!english?.length && !chinese?.length && nodes.has(parentId)) {
        nodes.get(parentId).unavailable = true; fetched.add(parentId);
        console.log(`官方暂未提供子目录：${parentId}`); continue;
      }
    }
    if (!Array.isArray(english) || !english.length || !Array.isArray(chinese) || english.length !== chinese.length) throw new Error(`类目 ${parentId} 的子目录不完整`);
    const chineseById = new Map(chinese.map((item) => [String(item.catId), item]));
    for (const entry of english) {
      const id = String(entry.catId), translation = chineseById.get(id);
      if (!translation?.name || translation.isLeaf !== entry.isLeaf || !entry.name) throw new Error(`类目 ${id} 的中英文目录不一致`);
      const node = { id, parentId, name: entry.name, nameZh: translation.name, leaf: entry.isLeaf };
      const previous = nodes.get(id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(node)) throw new Error(`类目 ${id} 存在冲突的上级路径`);
      nodes.set(id, node);
      if (entry.isLeaf === false && !previous && !fetched.has(id)) pending.push(id);
    }
    fetched.add(parentId);
  }
  if (nodes.size > 50000 || fetched.size > 10000) throw new Error('官方类目目录超出预期规模');
  console.log(`已读取 ${nodes.size} 个类目，剩余 ${pending.length} 个目录`);
  if (pending.length) await new Promise((resolve) => setTimeout(resolve, 300));
}
const ordered = [...nodes.values()].sort((a, b) => Number(a.id) - Number(b.id));
const catalog = createCategoryCatalog(ordered);
const data = {
  schemaVersion: 1,
  updatedAt: new Date().toISOString(),
  source: 'https://post.alibaba.com/product/category.htm',
  rootCount: catalog.children().length,
  leafCount: catalog.leafCount,
  unavailableBranchCount: ordered.filter((node) => node.unavailable).length,
  nodes: ordered,
};
await fs.mkdir(path.dirname(destination), { recursive: true });
await fs.writeFile(destination, `// Official Alibaba posting taxonomy. Regenerate with tools/sync-category-catalog.mjs.\n// Contains only category IDs, hierarchy and names; no account or permission data.\nexport const CATEGORY_CATALOG = ${JSON.stringify(data)};\n`);
console.log(JSON.stringify({ saved: destination, rootCount: data.rootCount, leafCount: data.leafCount, nodes: catalog.size }));
// Disconnect this client without closing the maintainer's test browser.
process.exit(0);
