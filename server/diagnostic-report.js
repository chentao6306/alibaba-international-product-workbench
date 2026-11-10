import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import { sanitizeDiagnosticReport, sanitizeDiagnosticFailureSummary, diagnosticCode, DIAGNOSTIC_MAX_BYTES, DIAGNOSTIC_FAILURE_INDEX_LIMIT } from '../auth-server/diagnostic-schema.js';
import { diagnosticProduct } from '../auth-server/diagnostic-evidence.js';
import { createPublishDiagnosticStore } from './publish-diagnostics.js';

// Read only the bounded tail, even if an older/corrupt log grew to gigabytes.
export function readDiagnosticTail(file, maxBytes = 48 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    const lines = buffer.subarray(0, bytes).toString('utf8').split('\n');
    if (size > maxBytes) lines.shift();
    return lines.flatMap(line => { try { const item = JSON.parse(line); return item && typeof item === 'object' ? [item] : []; } catch { return []; } }).slice(-80);
  } catch { return []; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function diagnosticSummaryFromState(state) {
  const products = Array.isArray(state.products) ? state.products : [];
  const jobs = Array.isArray(state.jobs) ? state.jobs : [];
  const failed = products.filter(item => item.status === 'publish_failed');
  const counts = new Map();
  for (const item of failed) { const code = diagnosticCode(item.publishResult); counts.set(code, (counts.get(code) || 0) + 1); }
  const recent = [...failed].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).slice(0, DIAGNOSTIC_FAILURE_INDEX_LIMIT);
  const failureIndex = recent.map(item => {
    const latest = item.publishHistory?.[0] || {};
    return sanitizeDiagnosticFailureSummary({ id: crypto.randomUUID(), at: item.updatedAt, product: item,
      targetCategoryId: latest.categoryId || item.categoryId, mode: latest.mode,
      processingMode: item.publishResult?.diagnostics?.processingMode, attemptId: item.publishResult?.diagnostics?.attemptId,
      stage: item.publishResult?.diagnostics?.publishStage, error: item.publishResult, omissionReason: 'not-captured' });
  });
  return { available: true, products: products.length, failedProducts: failed.length, jobs: jobs.length,
    activeJobs: jobs.filter(item => ['running', 'queued', 'pause_requested'].includes(item.status)).length,
    failures: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([code, count]) => ({ code, count })),
    failureIndex, omittedStateIndexEntries: Math.max(0, failed.length - recent.length),
    recentFailures: recent.slice(0, 3).map((item, index) => {
      const product = diagnosticProduct(item), source = diagnosticProduct(item.source?.snapshot);
      return { ...failureIndex[index], product: product.value, source: source.value,
        truncated: product.truncated || source.truncated, truncation: { product: product.truncated, source: source.truncated },
        error: { code: item.publishResult?.code, message: item.publishResult?.message, requiredFields: item.publishResult?.requiredFields, diagnostics: item.publishResult?.diagnostics },
        screenshots: [], captureError: 'Historical error; no screenshot was recorded at that time' };
    }) };
}

export function buildDiagnosticReport({ version, note, files = [], summary, service, dataDirectory, account }) {
  let freeDisk = 0;
  try { const disk = fs.statfsSync(dataDirectory); freeDisk = disk.bavail * disk.bsize; } catch {}
  const evidence = createPublishDiagnosticStore(dataDirectory, account).read(5 * 1024 * 1024);
  const hasCapture = item => evidence.failureIndex.some(captured => captured.product?.id && captured.product.id === item.product?.id
    && (!item.at || !captured.at || Math.abs(Date.parse(captured.at) - Date.parse(item.at)) < 60000));
  const oldest = Math.max(Date.now() - 7 * 86400000, evidence.clearedAt);
  const stateIndex = (Array.isArray(summary?.failureIndex) ? summary.failureIndex : summary?.recentFailures || [])
    .filter(item => (!evidence.clearedAt || Date.parse(item.at) > evidence.clearedAt) && !hasCapture(item))
    .map(item => sanitizeDiagnosticFailureSummary({ ...item, evidence: 'omitted',
      omissionReason: Date.parse(item.at) < oldest ? 'retention-expired' : 'not-captured' }));
  const candidates = [...evidence.failures, ...(summary?.recentFailures || [])
    .filter(item => Date.parse(item.at) > oldest && !hasCapture(item))];
  const failureIndex = [...evidence.failureIndex, ...stateIndex].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  // Full captures must always have an index entry, even when many newer state
  // summaries exceed the index limit. Remaining slots stay newest first.
  const chosen = new Set(candidates.slice(0, 5).map(item => item.id));
  const boundedIndex = [...failureIndex.filter(item => chosen.has(item.id)), ...failureIndex.filter(item => !chosen.has(item.id))]
    .slice(0, DIAGNOSTIC_FAILURE_INDEX_LIMIT).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const omittedIndexEntries = Math.max(0, failureIndex.length - boundedIndex.length) + (summary?.omittedStateIndexEntries || 0);
  for (const item of boundedIndex) {
    const capture = candidates.slice(0, 5).find(candidate => candidate.id === item.id);
    if (!capture) continue;
    item.truncated ||= capture.truncated === true;
    if (item.evidence !== 'included') item.evidence = 'historical';
  }
  const report = sanitizeDiagnosticReport({ schemaVersion: 1, reportId: crypto.randomUUID(), createdAt: new Date().toISOString(), appVersion: version, note,
    system: { platform: process.platform, arch: process.arch, osRelease: os.release(), totalMemory: os.totalmem(), freeMemory: os.freemem(), freeDisk, service },
    summary, failures: candidates.slice(0, 5), failureIndex: boundedIndex,
    failureCoverage: { ...evidence.failureCoverage, omittedIndexEntries },
    omittedFailures: evidence.omittedFailures + stateIndex.length - Math.max(0, Math.min(5, candidates.length) - evidence.failures.length) + (summary?.omittedStateIndexEntries || 0),
    events: files.flatMap(file => readDiagnosticTail(file)).sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-80) });
  while (Buffer.byteLength(JSON.stringify(report)) > DIAGNOSTIC_MAX_BYTES - 1024 && report.failures.length) {
    const removed = report.failures.pop(); report.omittedFailures += 1;
    const indexed = report.failureIndex.find(item => item.id === removed.id);
    if (indexed) { indexed.evidence = 'omitted'; indexed.omissionReason = 'report-budget'; }
  }
  return report;
}
