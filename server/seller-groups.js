import { clickPostingControl } from './posting-interaction.js';

const selector = '#struct-productGroup .product-group-select';
const popupSelector = '.posting-field-group:visible';

async function closeTree(page) {
  const control = page.locator(selector);
  const input = control.locator('input');
  await (await input.count() ? input : control).focus();
  await page.keyboard.press('Escape');
  if (await control.getAttribute('aria-expanded') === 'true') await clickPostingControl(page, control);
  await page.locator(popupSelector).waitFor({ state: 'hidden', timeout: 5000 });
}

export function normalizeSellerGroup(value) {
  if (!value || !value.id) return null;
  const id = String(value.id);
  if (!/^\d{1,30}$/.test(id)) throw Object.assign(new Error('国际站商品分组无效，请重新读取分组'), { status: 400 });
  return { id, name: String(value.name || '').slice(0, 200), path: String(value.path || value.name || '').slice(0, 1000) };
}

async function openTree(page) {
  const control = page.locator(selector);
  await control.waitFor({ state: 'visible', timeout: 30000 });
  if (await control.getAttribute('aria-expanded') !== 'true') {
    await page.locator(popupSelector).waitFor({ state: 'hidden', timeout: 5000 });
    await clickPostingControl(page, control);
  }
  const popup = page.locator(popupSelector);
  await popup.waitFor({ state: 'visible', timeout: 15000 });
  await popup.locator('[role="tree"]').waitFor({ state: 'visible', timeout: 15000 });
  await popup.locator('li.next-tree-node[value]').first().waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});
  // Expand parents through the real tree control; names can repeat across branches.
  for (let count = 0; count < 1000; count += 1) {
    const switcher = popup.locator('[role="treeitem"][aria-expanded="false"] > .next-tree-switcher:not([class*="noop"])').first();
    if (!await switcher.count()) return popup;
    const id = normalizeSellerGroup({ id: await switcher.locator('../..').getAttribute('value') }).id;
    await clickPostingControl(page, switcher);
    await popup.locator(`li.next-tree-node[value="${id}"] > [role="treeitem"][aria-expanded="true"]`).waitFor({ state: 'visible', timeout: 10000 });
  }
  throw new Error('国际站分组数量过多，无法完整读取');
}

export async function readSellerGroups(page) {
  const popup = await openTree(page);
  try {
    return await popup.locator('li.next-tree-node[value]').evaluateAll((nodes) => nodes.map((node) => {
      const path = [];
      for (let parent = node; parent; parent = parent.parentElement?.closest('li.next-tree-node[value]')) {
        const label = parent.querySelector(':scope > [role="treeitem"]');
        path.unshift(label?.getAttribute('aria-label') || label?.querySelector('.next-tree-node-label')?.textContent?.trim() || '');
      }
      return { id: node.getAttribute('value'), name: path.at(-1), path: path.join(' > '), disabled: node.querySelector(':scope > [role="treeitem"]')?.getAttribute('aria-disabled') === 'true' };
    }).filter((item) => item.id && item.name && !item.disabled));
  } finally { await closeTree(page); }
}

export async function applySellerGroup(page, value) {
  const group = normalizeSellerGroup(value);
  if (!group) return null;
  const popup = await openTree(page);
  const item = popup.locator(`li.next-tree-node[value="${group.id}"] > [role="treeitem"]`);
  if (await item.count() !== 1 || await item.getAttribute('aria-disabled') === 'true') {
    await closeTree(page);
    throw Object.assign(new Error(`国际站商品分组不存在或不可选：${group.path || group.id}，请重新读取分组`), { code: 'SELLER_GROUP_UNAVAILABLE' });
  }
  const name = await item.getAttribute('aria-label');
  // Publishing checks the group twice. Clicking an already selected tree item can toggle it off.
  if (await item.getAttribute('aria-selected') !== 'true') {
    await clickPostingControl(page, item.locator('.next-tree-node-label'));
    await popup.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => {});
    await openTree(page);
  }
  const selected = page.locator(popupSelector).locator(`li.next-tree-node[value="${group.id}"] > [role="treeitem"][aria-selected="true"]`);
  const accepted = await selected.waitFor({ state: 'attached', timeout: 8000 }).then(() => true, () => false);
  await closeTree(page);
  if (!accepted) throw Object.assign(new Error(`国际站未接受商品分组：${group.path || group.id}`), { code: 'SELLER_GROUP_UNAVAILABLE' });
  return { ...group, name: name || group.name };
}
