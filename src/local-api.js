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

export async function localConnectionFailure(error, readServiceStatus, { timeoutMs = 1500 } = {}) {
  const transport = ['LOCAL_API_UNREACHABLE', 'LOCAL_API_TIMEOUT'].includes(error.code);
  if (!transport) return { status: 'error', kind: error.status === 401 ? 'authorization'
    : error.code === 'LOCAL_SERVICE_DESKTOP_TIMEOUT' ? 'desktop-timeout' : 'state-read',
    code: error.code, message: error.message };
  let timer, service;
  try {
    // Diagnostics must not keep the shared state poll pending forever when
    // Electron's main thread is also unavailable. A late reply has no side
    // effects; the next poll still reads the API and never retries a publish.
    service = await Promise.race([
      Promise.resolve().then(() => readServiceStatus?.()).catch(() => null),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
  const timedOut = error.code === 'LOCAL_API_TIMEOUT';
  return { status: 'error', kind: service?.status === 'stopped' ? 'stopped' : timedOut ? 'timeout' : 'unreachable',
    code: service?.code || error.code, message: localConnectionMessage(service || {}, timedOut) };
}

export function localConnectionLabel(connection) {
  if (connection.status === 'running') return '运行正常';
  if (connection.status === 'checking') return '正在连接';
  if (['ENOSPC', 'EDQUOT', 'WORKSPACE_WRITE_FAILED'].includes(connection.code)) return '存储异常';
  return { stopped: '本地服务已停止', timeout: '本地服务响应超时', unreachable: '本地连接中断',
    authorization: '授权待恢复', 'desktop-timeout': '桌面连接响应超时', 'state-read': '进度读取异常', task: '后台任务已停止' }[connection.kind] || '本地服务异常';
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
