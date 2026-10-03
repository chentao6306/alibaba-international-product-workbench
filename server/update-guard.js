// Freeze new writes only after all work and in-flight edits have finished.
// The updater never interrupts a publish operation or changes its outcome.
export function createUpdateGuard(isBusy) {
  let locked = false;
  let pending = 0;
  return {
    middleware(request, response, next) {
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
      if (locked) return response.status(409).json({ error: '正在准备安装更新，请稍后操作' });
      pending++;
      let settled = false;
      const finish = () => { if (!settled) { settled = true; pending--; } };
      response.once('finish', finish);
      response.once('close', finish);
      next();
    },
    acquire() {
      if (locked || pending || isBusy()) throw new Error('任务或保存操作仍在进行，请等待完成或暂停任务后再安装更新');
      locked = true;
      return true;
    },
    release() { locked = false; },
  };
}
