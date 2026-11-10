import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { diagnosticProduct, diagnosticText, sanitizeDiagnosticFailure } from '../auth-server/diagnostic-evidence.js';
import { diagnosticCode, diagnosticStage, sanitizeDiagnosticFailureSummary } from '../auth-server/diagnostic-schema.js';

const MAX_FILE = 4 * 1024 * 1024;
const MAX_TOTAL = 96 * 1024 * 1024;
const RETENTION = 7 * 86400000;
const filePattern = /^[a-f0-9-]{36}\.json$/i;

function failureGroup(record) {
  const fields = [...new Set((Array.isArray(record.error?.requiredFields) ? record.error.requiredFields : [])
    .map(value => String(value).normalize('NFKC').trim().toLowerCase()).filter(Boolean))].sort();
  let stage = String(record.stage || record.error?.diagnostics?.publishStage || '');
  for (const title of [record.product?.title, record.source?.title]) {
    if (title) stage = stage.split(String(title)).join('');
  }
  // Use bounded workflow categories, not product titles or changing progress
  // counters, so repeated failures cannot crowd out another kind of evidence.
  return JSON.stringify([record.targetCategoryId || record.product?.categoryId || '', record.mode || '', record.processingMode || '',
    diagnosticCode(record.error), fields.length ? fields : diagnosticStage(stage)]);
}
export function pruneAllPublishDiagnostics(dataDirectory, now = Date.now()) {
  const root = path.join(dataDirectory, 'diagnostics');
  if (!fs.existsSync(root)) return;
  for (const name of fs.readdirSync(root)) {
    if (!/^[a-f0-9]{24}$/.test(name)) continue;
    const directory = path.join(root, name);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    for (const entry of fs.readdirSync(directory).filter(item => filePattern.test(item))) {
      const file = path.join(directory, entry); const info = fs.lstatSync(file);
      if (info.isFile() && !info.isSymbolicLink() && now - info.mtimeMs > RETENTION) fs.unlinkSync(file);
    }
  }
}
export function createPublishDiagnosticStore(dataDirectory, account, { now = Date.now } = {}) {
  const directory = path.join(dataDirectory, 'diagnostics', crypto.createHash('sha256').update(String(account || 'local')).digest('hex').slice(0, 24));
  const clearMarker = path.join(directory, 'cleared-at');
  function clearedAt() {
    try { return fs.statSync(clearMarker).mtimeMs; } catch { return 0; }
  }
  function entries() {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return fs.readdirSync(directory).filter(name => filePattern.test(name)).flatMap(name => {
      const file = path.join(directory, name);
      try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink() ? [{ file, size: stat.size, time: stat.mtimeMs }] : []; } catch { return []; }
    }).sort((a, b) => b.time - a.time);
  }
  function prune() {
    let total = 0; let kept = 0;
    const removed = { retention: 0, fileSize: 0, storageLimit: 0 };
    for (const item of entries()) {
      total += item.size; kept += 1;
      if (now() - item.time > RETENTION || item.size > MAX_FILE || total > MAX_TOTAL || kept > 60) {
        removed[now() - item.time > RETENTION ? 'retention' : item.size > MAX_FILE ? 'fileSize' : 'storageLimit'] += 1;
        fs.unlinkSync(item.file); total -= item.size; kept -= 1;
      }
    }
    return removed;
  }
  return {
    prune,
    write(input) {
      const record = sanitizeDiagnosticFailure({ ...input, id: crypto.randomUUID(), at: new Date(now()).toISOString() });
      let content = JSON.stringify(record);
      while (Buffer.byteLength(content) > MAX_FILE && record.screenshots.length) { record.screenshots.pop(); record.truncated = true; record.truncation.screenshots = true; content = JSON.stringify(record); }
      if (Buffer.byteLength(content) > MAX_FILE) return false;
      prune();
      fs.writeFileSync(path.join(directory, record.id + '.json'), content, { mode: 0o600 });
      prune(); return true;
    },
    read(maxBytes = 6 * 1024 * 1024) {
      const prunedDuringRead = prune(); let bytes = 0;
      const files = entries(), selected = [], deferred = [], groups = new Set(), failureIndex = [];
      for (let index = 0; index < files.length; index++) {
        const item = files[index];
        try {
          const record = sanitizeDiagnosticFailure(JSON.parse(fs.readFileSync(item.file, 'utf8')));
          failureIndex.push(sanitizeDiagnosticFailureSummary(record));
          if (selected.length >= 5 || bytes + item.size > maxBytes) continue;
          const group = failureGroup(record);
          if (groups.has(group)) { deferred.push({ item, index }); continue; }
          selected.push({ record, index }); groups.add(group); bytes += item.size;
        } catch {
          failureIndex.push(sanitizeDiagnosticFailureSummary({ id: path.basename(item.file, '.json'), at: new Date(item.time).toISOString(), omissionReason: 'unreadable' }));
        }
      }
      // Keep only file references for duplicates, not dozens of large product
      // snapshots/screenshots. Read at most one bounded file at a time and use
      // remaining slots for the most recent repeats after distinct groups.
      for (const { item, index } of deferred) {
        if (selected.length >= 5) break;
        if (bytes + item.size > maxBytes) continue;
        try {
          const record = sanitizeDiagnosticFailure(JSON.parse(fs.readFileSync(item.file, 'utf8')));
          selected.push({ record, index }); bytes += item.size;
        } catch { /* Count unreadable records with all other omitted files. */ }
      }
      const failures = selected.sort((a, b) => a.index - b.index).map(item => item.record);
      const selectedIndices = new Set(selected.map(item => item.index));
      for (let index = 0; index < failureIndex.length; index++) {
        const summary = failureIndex[index];
        if (selectedIndices.has(index)) { summary.evidence = 'included'; delete summary.omissionReason; }
        else if (summary.omissionReason !== 'unreadable') summary.omissionReason = bytes + files[index].size > maxBytes ? 'report-budget' : 'snapshot-limit';
      }
      return { failures, failureIndex, omittedFailures: files.length - failures.length, clearedAt: clearedAt(),
        failureCoverage: { retainedSnapshots: files.length, prunedDuringRead } };
    },
    clear() { for (const item of entries()) fs.unlinkSync(item.file); fs.writeFileSync(clearMarker, '', { mode: 0o600 }); },
  };
}

