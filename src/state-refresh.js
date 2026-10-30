// Polls may share an in-flight read. A read requested after a successful write
// must start after that write, otherwise an older poll can restore stale state.
export function createStateRefresher(read) {
  let active = null, queued = null;
  function start() {
    const request = Promise.resolve().then(read).finally(() => { if (active === request) active = null; });
    active = request;
    return request;
  }
  return function refresh(options) {
    if (!active) return start();
    if (options?.fresh === false) return active;
    if (!queued) queued = active.catch(() => {}).then(() => { queued = null; return start(); });
    return queued;
  };
}
