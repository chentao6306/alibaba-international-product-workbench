function observeReceipt({ token, source, arm = false }) {
  const state = window.__postingReceipt;
  if (!arm && state) return state.token === token && state.read();
  const pattern = new RegExp(source, 'i');
  const visible = node => Boolean(node.getClientRects().length)
    && getComputedStyle(node).visibility !== 'hidden';
  const candidates = () => [...document.querySelectorAll('body *')].filter(node => {
    if (/^(SCRIPT|STYLE|NOSCRIPT)$/.test(node.tagName)) return false;
    const text = node.textContent.trim();
    return text.length < 2000 && pattern.test(text)
      && ![...node.children].some(child => pattern.test(child.textContent));
  });
  // Navigation replaces the document's observer, even when its URL stays the
  // same. Read the new document's visible receipt before accepting that result.
  if (!arm) return candidates().some(visible);
  state?.observer.disconnect();
  const states = new Map(), fresh = new WeakSet();
  const scan = (records = [], baseline = false) => {
    const matching = new Set(candidates());
    // Keep observing old receipt nodes while they display "saving" or are
    // empty, so returning to the same success text is a new receipt.
    for (const node of new Set([...states.keys(), ...matching])) {
      if (!node.isConnected) { states.delete(node); fresh.delete(node); continue; }
      const prior = states.get(node), text = node.textContent, shown = visible(node);
      const message = matching.has(node) ? text.match(pattern)?.[0] || '' : '';
      const textReplaced = prior?.text === text && records.some(record => (
        record.type === 'childList' && record.target === node
          && [...record.addedNodes, ...record.removedNodes].some(part => pattern.test(part.textContent || ''))
      ) || (
        record.type === 'characterData' && node.contains(record.target)
          && pattern.test(record.target.textContent || '')
          && (record.oldValue === record.target.textContent || !pattern.test(record.oldValue || ''))
      ));
      // Changes to surrounding timestamps or other metadata do not refresh
      // the matched success message.
      if (!baseline && message && shown && (!prior || !prior.shown || prior.message !== message || textReplaced)) fresh.add(node);
      if (!message || !shown) fresh.delete(node);
      states.set(node, { text, message, shown });
    }
  };
  scan([], true);
  const observer = new MutationObserver(records => scan(records));
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true,
    attributes: true, attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'] });
  window.__postingReceipt = { token, observer, read: () => {
    scan(observer.takeRecords());
    return candidates().some(node => fresh.has(node) && visible(node));
  } };
}

// A success message is a receipt only if this action created or redisplayed it.
// Keep observation local to the document; never dispatch a second save here.
export function actionReceipt(page, successPattern) {
  const token = `receipt-${Date.now()}-${Math.random()}`;
  let originalUrl = '';
  return {
    async arm() {
      originalUrl = page.url();
      await page.evaluate(observeReceipt, { token, source: successPattern.source, arm: true });
    },
    async accepts(result) {
      if (!result.succeeded) return false;
      if (result.verifiedBy === 'success-url') {
        const current = new URL(page.url()), original = new URL(originalUrl);
        current.hash = ''; original.hash = '';
        if (current.href !== original.href) return true;
      }
      return page.evaluate(observeReceipt, { token, source: successPattern.source }).catch(error => {
        if (/Execution context was destroyed|Cannot find context|navigation/i.test(error.message)) return false;
        throw error;
      });
    },
    async dispose() {
      await page.evaluate(token => {
        if (window.__postingReceipt?.token === token) {
          window.__postingReceipt.observer.disconnect(); delete window.__postingReceipt;
        }
      }, token).catch(() => {});
    },
  };
}
