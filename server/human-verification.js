import { AsyncLocalStorage } from 'node:async_hooks';

const verificationContext = new AsyncLocalStorage();
export const withVerificationContext = (options, run) => verificationContext.run(options, run);
export const verificationOptions = () => verificationContext.getStore() || {};
export const verificationPaused = () => Object.assign(new Error('人工验证等待已暂停，已保存的数据保留，可继续任务'), { code: 'COLLECT_PAUSED' });

export function verificationUrlAllowed(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && /(^|\.)(?:alibaba\.com|1688\.com|aliexpress\.com|alicdn\.com|made-in-china\.com)$/.test(url.hostname);
  } catch { return false; }
}

// This function is serialized into either Chromium or an Electron web view.
export function inspectVerificationDocument() {
  const visible = (node) => {
    for (let parent = node; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2 && rect.right > 0 && rect.bottom > 0
      && rect.left < innerWidth && rect.top < innerHeight;
  };
  const body = document.body?.innerText || '';
  const prompt = /请完成验证|请拖动(?:下方)?滑块|请按住滑块|拖动下方滑块完成验证|滑动验证|滑块验证|人机验证|安全验证|安全校验|security verification|slide to verify|drag (?:the )?slider to verify|verify you are human|complete (?:the )?captcha|CAPTCHA Verification|unusual traffic/i;
  // innerText includes opacity-zero/offscreen elements. Only an actually
  // visible prompt or rendered challenge control can request a user window.
  const visibleTextMatches = (pattern) => {
    if (!pattern.test(body)) return false;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const parent = text.parentElement;
      if (parent && !/^(SCRIPT|STYLE|NOSCRIPT)$/.test(parent.tagName) && pattern.test(text.textContent) && visible(parent)) return true;
    }
    return false;
  };
  const challengeText = visibleTextMatches(prompt);
  const challengeElement = [...document.querySelectorAll('.nc_scale, #nc_1_n1z, #nc_2_n1z, .nc-container .errloading, .nc-container .nc-lang-cnt')].some(visible)
    || [...document.querySelectorAll('iframe[src]')].some((frame) => {
      const rect = frame.getBoundingClientRect();
      return /captcha|nocaptcha|punish|baxia|\/verify(?:[/.?]|$)|\/verification(?:[/.?]|$)/i.test(frame.getAttribute('src'))
        && rect.width >= 40 && rect.height >= 20 && visible(frame);
    });
  const challengeUrl = /^\/(?:_____tmd_____\/)?(?:punish|captcha|nocaptcha|x5sec|verification|verify)(?:[/.]|$)/i.test(location.pathname);
  const login = /(?:^|[./])(login|passport|signin|sign-in)(?:[./]|$)/i.test(location.hostname + location.pathname);
  const error = /chrome-error:|chromewebdata/i.test(location.href)
    || visibleTextMatches(/请点我重试|验证失败|验证超时|验证已过期|刷新后重试|verification failed|captcha expired|please try again|ERR_(?:CONNECTION|INTERNET|TIMED_OUT|NETWORK)/i);
  const normalContent = Boolean(document.querySelector('[module-data], [data-module-name], [data-testid="module-attribute-row"], input[name="productTitle"]'));
  const verificationError = /请点我重试|验证失败|验证超时|验证已过期|verification failed|captcha expired/i;
  const expired = [...document.querySelectorAll('.nc-container, [id*="captcha" i], [class*="captcha" i]')]
    .some((node) => visible(node) && verificationError.test(node.innerText || ''));
  const challenge = challengeElement || challengeText || expired;
  const pending = challengeUrl && !normalContent;
  const ready = document.readyState !== 'loading' && /^https?:$/.test(location.protocol)
    && !challenge && !pending && !login && !error && (normalContent || body.trim().length > 100);
  return { challenge, pending, ready, error, url: location.href };
}

export async function waitForVerification({ inspect, shouldStop = () => false, isClosed = () => false,
  onWaiting = () => {}, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), pollMs = 1000 }) {
  let stable = 0;
  let previousUrl = '';
  for (;;) {
    if (shouldStop() || isClosed()) throw verificationPaused();
    // A stalled renderer must not prevent cancellation or stop job heartbeats.
    let outcome;
    const reading = Promise.resolve().then(inspect).then(
      (state) => { outcome = { state }; }, (error) => { outcome = { error }; }
    );
    while (!outcome) {
      await Promise.race([reading, sleep(pollMs)]);
      if (shouldStop() || isClosed()) throw verificationPaused();
      if (!outcome) onWaiting('等待人工验证，已保存的采集进度保留');
    }
    if (['COLLECT_PAUSED', 'PUBLISH_PAUSED', 'HUMAN_VERIFICATION_REQUIRED', 'VERIFICATION_PAGE_UNAVAILABLE', 'VERIFICATION_RECHECK_REQUIRED'].includes(outcome.error?.code)) throw outcome.error;
    const state = outcome.state || { ready: false, error: true };
    if (shouldStop() || isClosed()) throw verificationPaused();
    stable = state.ready ? (state.url === previousUrl ? stable + 1 : 1) : 0;
    previousUrl = state.url;
    if (stable >= 2) return state;
    onWaiting(state.error ? '验证页面出错，等待刷新后完成验证' : '等待人工验证，已保存的采集进度保留');
    await sleep(pollMs);
  }
}
