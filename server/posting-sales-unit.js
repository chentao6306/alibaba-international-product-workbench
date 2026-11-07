import { clickPostingControl, postingInteractionFailure } from './posting-interaction.js';
import { attributeMenuForControl, closePostingAttributeMenus, VISIBLE_ATTRIBUTE_MENU } from './posting-popups.js';

const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
// Identity aliases only: a set, pair or carton must never become one piece,
// and a metric ton must not silently become a differently defined ton.
const units = [
  ['piece', 'pieces', 'pc', 'pcs', '件', '个'], ['set', 'sets', '套'], ['pair', 'pairs', '双', '对'],
  ['box', 'boxes', '盒'], ['carton', 'cartons', '箱'], ['bag', 'bags', '袋'], ['pack', 'packs', '包'],
  ['kilogram', 'kilograms', 'kg', '千克', '公斤'], ['gram', 'grams', 'g', '克'],
  ['meter', 'meters', 'metre', 'metres', 'm', '米'], ['kilometer', 'kilometers', 'km', '千米'],
  ['square meter', 'square meters', 'square metre', 'square metres', 'm2', '平方米'],
  ['cubic meter', 'cubic meters', 'cubic metre', 'cubic metres', 'm3', '立方米'],
  ['liter', 'liters', 'litre', 'litres', 'l', '升'], ['dozen', 'dozens', '打'],
  ['roll', 'rolls', '卷'], ['sheet', 'sheets', '张'], ['unit', 'units'],
  ['metric ton', 'metric tons', 'tonne', 'tonnes', '公吨'], ['ton', 'tons'],
  ['foot', 'feet', 'ft', '英尺'], ['yard', 'yards', '码'], ['pound', 'pounds', 'lb', 'lbs', '磅'],
];
const aliases = new Map(units.flatMap(group => group.map(value => [value, group[0]])));
export function salesUnitIdentity(value) {
  const normalized = clean(value);
  const parts = normalized.split('/').map(part => aliases.get(part.trim()) || part.trim());
  return parts.every(part => part === parts[0]) ? parts[0] : normalized;
}

function unitError(expected, actual, reason) {
  return Object.assign(new Error(`计量单位“${expected}”未被当前发布页接受${actual ? `（当前为 ${actual}）` : ''}；已停止提交，价格和数量未按其他单位转换`), {
    code: 'PUBLISH_FIELD_NOT_READY', fieldName: '计量单位', diagnostics: { reason, expected, actual },
  });
}

async function salesUnitControl(page) {
  for (const selector of ['#priceUnit', '#struct-priceUnit', 'select[name="priceUnit"], [role="combobox"][name="priceUnit"]']) {
    const roots = page.locator(selector).filter({ visible: true });
    if (await roots.count() > 1) return { ambiguous: true };
    if (!await roots.count()) continue;
    const root = roots.first();
    const own = await root.evaluate(node => node.matches('select, [role="combobox"]'));
    const fields = own ? root : root.locator('select, [role="combobox"]').filter({ visible: true });
    if (await fields.count() > 1) return { ambiguous: true };
    if (await fields.count()) return { field: fields.first() };
  }
  return {};
}

async function committedUnit(field) {
  if (!field) return '';
  return field.evaluate(node => {
    if (node.tagName === 'SELECT') return [...node.selectedOptions].map(option => option.textContent.trim()).join('/');
    const root = node.closest('.next-select') || node;
    const labels = [...root.querySelectorAll('.next-select-values em, .next-tag-body, [class*="selected-value"], .ant-select-selection-item')]
      .map(item => item.textContent.trim()).filter(Boolean);
    // Search text in an editable input is not a committed selection.
    return [...new Set(labels)].join('/') || (node.readOnly ? node.value : '');
  }).catch(() => '');
}

export async function requireSalesUnit(page, product) {
  const expected = String(product.salesUnit ?? '').trim();
  if (!expected) return null;
  const { field, ambiguous } = await salesUnitControl(page);
  const actual = await committedUnit(field);
  if (ambiguous || !field || salesUnitIdentity(actual) !== salesUnitIdentity(expected)) {
    throw unitError(expected, actual, ambiguous ? 'ambiguous-control' : !field ? 'missing-control' : 'not-committed');
  }
  return { expected, actual };
}

