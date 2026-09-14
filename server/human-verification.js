import { AsyncLocalStorage } from 'node:async_hooks';

const verificationContext = new AsyncLocalStorage();
export const withVerificationContext = (options, run) => verificationContext.run(options, run);
export const verificationOptions = () => verificationContext.getStore() || {};
export const verificationPaused = () => Object.assign(new Error('人工验证等待已暂停，已保存的数据保留，可继续任务'), { code: 'COLLECT_PAUSED' });

// This function is serialized into either Chromium or an Electron web view.
export function inspectVerificationDocument() {
  const visible = (node) => {
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && Boolean(node.getClientRects().length);
  };
  const selectors = 'iframe[src*="captcha" i],iframe[src*="verify" i],[id*="captcha" i],[class*="captcha" i],.nc-container,#nc_1_n1z,[class*="baxia" i],[class*="challenge" i]';
  const challengeElement = [...document.querySelectorAll(selectors)].some(visible);
  const body = document.body?.innerText || '';
  const challengeText = /请完成验证|请拖动(?:下方)?滑块|请按住滑块|拖动下方滑块完成验证|滑动验证|滑块验证|人机验证|安全验证|安全校验|security verification|slide to verify|drag (?:the )?slider to verify|verify you are human|complete (?:the )?captcha|CAPTCHA Verification|unusual traffic/i.test(body);
  const challengeUrl = /(?:punish|captcha|nocaptcha|x5sec|verification)/i.test(location.pathname);
  const login = /(?:^|[./])(login|passport|signin|sign-in)(?:[./]|$)/i.test(location.hostname + location.pathname);
  const error = /chrome-error:|chromewebdata/i.test(location.href)
    || /请点我重试|验证失败|验证超时|验证已过期|刷新后重试|verification failed|captcha expired|please try again|ERR_(?:CONNECTION|INTERNET|TIMED_OUT|NETWORK)/i.test(body);
  const normalContent = Boolean(document.querySelector('[module-data], [data-module-name], [data-testid="module-attribute-row"], input[name="productTitle"]'));
  const challenge = challengeElement || challengeText || (challengeUrl && !normalContent);
  const ready = document.readyState !== 'loading' && /^https?:$/.test(location.protocol)
    && !challenge && !login && !error && (normalContent || body.trim().length > 100);
  return { challenge, ready, error, url: location.href };
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
    if (['COLLECT_PAUSED', 'PUBLISH_PAUSED', 'HUMAN_VERIFICATION_REQUIRED'].includes(outcome.error?.code)) throw outcome.error;
    const state = outcome.state || { ready: false, error: true };
    if (shouldStop() || isClosed()) throw verificationPaused();
    stable = state.ready ? (state.url === previousUrl ? stable + 1 : 1) : 0;
    previousUrl = state.url;
    if (stable >= 2) return state;
    onWaiting(state.error ? '验证页面出错，等待刷新后完成验证' : '等待人工验证，已保存的采集进度保留');
    await sleep(pollMs);
  }
}
