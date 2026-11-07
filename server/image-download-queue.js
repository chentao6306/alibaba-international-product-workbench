export class ImageDownloadQueue {
  constructor(limit = 3) {
    this.limit = limit;
    this.active = 0;
    this.waiting = [];
    this.pending = new Map();
  }

  run(key, action) {
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = new Promise((resolve, reject) => {
      this.waiting.push({ action, resolve, reject });
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    this.drain();
    return promise;
  }

  drain() {
    while (this.active < this.limit && this.waiting.length) {
      const task = this.waiting.shift();
      this.active += 1;
      Promise.resolve().then(task.action).then(task.resolve, task.reject).finally(() => { this.active -= 1; this.drain(); });
    }
  }
}
