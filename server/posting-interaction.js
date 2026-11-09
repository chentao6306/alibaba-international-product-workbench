const postingInteractions = new WeakMap();

export function configurePostingInteractions(page, options) {
  postingInteractions.set(page, options);
}

export function isUndispatchedPointerError(error) {
  const message = String(error?.message || '');
  return /intercepts pointer events/i.test(message)
    && !/click action done|waiting for scheduled navigations|navigations have finished/i.test(message);
}

// Read the actual hit target after scrolling. A partly covered label/button
// can still have an exposed point; normal Playwright actionability checks
// must validate that point again immediately before dispatch.
function postingTargetState(node) {
  const rect = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  const left = Math.max(rect.left, 0), right = Math.min(rect.right, innerWidth);
  const top = Math.max(rect.top, 0), bottom = Math.min(rect.bottom, innerHeight);
  const describe = (element) => element ? {
    tag: element.tagName.toLowerCase(), id: element.id.slice(0, 100),
    className: String(element.className || '').slice(0, 160), role: element.getAttribute('role') || '',
  } : null;
  const blockers = [];
  let position;
  if (right > left && bottom > top) {
    for (const [xRatio, yRatio] of [[0.5, 0.5], [0.15, 0.5], [0.85, 0.5], [0.5, 0.15], [0.5, 0.85]]) {
      const x = left + (right - left) * xRatio, y = top + (bottom - top) * yRatio;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === node || node.contains(hit))) {
        position ||= { x: x - rect.left - (parseFloat(style.borderLeftWidth) || 0), y: y - rect.top - (parseFloat(style.borderTopWidth) || 0) };
      } else if (hit && !blockers.some((item) => item.id === hit.id && item.className === String(hit.className || '').slice(0, 160))) {
        blockers.push(describe(hit));
      }
    }
  }
  const row = node.closest('.sell-catProp-item, .next-form-item, [id^="p-"]');
  const label = row?.querySelector('.label, .next-form-item-label, legend')?.textContent
    || node.getAttribute('aria-label') || '';
  return { target: { ...describe(node), label: label.replace(/\s+/g, ' ').trim().slice(0, 100) }, blockers, position };
}

export async function clickPostingControl(page, target, { timeout = 4000, recover, beforeRetry, beforeDispatch, confirmResult, confirmationTimeout = 4000, ...clickOptions } = {}) {
  const context = postingInteractions.get(page) || {};
  let state;
  const requireActive = () => {
    if (context.signal?.aborted) throw Object.assign(new Error('已暂停当前商品操作'), { code: 'PUBLISH_PAUSED' });
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    requireActive();
    try {
      // Only actionability trials may be retried. Under load, a timed-out
      // real click can still arrive after an old interception log entry.
      await target.click({ ...clickOptions, ...(state?.position ? { position: state.position } : {}), force: false, trial: true, timeout });
    } catch (error) {
      requireActive();
      const obscured = isUndispatchedPointerError(error);
      // This catch belongs exclusively to trial:true: Playwright may log
      // "performing click action" before its actionability acknowledgement
      // times out, but trial mode suppresses the page click. Retry that phase,
      // never infer the safety of a real-click retry from timeout log text.
      if (!obscured && error?.name !== 'TimeoutError') throw error;
      if (attempt === 2) {
        state = await target.evaluate(postingTargetState, undefined, { timeout: 1000 }).catch(() => state);
        throw Object.assign(new Error('当前商品页面操作尚未完成，已保留进度，可继续任务'), {
          code: obscured ? 'PUBLISH_CONTROL_OBSCURED' : 'PUBLISH_CONTROL_NOT_READY',
          diagnostics: { section: 'posting-interaction', phase: 'trial', attempts: 3, target: state?.target, blockers: state?.blockers || [] },
          cause: error,
        });
      }
      if (!attempt) context.onProgress?.('正在恢复当前页面操作');
      requireActive();
      await beforeRetry?.();
      requireActive();
      await (recover || context.recover)?.(target);
      requireActive();
      await target.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }), undefined, { timeout: 1000 }).catch(() => {});
      state = await target.evaluate(postingTargetState, undefined, { timeout: 1000 }).catch(() => undefined);
      await page.waitForTimeout(150);
      continue;
    }
    requireActive();
    await beforeDispatch?.();
    requireActive();
    try {
      await target.click({ ...clickOptions, ...(state?.position ? { position: state.position } : {}), force: false, trial: false, timeout });
      return;
    } catch (error) {
      requireActive();
      // Only a caller with a specific read-only receipt may recover an
      // uncertain dispatch. Never click again or assume that timeout means
      // failure; generic actions and submit buttons have no default receipt.
      if (confirmResult && (error.name === 'TimeoutError' || /timeout|detached|not attached/i.test(error.message))) {
        const end = Date.now() + confirmationTimeout;
        do {
          requireActive();
          let confirmed = false;
          try { confirmed = await confirmResult(); }
          catch (readError) {
            // The control can be replaced while its receipt is settling.
            // A read timeout is not permission to dispatch a second click.
            if (readError?.code || !/timeout|detached|not attached/i.test(readError?.message || '')) throw readError;
          }
          requireActive();
          if (confirmed) return;
          await page.waitForTimeout(100);
        } while (Date.now() < end);
      }
      // A successful trial does not populate recovery state. Capture the
      // field here so a failed real click still identifies the control.
      if (typeof target.evaluate === 'function') state = await target.evaluate(postingTargetState, undefined, { timeout: 1000 }).catch(() => state);
      throw Object.assign(new Error('当前页面点击结果尚未确认，已保留进度，未重复点击'), {
        code: 'PUBLISH_CONTROL_RESULT_UNKNOWN',
        diagnostics: { section: 'posting-interaction', phase: 'dispatch', target: state?.target }, cause: error,
      });
    }
  }
}

export function postingInteractionFailure(error) {
  if (error?.code === 'PUBLISH_CONTROL_OBSCURED' || error?.code === 'PUBLISH_OVERLAY_BLOCKED'
    || error?.code === 'PUBLISH_CONTROL_RESULT_UNKNOWN'
    || error?.code === 'PUBLISH_POLICY_REVIEW_REQUIRED' || error?.code === 'PUBLISH_PAUSED') throw error;
  // Exhausted actionability trials have not committed a click. Leave them to
  // the field caller's readback so disabled or rejected values stay unmapped.
  return false;
}

export async function choosePostingFile(page, target, { chooserTimeout = 5000, ...clickOptions } = {}) {
  let timer;
  let receive;
  const chosen = new Promise((resolve) => { receive = resolve; });
  page.on('filechooser', receive);
  try {
    // Keep the listener alive throughout click recovery. Start the chooser
    // timeout only after dispatch, so a recovered click cannot lose its event.
    await clickPostingControl(page, target, clickOptions);
    return await Promise.race([chosen, new Promise((resolve) => { timer = setTimeout(() => resolve(null), chooserTimeout); })]);
  } finally {
    clearTimeout(timer);
    page.off('filechooser', receive);
  }
}
