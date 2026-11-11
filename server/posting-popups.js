// Fusion select portals do not always carry next-select-popup or listbox.
// Match select contents as well as containers, never a generic navigation menu.
export const ATTRIBUTE_MENU = '.sell-o-select-options, .next-select-popup, [role="listbox"], .next-menu:has(.next-select-menu-item), .next-menu:has([role="option"]), [role="menu"]:has([role="option"]), .next-overlay-inner:not(:has(.next-dialog)):not(:has([aria-modal="true"])):not([role="dialog"]):has(.next-select-menu-item)';
export const VISIBLE_ATTRIBUTE_MENU = ATTRIBUTE_MENU.split(', ').map((selector) => `${selector}:visible`).join(', ');
// Keyword recommendations use menuitem, not option. They must be dismissed
// between fields, but must never participate in attribute option matching.
const INPUT_MENU = `${ATTRIBUTE_MENU}, .posting-field-keywords-overlay`;
const VISIBLE_INPUT_MENU = INPUT_MENU.split(', ').map((selector) => `${selector}:visible`).join(', ');
// Custom-name recommendations use generic Fusion menuitems. The observed
// portal includes a usage-rate caption (for example "3% 人填写"); require it
// as well as the suggestion layout so action/navigation menus stay untouched.
// These suggestions are dismissible input UI, never attribute-choice options.
const CUSTOM_NAME_MENU = '.next-overlay-wrapper.opened .next-menu:not(nav):not(nav *):not([role="navigation"] *):not(:has(a,button,[role="button"])):has(.next-menu-item.item[role="menuitem"] .text)';
const CUSTOM_NAME_RATE = /\d+(?:\.\d+)?%\s*人填写/;
const BACKGROUND_EXCLUDED_MENU = `${INPUT_MENU}, ${CUSTOM_NAME_MENU}`;
function inputMenus(page) {
  return page.locator(VISIBLE_INPUT_MENU).or(page.locator(`${CUSTOM_NAME_MENU}:visible`).filter({ hasText: CUSTOM_NAME_RATE }));
}
export const POSTING_DIALOG = '[role="dialog"]:not(.mce-tinymce-inline:not([aria-modal="true"]):has([role="toolbar"]))';
const MODAL = '.next-dialog, [aria-modal="true"], .product-attr-dialog, .mce-window';

export async function attributeMenuForControl(page, control) {
  const menus = page.locator(VISIBLE_ATTRIBUTE_MENU);
  const ids = await control.evaluate((node) => [...new Set([node, node.closest('.next-select')].filter(Boolean)
    .flatMap((element) => [element.getAttribute('aria-controls'), element.getAttribute('aria-owns')])
    .filter(Boolean).flatMap((value) => value.split(/\s+/)))]).catch(() => []);
  for (const id of ids) {
    const owned = page.locator(`[id="${id.replace(/["\\]/g, '\\$&')}"]`);
    if (await owned.count() === 1 && await owned.isVisible()
      && await owned.locator('[role="option"], .options-item, .next-select-menu-item').count()) {
      const root = await menus.evaluateAll((nodes, id) => {
        const owned = document.getElementById(id);
        // Include a portal's search box only when all its options belong to
        // the controlled list. Do not widen into a neighbouring field's list.
        return nodes.findIndex((node) => node.contains(owned)
          && [...node.querySelectorAll('[role="option"], .options-item, .next-select-menu-item')].every((option) => owned.contains(option)));
      }, id);
      return root >= 0 ? menus.nth(root) : owned;
    }
  }
  const roots = await menus.evaluateAll((nodes) => nodes.map((node, index) => ({ node, index }))
    .filter(({ node }) => !nodes.some((other) => other !== node && other.contains(node))).map(({ index }) => index));
  // Without an ownership link, two independent menus are ambiguous. Never
  // choose an option from another field merely because its text matches.
  return roots.length === 1 ? menus.nth(roots[0]) : null;
}

export async function targetPopupContext(target) {
  return target.evaluate((node, selectors) => ({
    inMenu: Boolean(node.closest(selectors.menu)
      || new RegExp(selectors.customRate).test(node.closest(selectors.customMenu)?.textContent || '')),
    inDialog: Boolean(node.closest(selectors.modal) || node.closest(selectors.dialog)),
  }), { menu: INPUT_MENU, customMenu: CUSTOM_NAME_MENU, customRate: CUSTOM_NAME_RATE.source, modal: MODAL, dialog: POSTING_DIALOG }, { timeout: 1000 })
    .catch(() => ({ inMenu: false, inDialog: false }));
}

