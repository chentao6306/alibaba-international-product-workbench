import fs from 'node:fs';
import path from 'node:path';

export class AnnouncementInbox {
  constructor(file, baseUrl, account = 'local') {
    this.file = file;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.account = account;
    this.items = [];
    this.lastFetched = 0;
    this.pending = null;
  }

  readState() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }

  async list({ refresh = false } = {}) {
    const account = this.account;
    if (refresh || !this.lastFetched || Date.now() - this.lastFetched > 30000) {
      if (!this.pending) this.pending = (async () => {
        const response = await fetch(`${this.baseUrl}/api/announcements`, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('公告暂时无法加载，请稍后重试');
        const items = await response.json();
        if (!Array.isArray(items)) throw new Error('公告数据格式异常');
        const valid = items.every((item) => item && typeof item.id === 'string' && Number.isInteger(item.revision) && typeof item.title === 'string' && typeof item.content === 'string');
        if (!valid) throw new Error('公告数据格式异常');
        this.items = items;
        const ids = new Set(items.map((item) => item.id));
        const state = this.readState();
        let changed = false;
        for (const reads of Object.values(state)) {
          for (const id of Object.keys(reads)) if (!ids.has(id)) { delete reads[id]; changed = true; }
        }
        if (changed) this.writeState(state);
        this.lastFetched = Date.now();
      })().finally(() => { this.pending = null; });
      await this.pending;
    }
    const reads = this.readState()[account] || {};
    return this.items.map((item) => ({ ...item, read: reads[item.id] === item.revision }));
  }

  markRead(id, revision) {
    const item = this.items.find((entry) => entry.id === id && entry.revision === revision);
    if (!item) throw Object.assign(new Error('公告已更新，请刷新后重新阅读'), { status: 409 });
    const state = this.readState();
    state[this.account] = { ...(state[this.account] || {}), [id]: revision };
    this.writeState(state);
    return { ok: true };
  }

  writeState(state) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state));
    fs.renameSync(temporary, this.file);
  }
}
