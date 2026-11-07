import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sanitizeDiagnosticReport, DIAGNOSTIC_MAX_BYTES, DIAGNOSTIC_RETENTION_DAYS } from './diagnostic-schema.js';
import { licenseState, clientAllowed } from './policy.js';
import { clientSessionAllowed, requireCredentialTransport } from './security.js';

const fail = (message, status) => Object.assign(new Error(message), { status });
const receiptPattern = /^LOG-[A-F0-9]{24}$/;

export function diagnosticClientGuard({ bearer, findLicense }) {
  return async (request, _response, next) => {
    const auth = bearer(request);
    if (!auth?.account || auth.admin) throw fail('请登录软件后上传日志', 401);
    requireCredentialTransport(request, { credential_required: true });
    const license = await findLicense(auth);
    if (!license || licenseState(license) !== 'active' || !clientSessionAllowed(license, auth) || !clientAllowed(license, auth.deviceId)) throw fail('当前软件授权会话已失效，请重新登录后上传', 403);
    request.diagnosticOwner = { account: auth.account, device: crypto.createHash('sha256').update(auth.deviceId).digest('hex') };
    next();
  };
}

export function createDiagnosticStore(directory, { now = Date.now, maxReports = 1000, hourlyLimit = 10, maxBytes = 512 * 1024 * 1024 } = {}) {
  const fileFor = id => path.join(directory, `${id}.json`);
  const metadataFor = id => path.join(directory, `${id}.meta.json`);
  const metadata = item => ({ id: item.id, receivedAt: item.receivedAt, account: item.account, device: item.device,
    report: { reportId: item.report.reportId, appVersion: item.report.appVersion, note: item.report.note, summary: item.report.summary } });
  function remove(id) { fs.unlinkSync(fileFor(id)); try { fs.unlinkSync(metadataFor(id)); } catch {} }
  function records() {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const items = [];
    for (const name of fs.readdirSync(directory)) {
      if (!/^LOG-[A-F0-9]{24}\.json$/.test(name)) continue;
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > DIAGNOSTIC_MAX_BYTES + 2048) continue;
      let item;
      const id = name.slice(0, -5);
      try {
        const info = fs.lstatSync(metadataFor(id));
        if (!info.isFile() || info.isSymbolicLink() || info.size > 32000) throw new Error('Invalid diagnostic index');
        item = JSON.parse(fs.readFileSync(metadataFor(id), 'utf8'));
      } catch {
        try {
          item = metadata(JSON.parse(fs.readFileSync(file, 'utf8')));
          fs.writeFileSync(metadataFor(id), JSON.stringify(item), { mode: 0o600 });
        } catch { continue; }
      }
      if (!item || !receiptPattern.test(item.id) || item.id + '.json' !== name || !Number.isFinite(Date.parse(item.receivedAt)) || !item.report?.summary) continue;
      if (now() - Date.parse(item.receivedAt) >= DIAGNOSTIC_RETENTION_DAYS * 86400000) { remove(item.id); continue; }
      items.push(item);
    }
    return items.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || a.id.localeCompare(b.id));
  }
  return {
    prune: () => records().length,
    put(input, owner) {
      if (Buffer.byteLength(JSON.stringify(input)) > DIAGNOSTIC_MAX_BYTES) throw fail('日志超过上传限制，请清理较早日志后重试', 413);
      const report = sanitizeDiagnosticReport(input);
      const items = records();
      const previous = items.find(item => item.report.reportId === report.reportId && item.account === owner.account && item.device === owner.device);
      if (previous) return { id: previous.id, receivedAt: previous.receivedAt, retentionDays: DIAGNOSTIC_RETENTION_DAYS };
      if (items.filter(item => item.account === owner.account && now() - Date.parse(item.receivedAt) < 3600000).length >= hourlyLimit) throw fail('本账号一小时内已上传 10 次，请稍后再试', 429);
      const record = { id: `LOG-${crypto.randomBytes(12).toString('hex').toUpperCase()}`, receivedAt: new Date(now()).toISOString(), account: owner.account, device: owner.device, report };
      // The single-process synchronous write also serializes idempotent retries.
      const temporary = fileFor(record.id) + '.tmp';
      try {
        fs.writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, fileFor(record.id));
        fs.writeFileSync(metadataFor(record.id), JSON.stringify(metadata(record)), { mode: 0o600 });
      } finally { try { fs.unlinkSync(temporary); } catch {} }
      let storedBytes = fs.statSync(fileFor(record.id)).size;
      for (const [index, item] of items.entries()) {
        storedBytes += fs.statSync(fileFor(item.id)).size;
        if (index >= maxReports - 1 || storedBytes > maxBytes) remove(item.id);
      }
      return { id: record.id, receivedAt: record.receivedAt, retentionDays: DIAGNOSTIC_RETENTION_DAYS };
    },
    list(search = '', page = 1) {
      const query = String(search).slice(0, 200).toLowerCase();
      const items = records().filter(item => `${item.id} ${item.account} ${item.report.appVersion}`.toLowerCase().includes(query));
      const pageNumber = Math.max(1, Math.min(100, Number.parseInt(page, 10) || 1));
      return { total: items.length, page: pageNumber, pageSize: 50,
        items: items.slice((pageNumber - 1) * 50, pageNumber * 50).map(({ id, receivedAt, account, report }) => ({ id, receivedAt, account, appVersion: report.appVersion, note: report.note, failedProducts: report.summary.failedProducts })) };
    },
    get(id) {
      if (!receiptPattern.test(id)) throw fail('诊断编号无效', 400);
      const item = records().find(item => item.id === id);
      if (!item) throw fail('诊断报告不存在或已超过保留期限', 404);
      const { device, ...result } = JSON.parse(fs.readFileSync(fileFor(id), 'utf8'));
      return result;
    },
  };
}

export function registerDiagnosticRoutes(app, { directory, requireAdmin, requireClient }) {
  const store = createDiagnosticStore(directory);
  const timer = setInterval(() => { try { store.prune(); } catch {} }, 3600000);
  timer.unref();
  app.post('/api/client/diagnostics', requireClient, (request, response) => response.status(201).json(store.put(request.body, request.diagnosticOwner)));
  app.get('/api/admin/diagnostics', requireAdmin, (request, response) => response.set('Cache-Control', 'no-store').json(store.list(request.query.search, request.query.page)));
  app.get('/api/admin/diagnostics/:id', requireAdmin, (request, response) => response.set('Cache-Control', 'no-store').json(store.get(request.params.id)));
  return () => clearInterval(timer);
}