export async function fillSalesUnit(page, product, { timeoutMs = 10000 } = {}) {
  const expected = String(product.salesUnit ?? '').trim();
  if (!expected) return null;
  const identity = salesUnitIdentity(expected);
  const deadline = performance.now() + timeoutMs;
  let actual = '', reason = 'missing-control', stableSince = 0;
  while (performance.now() < deadline) {
    const { field, ambiguous } = await salesUnitControl(page);
    if (ambiguous) throw unitError(expected, actual, 'ambiguous-control');
    actual = await committedUnit(field);
    if (actual && salesUnitIdentity(actual) === identity) {
      stableSince ||= performance.now();
      if (performance.now() - stableSince >= 350) return requireSalesUnit(page, product);
    } else {
      stableSince = 0;
      if (field && await field.isEnabled().catch(() => false)) {
        const native = await field.evaluate(node => node.tagName === 'SELECT');
        let activeMenu;
        try {
          if (native) {
            const options = await field.locator('option').evaluateAll(nodes => nodes.map(node => ({ value: node.value, label: node.textContent, disabled: node.disabled || node.parentElement.disabled })));
            const matches = options.filter(option => !option.disabled && salesUnitIdentity(option.label) === identity);
            if (matches.length !== 1) throw unitError(expected, actual, matches.length ? 'ambiguous-option' : 'unavailable-option');
            await field.selectOption(matches[0].value, { timeout: 1000 });
          } else {
            await clickPostingControl(page, field, { timeout: 1500 });
            const ownedIds = await field.evaluate(node => [node, node.closest('.next-select')].filter(Boolean)
              .flatMap(item => [item.getAttribute('aria-controls'), item.getAttribute('aria-owns')]).filter(Boolean).join(' ').split(/\s+/).filter(Boolean));
            const popup = ownedIds.length
              ? page.locator([...new Set(ownedIds)].map(id => `[id="${id.replace(/["\\]/g, '\\$&')}"]`).join(', ')).filter({ visible: true })
              : page.locator(VISIBLE_ATTRIBUTE_MENU);
            await popup.first().waitFor({ state: 'visible', timeout: 1500 });
            // An owned list may mount before its asynchronous options. Do not
            // fall back to a neighbouring field while this list is still empty.
            if (ownedIds.length) await popup.locator('[role="option"], .options-item, .next-select-menu-item')
              .filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 1500 });
            const menu = await attributeMenuForControl(page, field);
            if (!menu) throw unitError(expected, actual, 'ambiguous-menu');
            activeMenu = menu;
            const options = menu.locator('.options-item, [role="option"], .next-select-menu-item, .next-menu-item').filter({ visible: true });
            const matching = async () => (await options.evaluateAll(nodes => nodes.map((node, index) => ({ index, label: node.textContent,
              disabled: node.getAttribute('aria-disabled') === 'true' || /(?:^|\s)(?:next-)?disabled(?:\s|$)/.test(node.className) }))))
              .filter(option => !option.disabled && salesUnitIdentity(option.label) === identity);
            let matches = await matching();
            if (!matches.length) {
              const search = menu.locator('input:not([readonly]):not([disabled]):not([type="hidden"])').filter({ visible: true });
              if (await search.count() === 1) {
                await search.fill(identity, { timeout: 1000 });
                const searchDeadline = Math.min(deadline, performance.now() + 2000);
                do { matches = await matching(); if (matches.length) break; await page.waitForTimeout(100); } while (performance.now() < searchDeadline);
              }
            }
            if (matches.length !== 1) throw unitError(expected, actual, matches.length ? 'ambiguous-option' : 'unavailable-option');
            await clickPostingControl(page, options.nth(matches[0].index), { timeout: 1500 });
          }
          reason = 'not-committed';
          // Wait for the controlled selection before clicking again. Repeated
          // clicks can restart a delayed onChange transaction indefinitely.
          const commitDeadline = Math.min(deadline, performance.now() + 2000);
          while (performance.now() < commitDeadline) {
            const current = await salesUnitControl(page);
            if (current.ambiguous) throw unitError(expected, actual, 'ambiguous-control');
            actual = await committedUnit(current.field);
            if (salesUnitIdentity(actual) === identity) break;
            await page.waitForTimeout(100);
          }
        } catch (error) {
          postingInteractionFailure(error);
          if (error.fieldName === '计量单位' || page.isClosed()) throw error;
          reason = 'replaced-control';
        } finally {
          // A different field may have its own visible popup. Once this
          // selection closed itself, do not try dismissing unrelated menus.
          if (activeMenu && await activeMenu.isVisible().catch(() => false)) await closePostingAttributeMenus(page);
        }
      } else reason = field ? 'disabled-control' : 'missing-control';
    }
    await page.waitForTimeout(100);
  }
  throw unitError(expected, actual, reason);
}
