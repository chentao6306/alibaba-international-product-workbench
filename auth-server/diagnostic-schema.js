// Shared allowlist for desktop capture and server ingestion. Product evidence
// is sanitized separately; browser sessions and credentials are never included.
import { sanitizeDiagnosticFailure } from './diagnostic-evidence.js';
export const DIAGNOSTIC_MAX_BYTES = 8 * 1024 * 1024;
export const DIAGNOSTIC_RETENTION_DAYS = 30;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const number = value => Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER) : 0;
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : '';

export function redactDiagnosticNote(value) {
  return String(value || '').slice(0, 4000)
    .replace(/(?:password|passwd|pwd|cookie|authorization|token|secret|密码|授权码|密钥)\s*[：:=]?[^\r\n]*/gi, '[敏感内容已移除]')
    .replace(/\bCDK-[\w-]+/gi, '[授权码已移除]')
    .replace(/(?:https?:\/\/|file:\/\/)[^\s<>]+/gi, '[链接已移除]')
    .replace(/[a-z]:[\\/][^\r\n]+/gi, '[本地路径已移除]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[邮箱已移除]')
    .replace(/[a-zA-Z0-9_+\/-]{24,}={0,2}/g, '[长标识已移除]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 1000);
}

export function diagnosticCode(error = {}) {
  error = error && typeof error === 'object' ? error : { message: error };
  const code = String(error.code || '');
  if (/^(?:PUBLISH|SOURCE|COLLECT|STORAGE|AUTH|LOGIN|IMAGE|VIDEO|SKU|CATEGORY|HUMAN|BROWSER|WORKSPACE|LOCAL_SERVICE)_[A-Z0-9_]{1,55}$/.test(code)
    || /^(?:ENOSPC|ENOMEM|EACCES|EPERM|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ERR_STRING_TOO_LONG|ERR_ABORTED)$/.test(code)) return code;
  const message = String(error.message || error.reason || '').slice(0, 8000);
  for (const [pattern, result] of [
    [/Cannot create a string longer|Invalid string length/i, 'ERR_STRING_TOO_LONG'],
    [/out of memory|heap out|内存不足/i, 'ENOMEM'],
    [/空间不足|no space left/i, 'ENOSPC'],
    [/语言设置|简体中文|language.*(?:switch|ready)/i, 'PUBLISH_LANGUAGE_NOT_READY'],
    [/产品图片|主图.*(?:失败|未完成|缺)|image.*upload/i, 'PUBLISH_IMAGE_REJECTED'],
    [/按规格定价|sku.*pric/i, 'PUBLISH_SKU_PRICE_NOT_READY'],
    [/产地.*(?:就绪|加载)/, 'PUBLISH_ORIGIN_NOT_READY'],
    [/来源缺少|缺少必填/, 'SOURCE_REQUIRED_DATA_MISSING'],
    [/已采集但|未接受|没有与来源规格/, 'PUBLISH_FIELD_REJECTED'],
    [/页面操作未完成/, 'PUBLISH_PAGE_INCOMPLETE'],
    [/captcha|验证码|滑块|人工验证/i, 'HUMAN_VERIFICATION_REQUIRED'],
    [/登录.*(?:失效|失败)|密码.*错误/, 'LOGIN_REQUIRED'],
    [/授权.*(?:失效|过期|停用|无效)/, 'AUTH_REJECTED'],
    [/timeout|超时/i, 'BROWSER_TIMEOUT'],
    [/fetch failed|network|网络|ECONN|ERR_CONNECTION/i, 'LOCAL_SERVICE_NETWORK_ERROR'],
  ]) if (pattern.test(message)) return result;
  return 'UNKNOWN_ERROR';
}

export function diagnosticStage(value) {
  const text = String(value || '').slice(0, 500);
  if (['video', 'description', 'packaging', 'images', 'pricing', 'specifications', 'attributes', 'category', 'language', 'submit', 'login', 'collection', 'startup', 'publishing'].includes(text)) return text;
  for (const [pattern, stage] of [
    [/视频|video/i, 'video'], [/详情|description/i, 'description'], [/包装|物流|packaging/i, 'packaging'],
    [/图片|主图|image/i, 'images'], [/价格|定价|price/i, 'pricing'], [/规格|sku/i, 'specifications'],
    [/属性|产地|attribute/i, 'attributes'], [/类目|category/i, 'category'], [/语言|中文|language/i, 'language'],
    [/提交|submit/i, 'submit'], [/登录|login/i, 'login'], [/采集|collect/i, 'collection'],
    [/启动|startup/i, 'startup'], [/发布|publish/i, 'publishing'],
  ]) if (pattern.test(text)) return stage;
  return 'unknown';
}

export function sanitizeDiagnosticEvent(event = {}) {
  event = event && typeof event === 'object' ? event : {};
  const allowed = ['main-exception', 'renderer-stopped', 'workbench-startup-failed', 'service-stopped', 'service-started', 'login-failed', 'api-error', 'publish-started', 'publish-progress', 'publish-completed', 'publish-failed', 'collection-failed'];
  return {
    at: date(event.at), event: allowed.includes(event.event) ? event.event : 'runtime-event',
    code: event.code ? diagnosticCode(event) : '', stage: diagnosticStage(event.stage),
    ...(event.reason === 'oom' ? { reason: 'oom' } : {}),
    ...Object.fromEntries(['rss', 'heap', 'external', 'elapsedMs', 'count', 'failed', 'bytes', 'categoryId'].map(key => [key, number(event[key])])),
  };
}

export function sanitizeDiagnosticReport(input = {}) {
  input = input && typeof input === 'object' ? input : {};
  if (!uuid.test(input.reportId || '') || !date(input.createdAt) || input.schemaVersion !== 1) throw Object.assign(new Error('日志格式无效，请重新上传'), { status: 400 });
  const system = input.system || {};
  const summary = input.summary || {};
  return {
    schemaVersion: 1, reportId: input.reportId.toLowerCase(), createdAt: date(input.createdAt),
    appVersion: /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(input.appVersion || '') ? input.appVersion : 'unknown',
    note: redactDiagnosticNote(input.note),
    system: {
      platform: ['win32', 'linux', 'darwin'].includes(system.platform) ? system.platform : 'unknown',
      arch: ['x64', 'arm64', 'ia32'].includes(system.arch) ? system.arch : 'unknown',
      osRelease: /^[\d.]{1,30}$/.test(system.osRelease || '') ? system.osRelease : '',
      totalMemory: number(system.totalMemory), freeMemory: number(system.freeMemory), freeDisk: number(system.freeDisk),
      service: ['running', 'starting', 'stopped', 'failed', 'ready'].includes(system.service) ? system.service : 'unavailable',
    },
    summary: {
      available: summary.available === true,
      products: number(summary.products), failedProducts: number(summary.failedProducts), jobs: number(summary.jobs),
      activeJobs: number(summary.activeJobs),
      failures: (Array.isArray(summary.failures) ? summary.failures : []).slice(0, 20).map(item => ({ code: diagnosticCode(item), count: number(item?.count) })),
    },
    events: (Array.isArray(input.events) ? input.events : []).slice(-80).map(sanitizeDiagnosticEvent),
    failures: (Array.isArray(input.failures) ? input.failures : []).slice(0, 5).map(sanitizeDiagnosticFailure),
    omittedFailures: number(input.omittedFailures),
  };
}
