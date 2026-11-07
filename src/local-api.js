export function localConnectionMessage(status = {}, timedOut = false) {
  if (status.code === 'ERR_STRING_TOO_LONG') return '本地数据处理失败：单次处理的数据超过字符串长度限制。已保存的商品和任务进度保留；请上传日志，并先核对当前商品的发布结果，不要重复提交上架。';
  if (status.code === 'ERR_WORKER_OUT_OF_MEMORY') return '本地后台达到运行时堆内存限制，服务已停止；电脑仍有可用内存时也可能发生。已保存进度保留，请重新打开软件并上传日志，先核对最近一次图片保存或上架结果。';
  if ((status.freeBytes != null && status.freeBytes < 128 * 1024 * 1024) || ['ENOSPC', 'EDQUOT'].includes(status.code)) {
    return '数据所在磁盘空间不足，本地服务可能已停止。请释放磁盘空间后重新打开软件；继续上架前先核对当前商品的发布结果。';
  }
  if (status.status === 'stopped') return '本地后台服务已停止，页面显示的是最后一次读取的进度。请重新打开软件，并先核对当前商品的发布结果。';
  return timedOut
    ? '本地服务响应超时，正在重新读取进度；请勿重复提交上架任务。'
    : '暂时无法连接本地服务，正在重新读取进度；请勿重复提交上架任务。';
}

export async function localFetch(url, options = {}) {
  try { return await fetch(url, options); }
  catch (cause) {
    if (cause.name === 'AbortError' && options.signal?.aborted && options.signal.reason?.name !== 'TimeoutError') throw cause;
    const timedOut = cause.name === 'TimeoutError' || options.signal?.reason?.name === 'TimeoutError';
    throw Object.assign(new Error(localConnectionMessage({}, timedOut), { cause }), {
      code: timedOut ? 'LOCAL_API_TIMEOUT' : 'LOCAL_API_UNREACHABLE',
    });
  }
}
