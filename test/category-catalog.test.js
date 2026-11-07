import test from 'node:test';
import assert from 'node:assert/strict';
import { createCategoryCatalog } from '../server/category-catalog-model.js';
import { CATEGORY_CATALOG as snapshot } from '../server/category-catalog-data.js';
import { buildAlibabaPublishUrl, categoryIdFromUrl, normalizeCategoryId, productCategory } from '../server/category-routing.js';

const nodes = () => [
  { id: '1', parentId: '0', name: 'Agriculture', nameZh: '农业', leaf: false },
  { id: '135', parentId: '1', name: 'Other Agriculture Products', nameZh: '其他农业产品', leaf: true },
  { id: '44', parentId: '0', name: 'Consumer Electronics', nameZh: '消费电子', leaf: false },
  { id: '509', parentId: '44', name: 'Accessories', nameZh: '配件', leaf: false },
  { id: '201346401', parentId: '509', name: 'Drones Accessories', nameZh: '无人机配件', leaf: true },
  { id: '9999', parentId: '1', name: 'Accessories', nameZh: '配件', leaf: true },
];

test('catalog browses by ID and produces full leaf paths without merging duplicate names', () => {
  const input = nodes(), original = structuredClone(input);
  const catalog = createCategoryCatalog(input.reverse());
  assert.equal(catalog.size, 6);
  assert.equal(catalog.leafCount, 3);
  assert.deepEqual(catalog.children().map((node) => node.id), ['1', '44']);
  assert.deepEqual(catalog.path('201346401').map((node) => node.id), ['44', '509', '201346401']);
  assert.equal(catalog.option('44'), null);
  assert.equal(catalog.option('509'), null);
  assert.equal(catalog.option('unknown'), null);
  assert.equal(catalog.option('135').path, 'Agriculture >> Other Agriculture Products');
  assert.equal(catalog.option('201346401').pathZh, '消费电子 >> 配件 >> 无人机配件');
  assert.deepEqual(input.reverse(), original);
});

test('catalog search supports names, ancestors, Chinese and exact short IDs with bounded results', () => {
  const catalog = createCategoryCatalog(nodes());
  for (const query of ['DRONES', 'consumer accessories', '无人机', '201346401']) assert.equal(catalog.search(query).items[0].id, '201346401');
  assert.equal(catalog.search('135').items[0].id, '135');
  assert.deepEqual(catalog.search('  '), { total: 0, items: [] });
  assert.equal(catalog.search('missing').total, 0);
  assert.equal(catalog.search('accessories', 1).total, 2);
  assert.equal(catalog.search('accessories', 1).items.length, 1);
});

test('catalog rejects incomplete, conflicting, cyclic and invalid trees instead of treating folders as leaves', () => {
  for (const invalid of [[], [{ id: '1', name: 'Root' }], [...nodes(), nodes()[0]], nodes().filter((node) => node.id !== '509'),
    nodes().map((node) => node.id === '44' ? { ...node, leaf: true } : node),
    nodes().map((node) => node.id === '135' ? { ...node, leaf: false } : node),
    [{ id: '1', parentId: '2', name: 'A', leaf: false }, { id: '2', parentId: '1', name: 'B', leaf: false }],
  ]) assert.throws(() => createCategoryCatalog(invalid));
});

test('an explicitly unavailable branch stays visible and cannot become a selectable leaf', () => {
  const catalog = createCategoryCatalog([...nodes(), { id: '1234', parentId: '1', name: 'Unavailable folder', leaf: false, unavailable: true }]);
  assert.equal(catalog.get('1234').unavailable, true);
  assert.equal(catalog.option('1234'), null);
  assert.equal(catalog.search('Unavailable').total, 0);
  assert.throws(() => createCategoryCatalog([{ id: '1', name: 'A', leaf: true, unavailable: true }]));
});

test('bundled official catalog is bilingual, internally complete and every leaf can be routed without losing short IDs', () => {
  const catalog = createCategoryCatalog(snapshot.nodes);
  assert.equal(catalog.children().length, snapshot.rootCount);
  assert.equal(catalog.leafCount, snapshot.leafCount);
  assert.ok(snapshot.rootCount >= 50 && snapshot.leafCount > 7000);
  assert.equal(snapshot.nodes.filter((node) => node.unavailable).length, snapshot.unavailableBranchCount);
  for (const node of snapshot.nodes) {
    assert.ok(node.nameZh, node.id);
    assert.deepEqual(Object.keys(node).filter((key) => !['id', 'parentId', 'name', 'nameZh', 'leaf', 'unavailable'].includes(key)), []);
    if (!node.leaf) continue;
    assert.equal(normalizeCategoryId(node.id), node.id);
    assert.equal(categoryIdFromUrl(buildAlibabaPublishUrl(node.id)), node.id);
    assert.equal(productCategory({ categoryId: node.id, categoryPath: catalog.path(node.id).map((part) => part.name) }).id, node.id);
  }
  assert.equal(catalog.option('135').path, 'Agriculture >> Other Agriculture Products');
  assert.equal(catalog.option('201774004').path.split(' >> ').at(-1), 'Plush Keychains Toys');
  assert.equal(catalog.option('201346401').path.split(' >> ').at(-1), 'Drones Accessories');
  assert.equal(categoryIdFromUrl('https://www.alibaba.com/category-135.html'), '135');
  assert.equal(normalizeCategoryId('5G smartphone'), '');
  assert.equal(normalizeCategoryId('ID 201896803'), '201896803');
});
