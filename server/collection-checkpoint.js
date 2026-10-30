import fs from 'node:fs';
import path from 'node:path';
import { JsonStore } from './store.js';

// Keep potentially large listing queues out of /api/state polling responses.
export class CollectionCheckpoint {
  constructor(directory, jobId) {
    if (!/^[a-zA-Z0-9-]+$/.test(jobId)) throw new Error('无效采集任务编号');
    this.file = path.join(directory, 'collection-checkpoints', `${jobId}.json`);
  }

  read() {
    if (!fs.existsSync(this.file)) return null;
    try {
      const checkpoint = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (checkpoint.version !== 1 || !['listing', 'detail'].includes(checkpoint.stage)
        || !Array.isArray(checkpoint.products) || !Array.isArray(checkpoint.completedIds)
        || checkpoint.skippedProducts !== undefined && (!Array.isArray(checkpoint.skippedProducts)
          || checkpoint.skippedProducts.some((item) => !item || typeof item.sourceId !== 'string' || typeof item.sourceUrl !== 'string'))
        || !Array.isArray(checkpoint.visited) || !Number.isInteger(checkpoint.page) || checkpoint.page < 0
        || typeof checkpoint.nextUrl !== 'string' || typeof checkpoint.scope !== 'string') throw new Error('Invalid checkpoint');
      return checkpoint;
    } catch (error) {
      throw new Error('采集断点读取失败，已保存的商品不受影响。请保留数据目录以便检查断点文件', { cause: error });
    }
  }

  write(checkpoint) {
    this.store ||= new JsonStore(this.file);
    this.store.write(checkpoint);
  }

  clear() { fs.rmSync(this.file, { force: true }); }
}

export function collectionResumeMessage(checkpoint, fallback = '开始采集，已保存的商品会保留') {
  if (!checkpoint) return fallback;
  return checkpoint.stage === 'detail'
    ? `继续读取详情，已完成 ${checkpoint.completedIds.length + (checkpoint.skippedProducts?.length || 0)}/${checkpoint.products.length} 件${checkpoint.skippedProducts?.length ? `（已跳过 ${checkpoint.skippedProducts.length} 件失效商品）` : ''}`
    : `继续读取第 ${checkpoint.page + 1} 页，已发现 ${checkpoint.products.length} 件`;
}