export async function capturePublishFailure({ page, product, error, stage, mode, elapsedMs, targetCategoryId, processingMode, timeline, attemptId, aiMapping = [] }) {
  const current = diagnosticProduct(product); const source = diagnosticProduct(product.source?.snapshot || {});
  const record = { product: current.value, source: source.value, truncated: current.truncated || source.truncated,
    truncation: { product: current.truncated, source: source.truncated }, targetCategoryId, processingMode, timeline, attemptId,
    error: { code: error.code, message: diagnosticText(error.message), stack: diagnosticText(error.stack, 16000).replace(/[a-z]:[\\/][^\r\n()]*?[\\/]([^\\/\s()]+\.m?js:\d+:\d+)/gi, '$1'),
      ...(error.cause instanceof Error ? { cause: { code: error.cause.code, message: diagnosticText(error.cause.message, 6000) } } : {}),
      requiredFields: error.requiredFields, diagnostics: { ...error.diagnostics,
        ...(aiMapping.length ? { aiMapping } : {}), ...(product.aiCollection ? { aiCollection: product.aiCollection } : {}) } }, stage, mode, elapsedMs, screenshots: [] };
  // Login/verification windows and unrelated browsing pages are never captured.
  if (!page || page.isClosed() || !/^https:\/\/post\.alibaba\.com\/product\//.test(page.url())) {
    record.captureError = 'No active product publishing page'; return record;
  }
  const captureErrors = [];
  try {
    let timer;
    try { record.page = await Promise.race([page.evaluate(() => {
      const visible = n => !!n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden';
      const root = document.querySelector('#struct-content') || document.body;
      return { url: location.origin + location.pathname + location.search,
        text: root.innerText.slice(0, 60000),
        feedback: [...document.querySelectorAll('[role="alert"],.next-message,.next-dialog,.error-msg,.error-message,.feedback')].filter(visible).map(n => n.innerText?.slice(0, 2000)).filter(Boolean).slice(0, 30),
        fields: [...root.querySelectorAll('input,textarea,select,[contenteditable="true"]')].filter(n => visible(n) && !['password', 'hidden', 'file'].includes(n.type) && !/password|cookie|token|authorization|activation|secret|密码|授权码/i.test(n.name + ' ' + n.id))
          .slice(0, 400).map(n => ({ id: n.id, name: n.name, type: n.type || n.tagName, value: String(n.value ?? n.innerText ?? '').slice(0, 2000), checked: n.checked, disabled: n.disabled })),
      };
    }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Publishing page snapshot timed out')), 3000); })]); }
    finally { clearTimeout(timer); }
  } catch (failure) { captureErrors.push(diagnosticText(failure.message, 300)); }
  try {
    const mask = [page.locator('input[type="password"],input[autocomplete="one-time-code"],input[name*="token" i],input[name*="secret" i],input[name*="password" i],input[name*="activation" i]')];
    const addImage = async (label, locator) => {
      const { default: sharp } = await import('sharp');
      const bytes = await locator.screenshot({ type: 'jpeg', quality: 65, timeout: 2500, mask });
      const image = await sharp(bytes).resize({ width: 1440, height: 2400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
      if (image.length <= 1100000) record.screenshots.push({ label, data: image.toString('base64') });
    };
    await addImage('发布失败时的页面', page);
    const alerts = page.locator('[role="alert"], .next-dialog, .next-message-error').filter({ visible: true });
    if (await alerts.count()) await addImage('平台报错提示', alerts.first());
  } catch (failure) { captureErrors.push(diagnosticText(failure.message, 300)); }
  if (captureErrors.length) record.captureError = captureErrors.join('; ');
  return record;
}
