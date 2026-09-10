export function licenseState(license, time = Date.now()) {
  if (license.status !== 'active') return license.status;
  return new Date(license.expires_at).getTime() > time ? 'active' : 'expired';
}

export function clientAllowed(license, deviceId, time = Date.now()) {
  return Boolean(license && deviceId && licenseState(license, time) === 'active'
    && (license.allow_multi_device !== false || !license.active_device_id || license.active_device_id === deviceId));
}

export function pagination(query = {}) {
  const page = Math.max(1, Math.min(1000000, Math.floor(Number(query.page) || 1)));
  const pageSize = [10, 20, 50, 100].includes(Number(query.pageSize)) ? Number(query.pageSize) : 20;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function announcementInput(body) {
  const title = String(body?.title || '').trim();
  const content = String(body?.content || '').trim();
  const kind = body?.kind || 'notice';
  const status = body?.status || 'draft';
  if (!title || title.length > 160 || !content || content.length > 20000 || !['notice', 'popup'].includes(kind) || !['draft', 'published', 'withdrawn'].includes(status)) {
    throw Object.assign(new Error('请填写公告标题、正文并选择有效的公告类型和状态'), { status: 400 });
  }
  return { title, content, kind, status };
}
