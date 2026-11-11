export class ImageDownloadQueue {
  constructor(limit = 3) {
    this.limit = limit;
    this.active = 0;
    this.waiting = [];
    this.pending = new Map();
    this.abortGroups = new Map();
  }

  run(key, action, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.pending.has(key)) return this.pending.get(key);
    let task;
    const promise = new Promise((resolve, reject) => {
      task = { action, resolve, reject, started: false };
      this.waiting.push(task);
    }).finally(() => {
      this.pending.delete(key);
      const group = this.abortGroups.get(signal);
      if (group) {
        group.tasks.delete(task);
        if (!group.tasks.size) {
          signal.removeEventListener('abort', group.abort);
          this.abortGroups.delete(signal);
        }
      }
    });
    if (signal) {
      let group = this.abortGroups.get(signal);
      if (!group) {
        group = { tasks: new Set(), abort: () => {
          const cancelled = new Set([...group.tasks].filter(item => !item.started));
          this.waiting = this.waiting.filter(item => !cancelled.has(item));
          for (const item of cancelled) item.reject(signal.reason);
        } };
        this.abortGroups.set(signal, group);
        signal.addEventListener('abort', group.abort, { once: true });
      }
      group.tasks.add(task);
    }
    this.pending.set(key, promise);
    this.drain();
    return promise;
  }

  drain() {
    while (this.active < this.limit && this.waiting.length) {
      const task = this.waiting.shift();
      task.started = true;
      this.active += 1;
      Promise.resolve().then(task.action).then(task.resolve, task.reject).finally(() => { this.active -= 1; this.drain(); });
    }
  }
}
