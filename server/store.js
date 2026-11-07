import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { storageError } from './storage-error.js';
import { readWorkspace } from './workspace-reader.js';
import { cloneWorkspaceValue } from './workspace-clone.js';

const EMPTY_STATE = {
  version: 2,
  shops: [],
  groups: [],
  collectionFolders: [],
  products: [],
  jobs: [],
  settings: {
    publishPageUrl: '',
    publishCategory: '',
    publishBindings: {},
    defaultStock: 100,
    stockPolicy: 'minimum-order',
    listingMode: 'auto',
    publishDelayMinSeconds: 0,
    publishDelayMaxSeconds: 0,
    priceMarkup: 0,
    publishMode: 'submit',
    allowPolicyWarningPublish: false,
    autoRemovePublishedProducts: false,
    uploadProductVideos: true,
    autoGenerateSubtitle: false,
    autoGenerateKeywords: false,
  }
};

// Bound serialization memory to one top-level array item. Long descriptions,
// source snapshots and edit history must not become one giant JSON string.
function* stateChunks(state) {
  yield '{';
  let first = true;
  for (const [key, value] of Object.entries(state)) {
    if (value === undefined) continue;
    yield `${first ? '' : ','}${JSON.stringify(key)}:`;
    first = false;
    if (Array.isArray(value)) {
      yield '[';
      for (let index = 0; index < value.length; index++) {
        yield `${index ? ',' : ''}${JSON.stringify(value[index]) ?? 'null'}`;
      }
      yield ']';
    } else yield JSON.stringify(value);
  }
  yield '}';
}

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) this.write(cloneWorkspaceValue(EMPTY_STATE));
  }

  revision() {
    const stat = fs.statSync(this.filePath, { bigint: true });
    // Atomic replacement can have identical timestamps and byte length on
    // Windows. Include file identity so pause/control changes invalidate caches.
    return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
  }

  snapshot() {
    const revision = this.revision();
    if (!this.cachedState || this.cachedRevision !== revision) {
      this.cachedState = readWorkspace(this.filePath);
      this.cachedRevision = revision;
    }
    return this.cachedState;
  }

  read(select = (state) => state) {
    return cloneWorkspaceValue(select(this.snapshot()));
  }

  write(state) {
    return this.#commit(state, false);
  }

  #commit(state, owned) {
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    // Public write callers may retain mutable references. Prepare the detached
    // cache before replacing the durable file, never after the commit.
    const cachedState = owned ? state : cloneWorkspaceValue(state);
    let descriptor;
    try {
      const disk = fs.statfsSync(path.dirname(this.filePath));
      const available = disk.bavail * disk.bsize;
      const reserve = 64 * 1024 * 1024;
      if (available < reserve) {
        throw Object.assign(new Error('Insufficient workspace storage'), { code: 'ENOSPC' });
      }
      fs.writeFileSync(temporary, '', { flag: 'wx', encoding: 'utf8' });
      descriptor = fs.openSync(temporary, 'a');
      // Serialize once, keeping the same free-space margin as the former
      // sizing pass. A failed write only removes this temporary snapshot.
      let bytes = 0, pendingBytes = 0, pending = [];
      for (const chunk of stateChunks(cachedState)) {
        const chunkBytes = Buffer.byteLength(chunk);
        bytes += chunkBytes;
        if (available < bytes * 2 + reserve) throw Object.assign(new Error('Insufficient workspace storage'), { code: 'ENOSPC' });
        pending.push(chunk); pendingBytes += chunkBytes;
        if (pendingBytes >= 256 * 1024) {
          fs.writeFileSync(descriptor, pending.join(''), 'utf8');
          pending = []; pendingBytes = 0;
        }
      }
      if (pending.length) fs.writeFileSync(descriptor, pending.join(''), 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
    } catch (error) {
      if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
      // Never leave partial snapshots behind or replace the last durable file.
      try { fs.rmSync(temporary, { force: true }); } catch {}
      throw storageError(error, this.filePath);
    }
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
      try { fs.rmSync(temporary, { force: true }); } catch {}
      throw storageError(lastError, this.filePath);
    }
    this.cachedState = cachedState;
    this.cachedRevision = this.revision();
    return state;
  }

  update(mutator) {
    const state = this.read();
    const result = mutator(state);
    this.write(state);
    return result ?? state;
  }

  updateProducts(ids, mutator) {
    const selected = new Set(ids);
    const snapshot = this.snapshot();
    // The callback only receives selected products. Unrelated products and
    // their immutable captures/history are reused, not cloned on every batch.
    const products = snapshot.products.filter(product => selected.has(product.id)).map(product => cloneWorkspaceValue(product));
    const result = mutator(products);
    if (result?.then) throw new Error('商品保存回调必须同步完成');
    const detachedResult = cloneWorkspaceValue(result);
    const updates = new Map(products.map(product => [product.id, cloneWorkspaceValue(product)]));
    const state = { ...snapshot, products: snapshot.products.map(product => updates.get(product.id) || product) };
    this.#commit(state, true);
    return detachedResult;
  }

  createJob(type, metadata = {}) {
    const now = new Date().toISOString();
    const job = {
      id: randomUUID(), type, status: 'queued', progress: 0, total: 0,
      message: '等待处理', metadata: cloneWorkspaceValue(metadata), createdAt: now, updatedAt: now
    };
    const snapshot = this.snapshot();
    this.#commit({ ...snapshot, jobs: [job, ...snapshot.jobs] }, true);
    return cloneWorkspaceValue(job);
  }

  patchJob(id, patch) {
    const snapshot = this.snapshot();
    const index = snapshot.jobs.findIndex((item) => item.id === id);
    if (index < 0) return null;
    // Progress must not clone every product, source capture and historical
    // task. Detach caller-owned patches while retaining unchanged containers.
    const job = { ...snapshot.jobs[index], ...cloneWorkspaceValue(patch), updatedAt: new Date().toISOString() };
    const jobs = snapshot.jobs.slice();
    jobs[index] = job;
    const state = { ...snapshot, jobs };
    // Stage text is transient. Item results, checkpoints and control changes
    // still use the atomic durable write below.
    if (Object.keys(patch).every((key) => key === 'message')) {
      this.cachedState = state;
    } else {
      this.#commit(state, true);
    }
    return cloneWorkspaceValue(job);
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
