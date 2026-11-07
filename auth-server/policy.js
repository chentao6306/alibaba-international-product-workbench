import { announcementPlainText, validateAnnouncementBlocks } from './announcement-content.js';

export function licenseState(license, time = Date.now()) {
  if (license.deleted_at) return 'deleted';
  if (license.status !== 'active') return license.status;
  return new Date(license.expires_at).getTime() > time ? 'active' : 'expired';
}

export function licenseFilters(query = {}) {
  const statuses = [...new Set(String(query.status || 'all').split(',').filter((value) => value !== 'all' && value))];
  const activity = String(query.activity || 'all');
  const devices = String(query.devices || 'all');
  if (statuses.some((value) => !['active', 'expired', 'paused', 'revoked', 'deleted'].includes(value))
    || !['all', '24h', '30d', 'never'].includes(activity) || !['all', 'multiple', 'single'].includes(devices)) {
    throw Object.assign(new Error('查询条件无效'), { status: 400 });
  }
  return { statuses, activity, devices, search: String(query.search || '').trim().slice(0, 160) };
}

export function matchesLicenseFilters(license, filters, time = Date.now()) {
  const state = licenseState(license, time);
  const recent = new Date(license.last_seen_at || 0).getTime();
  return (filters.statuses.length ? filters.statuses.includes(state) : state !== 'deleted')
    && [license.alibaba_account, license.note || ''].some((value) => value.toLowerCase().includes(filters.search.toLowerCase()))
    && (filters.devices === 'all' || (license.allow_multi_device !== false) === (filters.devices === 'multiple'))
    && (filters.activity === 'all' || (filters.activity === 'never' ? !license.last_seen_at : recent > time - (filters.activity === '24h' ? 1 : 30) * 86400000));
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
  const plain = String(body?.content || '').trim();
  const suppliedBlocks = body?.blocks;
  const blocks = validateAnnouncementBlocks(suppliedBlocks === undefined || Array.isArray(suppliedBlocks) && !suppliedBlocks.length
    ? [{ type: 'text', text: plain }] : suppliedBlocks);
  const content = announcementPlainText(blocks);
  const kind = body?.kind || 'notice';
  const popupPolicy = body?.popup_policy || 'once';
  const status = body?.status || 'draft';
  if (!title || title.length > 160 || !['notice', 'popup'].includes(kind) || !['once', 'every-login'].includes(popupPolicy) || !['draft', 'published', 'withdrawn'].includes(status)) {
    throw Object.assign(new Error('请填写公告标题、正文并选择有效的公告类型和状态'), { status: 400 });
  }
  return { title, content, blocks, kind, popup_policy: kind === 'popup' ? popupPolicy : 'once', status };
}
