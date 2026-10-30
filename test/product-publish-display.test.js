import test from 'node:test';
import assert from 'node:assert/strict';
import { productPublishDisplay, publishCounts, publishJobMessage } from '../server/publish-progress.js';

test('shows the current paused upload reason over an old product failure without rewriting its receipt', () => {
  const product = { id: 'phone', title: 'S25 Ultra', status: 'publish_failed', publishResult: { status: 'failed', message: '国际站页面仍有弹窗遮罩，请关闭提示后重试' } };
  const original = structuredClone(product);
  const job = { id: 'retry', type: 'publish', status: 'paused', currentProductId: 'phone', progress: 1, total: 3,
    metadata: { productIds: ['done', 'phone', 'next'] }, results: { done: { status: 'published' } },
    message: '已暂停：S25 Ultra - 详情图片上传失败：图片银行空间不足。处理后可继续' };
  assert.deepEqual(productPublishDisplay(product, [job]), { status: 'publish_paused', message: '详情图片上传失败：图片银行空间不足。处理后可继续', jobId: 'retry' });
  const next = { ...product, id: 'next' };
  assert.equal(productPublishDisplay(next, [job]).status, 'publish_queued');
  assert.equal(productPublishDisplay(next, [job]).message, '任务已暂停，此商品尚未处理');
  assert.deepEqual(productPublishDisplay({ id: 'done', status: 'published' }, [job]), { status: 'published', message: '' });
  assert.deepEqual(publishCounts(job), { success: 1, failed: 0, skipped: 0, remaining: 2 });
  assert.deepEqual(product, original);

  job.status = 'running'; job.message = '正在处理 2/3：S25 Ultra - 上传详情图片 3/8';
  assert.deepEqual(productPublishDisplay(product, [job]), { status: 'publishing', message: '正在上架', jobId: 'retry' });
  job.status = 'pause_requested';
  assert.equal(productPublishDisplay(product, [job]).status, 'publish_pausing');
  delete job.currentProductId; job.status = 'paused'; job.message = '服务重启，任务已暂停';
  assert.equal(productPublishDisplay(product, [job]).status, 'publish_paused');
  assert.equal(productPublishDisplay(product, [job]).message, job.message);
  for (const status of ['completed', 'cancelled', 'failed']) {
    job.status = status;
    assert.deepEqual(productPublishDisplay(product, [job]), { status: product.status, message: product.publishResult.message });
  }
});

test('keeps internal publishing stages out of progress displays without changing diagnostics or outcomes', () => {
  const stages = ['填写类目属性：类型', '填写类目属性：输出', '上传详情图片 3/8', '自动修复第 1 次：复核规格值和全部规格图片'];
  for (const stage of stages) {
    const job = { type: 'publish', status: 'running', message: stage, progress: 2, total: 5 };
    assert.equal(publishJobMessage(job), '正在上架');
    assert.equal(publishJobMessage({ ...job, metadata: { mode: 'draft' } }), '正在保存草稿');
    assert.equal(publishJobMessage({ ...job, status: 'pause_requested' }), '正在暂停');
    assert.equal(job.message, stage);
    assert.equal(job.progress, 2);
  }
  for (const status of ['failed', 'paused', 'completed']) {
    assert.equal(publishJobMessage({ type: 'publish', status, message: '需要处理的原因或完成结果' }), '需要处理的原因或完成结果');
  }
  assert.equal(publishJobMessage({ type: 'collect', status: 'running', message: '正在采集第 2 页' }), '正在采集第 2 页');
});

test('does not replace completed products, collection jobs or unrelated failures with active publish state', () => {
  const product = { id: 'p', status: 'publish_failed', publishResult: { message: 'Current validation failure' } };
  const base = { type: 'publish', status: 'paused', progress: 0, metadata: { productIds: ['p'] } };
  for (const job of [{ ...base, type: 'collect' }, { ...base, progress: 1 }, { ...base, results: { p: { status: 'failed' } } }, { ...base, metadata: { productIds: ['another'] } }]) {
    assert.deepEqual(productPublishDisplay(product, [job]), { status: product.status, message: product.publishResult.message });
  }
  assert.equal(productPublishDisplay(product, [{ ...base, status: 'queued' }]).status, 'publish_queued');
  const older = { ...base, id: 'old', createdAt: '2026-09-18', message: 'Old pause' };
  const newer = { ...base, id: 'new', createdAt: '2026-09-19', message: 'New pause' };
  assert.equal(productPublishDisplay(product, [older, newer]).message, 'New pause');
});

test('shows an actionable verification wait instead of a frozen draft counter without exposing internal stages', () => {
  const job = { type: 'publish', status: 'running', metadata: { mode: 'draft', productIds: ['1', '2', '3'] },
    progress: 2, total: 6, currentProductId: '3', verificationState: 'waiting',
    results: { 1: { status: 'drafted' }, 2: { status: 'drafted' } }, message: 'Internal verification details' };
  assert.match(publishJobMessage(job), /等待人工验证/);
  assert.match(productPublishDisplay({ id: '3' }, [job]).message, /验证窗口/);
  assert.deepEqual(publishCounts(job), { success: 2, failed: 0, skipped: 0, remaining: 4 });
  assert.match(publishJobMessage({ ...job, verificationState: 'error' }), /刷新并完成验证/);
  assert.equal(publishJobMessage({ ...job, verificationState: '' }), '正在保存草稿');
  assert.equal(publishJobMessage({ ...job, status: 'pause_requested' }), '正在暂停');
  assert.equal(publishJobMessage({ ...job, status: 'completed', message: 'Completed' }), 'Completed');
  assert.equal(publishJobMessage({ ...job, verificationState: '', message: 'Product title contains 等待人工验证' }), '正在保存草稿');
});
