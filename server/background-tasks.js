import { isStorageError } from './storage-error.js';
import { userFacingError } from './browser-error.js';

// A second failed write while reporting a job failure must not reject an
// unobserved promise and terminate the worker which also serves the UI.
export function createBackgroundTasks({ onStop = () => {} } = {}) {
  let failure = null;
  const stopped = new Set();
  return {
    async run(jobId, action) {
      if (failure) { stopped.add(jobId); return; }
      try { await action(); }
      catch (error) {
        stopped.add(jobId);
        failure ||= {
          status: 'error', code: error.code || 'BACKGROUND_TASK_FAILED',
          message: `任务已停止：${userFacingError(error)}。最近一次操作可能未保存；继续上架前，请先到国际站核对当前商品的发布结果。`,
          at: new Date().toISOString(), storageFailure: isStorageError(error),
        };
        try { await onStop(jobId); } catch {}
      }
    },
    status: () => failure && { ...failure },
    state: (state) => ({ ...state, service: failure && { ...failure },
      jobs: (state.jobs || []).map(job => failure && (stopped.has(job.id) || ['queued', 'running', 'pause_requested'].includes(job.status))
        ? { ...job, status: 'paused', message: failure.message } : job),
    }),
    middleware(request, response, next) {
      if (failure && !['GET', 'HEAD'].includes(request.method)) {
        return response.status(failure.storageFailure ? 507 : 503).json({ error: failure.message, code: failure.code });
      }
      next();
    },
  };
}
