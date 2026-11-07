import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();
const paused = () => Object.assign(new Error('采集已暂停，已保存的商品和断点保留'), { code: 'COLLECT_PAUSED' });

export function assertCollectionActive() {
  context.getStore()?.assertActive();
}

// Only pages opened by this collection run may be closed. In particular, a
// simultaneous seller publication or manual source view must remain intact.
export function trackCollectionPage(page) {
  const scope = context.getStore();
  if (!scope) return page;
  scope.pages.add(page);
  try { scope.assertActive(); }
  catch (error) { Promise.resolve().then(() => page.close()).catch(() => {}); throw error; }
  return page;
}

export async function runCollectionControl(options, run, { timeoutMs = 180000, pollMs = 250 } = {}) {
  let failure, finished = false, lastProgress = performance.now(), rejectStop;
  const scope = { pages: new Set(), assertActive() { if (failure || finished) throw failure || paused(); } };
  const guard = callback => (...args) => {
    scope.assertActive();
    lastProgress = performance.now();
    return callback(...args);
  };
  const controlled = { ...options, shouldStop: () => Boolean(failure || finished || options.shouldStop?.()) };
  for (const key of ['onCheckpoint', 'onWaiting']) if (options[key]) controlled[key] = guard(options[key]);
  const stop = error => {
    if (failure || finished) return;
    failure = error;
    // Do not wait indefinitely for an unresponsive renderer to acknowledge
    // close. Late results and checkpoints are fenced by guard below.
    for (const page of scope.pages) Promise.resolve().then(() => page.close()).catch(() => {});
    rejectStop(error);
  };
  const stopped = new Promise((_, reject) => { rejectStop = reject; });
  const timer = setInterval(() => {
    try {
      // A graceful authorization pause stops at the next product boundary.
      // Manual pause still interrupts a blocked page immediately.
      if ((options.shouldInterrupt || options.shouldStop)?.()) return stop(paused());
      if (performance.now() - lastProgress >= timeoutMs) stop(Object.assign(
        new Error(`采集页面连续 ${Math.ceil(timeoutMs / 1000)} 秒没有进展，已暂停并保留已保存商品；可继续或取消任务`),
        { code: 'COLLECT_STALLED' },
      ));
    } catch (error) { stop(error); }
  }, pollMs);
  try {
    if (options.shouldStop?.()) throw paused();
    return await Promise.race([context.run(scope, () => run(controlled, guard)), stopped]);
  } finally {
    finished = true;
    clearInterval(timer);
  }
}

export function recoverCollectionGroups(state) {
  for (const group of state.groups) {
    if (group.status !== 'collecting' && !group.activeJobId) continue;
    const active = state.jobs.find(job => job.type === 'collect' && job.metadata?.groupId === group.id
      && ['queued', 'running', 'pause_requested'].includes(job.status));
    if (active) { group.status = 'collecting'; group.activeJobId = active.id; }
    else { group.status = 'ready'; group.activeJobId = ''; }
  }
}
