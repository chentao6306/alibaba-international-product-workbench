import { readAlibabaAttributeRows } from './category-attributes.js';

const SECTIONS = '[data-testid="module-attribute-group"], [data-module-name*="attribute" i], [data-module-name*="specification" i], [data-module-name*="packaging" i], [data-module-name*="productPackInfo" i], [class*="product-attribute" i]';
const EXCLUDED = '[data-module-name*="recommend" i], [data-module-name*="related" i], [data-module-name*="similar" i], [class*="recommend" i]';

// Complete each source section in the existing page. Reloading a page to retry
// lazy attributes resets the very scroll/intersection state that revealed them.
export async function collectSourceAttributeSections(page, { timeoutMs = 7000, verify, shouldStop = () => false } = {}) {
  const deadline = performance.now() + timeoutMs;
  const opened = new Set();
  let previous = '', stableSince = performance.now(), changedAt = stableSince;
  let attributes = [], sectionCount = 0, loading = 0;
  do {
    if (shouldStop()) throw Object.assign(new Error('采集已暂停，已保留进度'), { code: 'COLLECT_PAUSED' });
    const scopes = page.locator(SECTIONS).filter({ hasNot: page.locator(EXCLUDED) });
    sectionCount = await scopes.count();
    for (let index = 0; index < Math.min(sectionCount, 24); index++) {
      if (performance.now() >= deadline) break;
      const scope = scopes.nth(index);
      if (await scope.evaluate((node, excluded) => Boolean(node.closest(excluded)), EXCLUDED).catch(() => true)) continue;
      if (!opened.has(index)) {
        await scope.scrollIntoViewIfNeeded({ timeout: 500 }).catch(() => {});
        opened.add(index);
        changedAt = performance.now();
      }
      const expand = scope.getByRole('button', { name: /^(?:Show (?:all|more)(?: attributes)?|View (?:all|more)(?: attributes)?|See (?:all|more)(?: attributes)?|展开(?:全部|更多)?|查看更多|查看全部)$/i }).first();
      if (await expand.isVisible().catch(() => false) && await expand.getAttribute('aria-expanded') !== 'true' && !opened.has(`expand-${index}`)) {
        opened.add(`expand-${index}`);
        await expand.click({ timeout: 600 }).catch(() => {});
        changedAt = performance.now();
      }
    }
    attributes = await page.evaluate(readAlibabaAttributeRows);
    const signature = JSON.stringify(attributes);
    if (signature !== previous) { previous = signature; stableSince = performance.now(); }
    loading = await scopes.locator('[aria-busy="true"], .next-loading:visible, [role="progressbar"]:visible').count();
    loading += await scopes.evaluateAll((nodes) => nodes.filter((node) => node.getAttribute('aria-busy') === 'true').length);
    if (attributes.length && !loading && performance.now() - Math.max(stableSince, changedAt) >= 1200) break;
    if (!sectionCount && !attributes.length) {
      await page.evaluate(() => window.scrollBy(0, Math.max(500, innerHeight * 0.8))).catch(() => {});
    }
    await page.waitForTimeout(200);
  } while (performance.now() < deadline);
  await verify?.();
  return { attributes, evidence: { sections: sectionCount, attributeRows: attributes.length,
    settled: attributes.length > 0 && !loading && sectionCount <= 24 && performance.now() - Math.max(stableSince, changedAt) >= 1200,
    checkedAt: new Date().toISOString() } };
}