// Close committed menus by real click-away/blur actions. When operating inside
// a dialog, stay inside that dialog and do not send Escape to its parent.
export async function closePostingAttributeMenus(page, target) {
  const menus = inputMenus(page);
  if (!await menus.count()) return true;
  const handle = target ? await target.elementHandle({ timeout: 1000 }).catch(() => null) : null;
  const menuHandles = await menus.elementHandles();
  try {
    const state = await page.evaluate(({ menuNodes, modalSelector, dialogSelector, targetNode }) => {
      const visible = (node) => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
      const menus = menuNodes.filter(visible);
      const dialogs = [...document.querySelectorAll(`${modalSelector}, ${dialogSelector}`)]
        .filter((node) => visible(node) && (node.matches(modalSelector) || !menus.some(menu => menu.contains(node))));
      const dialog = targetNode?.closest(`${modalSelector}, ${dialogSelector}`);
      const inMenu = targetNode && menus.some(menu => menu.contains(targetNode));
      return { blocked: Boolean(inMenu) || dialogs.some((node) => !dialog || !(node === dialog || node.contains(dialog) || dialog.contains(node))),
        inDialog: Boolean(dialog), hasMenus: menus.length > 0 };
    }, { menuNodes: menuHandles, modalSelector: MODAL, dialogSelector: POSTING_DIALOG, targetNode: handle });
    if (!state.hasMenus) return true;
    if (state.blocked) return false;
    if (!state.inDialog) {
      await page.keyboard.press('Escape');
      if (!await menus.count()) return true;
      await page.keyboard.press('Tab');
      if (!await menus.count()) return true;
    }
    const labels = page.locator('.sell-catProp-item > .label:visible, .sell-catProp-item label:visible, .next-form-item-label:visible, #desc-card-title:visible, h2:visible, h3:visible');
    for (let index = 0; index < Math.min(await labels.count(), 24); index++) {
      const label = labels.nth(index);
      const point = await label.evaluate((node, { menuSelector, dialogSelector, targetNode }) => {
        if (node.closest(`${menuSelector}, button, a, label[for], [role="button"], [onclick]`)
          || node.querySelector('input, button, select, a, textarea')) return null;
        const dialog = targetNode?.closest(dialogSelector);
        if (dialog && !dialog.contains(node)) return null;
        const rect = node.getBoundingClientRect();
        const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return hit && (hit === node || node.contains(hit)) ? { x, y } : null;
      }, { menuSelector: BACKGROUND_EXCLUDED_MENU, dialogSelector: `${MODAL}, ${POSTING_DIALOG}`, targetNode: handle }).catch(() => null);
      if (!point) continue;
      await page.mouse.click(point.x, point.y);
      if (await menus.first().waitFor({ state: 'hidden', timeout: 300 }).then(() => true, () => false) && !await menus.count()) return true;
    }
    const point = await page.evaluate(({ menuSelector, dialogSelector, targetNode }) => {
      const dialog = targetNode?.closest(dialogSelector);
      const safeBackground = 'body, main, section, .next-form, .next-form-item, .sell-catProp-item, #struct-desc-card, #desc-card, .next-dialog-body, .next-dialog-header';
      const rect = dialog?.getBoundingClientRect() || { left: 0, top: 0, width: innerWidth, height: innerHeight };
      for (const yRatio of [0.03, 0.33, 0.5, 0.8, 0.97]) {
        for (const xRatio of [0.03, 0.25, 0.5, 0.97]) {
          const x = rect.left + rect.width * xRatio, y = rect.top + rect.height * yRatio;
          const node = document.elementFromPoint(x, y);
          if (!node?.matches(safeBackground) || (dialog && !dialog.contains(node))) continue;
          if (node.closest(`${menuSelector}, button, a, label, [role="button"], [onclick], .next-overlay-backdrop`)) continue;
          if (!dialog && node.closest(dialogSelector)) continue;
          return { x, y };
        }
      }
      return null;
    }, { menuSelector: BACKGROUND_EXCLUDED_MENU, dialogSelector: `${MODAL}, ${POSTING_DIALOG}`, targetNode: handle });
    if (point) {
      await page.mouse.click(point.x, point.y);
      await menus.first().waitFor({ state: 'hidden', timeout: 700 }).catch(() => {});
    }
    return !await menus.count();
  } finally {
    await handle?.dispose();
    await Promise.all(menuHandles.map(menu => menu.dispose()));
  }
}
