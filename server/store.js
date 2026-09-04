import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const EMPTY_STATE = {
  version: 2,
  shops: [],
  groups: [],
  products: [],
  jobs: [],
  settings: {
    publishPageUrl: '',
    publishCategory: '',
    publishBindings: {},
    defaultStock: 100,
    priceMarkup: 0,
    publishMode: 'submit'
  }
};

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) this.write(structuredClone(EMPTY_STATE));
  }

  read() {
    return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
  }

  write(state) {
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8');
    let lastError = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        fs.renameSync(temporary, this.filePath);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
    if (lastError) {
      fs.rmSync(temporary, { force: true });
      throw lastError;
    }
    return state;
  }

  update(mutator) {
    const state = this.read();
    const result = mutator(state);
    this.write(state);
    return result ?? state;
  }

  createJob(type, metadata = {}) {
    const now = new Date().toISOString();
    const job = {
      id: randomUUID(), type, status: 'queued', progress: 0, total: 0,
      message: '等待处理', metadata, createdAt: now, updatedAt: now
    };
    this.update((state) => state.jobs.unshift(job));
    return job;
  }

  patchJob(id, patch) {
    return this.update((state) => {
      const job = state.jobs.find((item) => item.id === id);
      if (!job) return null;
      Object.assign(job, patch, { updatedAt: new Date().toISOString() });
      return job;
    });
  }
}

export function newId() {
  return randomUUID();
}

export function deleteWorkspaceEntities(state, selection = {}) {
  const shopIds = new Set(selection.shopIds || []);
  const groupIds = new Set(selection.groupIds || []);
  const productIds = new Set(selection.productIds || []);
  for (const group of state.groups) if (shopIds.has(group.shopId)) groupIds.add(group.id);
  for (const product of state.products) {
    if (shopIds.has(product.shopId) || groupIds.has(product.groupId)) productIds.add(product.id);
  }
  const deleted = {
    shops: state.shops.filter((item) => shopIds.has(item.id)).length,
    groups: state.groups.filter((item) => groupIds.has(item.id)).length,
    products: state.products.filter((item) => productIds.has(item.id)).length
  };
  state.shops = state.shops.filter((item) => !shopIds.has(item.id));
  state.groups = state.groups.filter((item) => !groupIds.has(item.id));
  state.products = state.products.filter((item) => !productIds.has(item.id));
  return { ...deleted, shopIds: [...shopIds], groupIds: [...groupIds], productIds: [...productIds] };
}

export function findWorkspaceJobs(state, targets, statuses = []) {
  const allowedStatuses = new Set(statuses);
  const groupIds = new Set(targets.groupIds || []);
  const productIds = new Set(targets.productIds || []);
  return (state.jobs || []).filter((job) => {
    if (allowedStatuses.size && !allowedStatuses.has(job.status)) return false;
    if (job.type === 'collect') return groupIds.has(job.metadata?.groupId);
    if (job.type === 'publish') return (job.metadata?.productIds || []).some((id) => productIds.has(id));
    return false;
  });
}
