export function isStorageError(error) {
  return error?.storageFailure === true || ['ENOSPC', 'EDQUOT', 'WORKSPACE_WRITE_FAILED'].includes(error?.code);
}

export function storageError(error, filePath = '') {
  const full = ['ENOSPC', 'EDQUOT'].includes(error?.code);
  const drive = String(filePath).match(/^[a-z]:/i)?.[0] || '';
  const message = full
    ? `${drive ? drive + ' ' : ''}磁盘可用空间不足，无法保存商品和任务进度；请释放空间后重新打开软件`
    : '商品和任务进度保存失败，请检查数据目录权限、磁盘及安全软件后重新打开软件';
  return Object.assign(new Error(message, { cause: error }), {
    code: full ? 'ENOSPC' : 'WORKSPACE_WRITE_FAILED', storageFailure: true, status: full ? 507 : 503,
  });
}
