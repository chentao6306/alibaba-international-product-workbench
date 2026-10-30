import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import { sanitizeDiagnosticReport, diagnosticCode, DIAGNOSTIC_MAX_BYTES } from '../auth-server/diagnostic-schema.js';
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
  return { available: true, products: products.length, failedProducts: failed.length, jobs: jobs.length,
    activeJobs: jobs.filter(item => ['running', 'queued', 'pause_requested'].includes(item.status)).length,
    failures: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([code, count]) => ({ code, count })),
    recentFailures: [...failed].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).slice(0, 3).map(item => ({
      id: crypto.randomUUID(), at: item.updatedAt, product: diagnosticProduct(item).value, source: diagnosticProduct(item.source?.snapshot).value,
      error: { code: item.publishResult?.code, message: item.publishResult?.message, diagnostics: item.publishResult?.diagnostics },
      stage: item.publishResult?.diagnostics?.publishStage, screenshots: [], captureError: 'Historical error; no screenshot was recorded at that time',
    })) };
}

export function buildDiagnosticReport({ version, note, files = [], summary, service, dataDirectory, account }) {
  let freeDisk = 0;
  try { const disk = fs.statfsSync(dataDirectory); freeDisk = disk.bavail * disk.bsize; } catch {}
  const evidence = createPublishDiagnosticStore(dataDirectory, account).read(5 * 1024 * 1024);
  const captured = new Set(evidence.failures.map(item => item.product?.id).filter(Boolean));
  const oldest = Math.max(Date.now() - 7 * 86400000, evidence.clearedAt);
  const candidates = [...evidence.failures, ...(summary?.recentFailures || [])
    .filter(item => Date.parse(item.at) > oldest && !captured.has(item.product?.id))];
  const report = sanitizeDiagnosticReport({ schemaVersion: 1, reportId: crypto.randomUUID(), createdAt: new Date().toISOString(), appVersion: version, note,
    system: { platform: process.platform, arch: process.arch, osRelease: os.release(), totalMemory: os.totalmem(), freeMemory: os.freemem(), freeDisk, service },
    summary, failures: candidates.slice(0, 5), omittedFailures: evidence.omittedFailures + Math.max(0, candidates.length - 5),
    events: files.flatMap(file => readDiagnosticTail(file)).sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-80) });
  while (Buffer.byteLength(JSON.stringify(report)) > DIAGNOSTIC_MAX_BYTES - 1024 && report.failures.length) { report.failures.pop(); report.omittedFailures += 1; }
  return report;
}
