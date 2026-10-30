import fs from 'node:fs';
import path from 'node:path';
import { readDiagnosticTail } from './diagnostic-report.js';
import { diagnosticStage } from '../auth-server/diagnostic-schema.js';

export function pruneRuntimeDiagnostics(file, now = Date.now()) {
  try {
    if (!fs.existsSync(file)) return;
    const events = readDiagnosticTail(file, 48 * 1024).filter(item => {
      const retention = /failed|exception|stopped|error/.test(item.event || '') ? 7 * 86400000 : 86400000;
      return Number.isFinite(Date.parse(item.at)) && now - Date.parse(item.at) < retention;
    });
    fs.writeFileSync(file, events.map(item => JSON.stringify(item)).join('\n') + (events.length ? '\n' : ''), { mode: 0o600 });
  } catch {}
}

// Small, best-effort local records only: never store titles, URLs, account data,
// request bodies or raw exception messages. Logging cannot break an operation.
export function createRuntimeDiagnostics(file) {
  return (event, fields = {}) => {
    try {
      const values = {};
      for (const key of ['count', 'updated', 'failed', 'bytes', 'exitCode', 'elapsedMs', 'categoryId']) {
        if (Number.isFinite(fields[key])) values[key] = fields[key];
      }
      for (const key of ['code', 'reason', 'version']) {
        if (typeof fields[key] === 'string') values[key] = fields[key].replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80);
      }
      if (fields.stage) values.stage = diagnosticStage(fields.stage);
      const memory = process.memoryUsage();
      const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event: String(event).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80),
        ...values, rss: memory.rss, heap: memory.heapUsed, external: memory.external }) + '\n';
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let size = 0;
      try { size = fs.statSync(file).size; } catch {}
      if (size + Buffer.byteLength(line) > 64 * 1024) {
        const previous = readDiagnosticTail(file, 24 * 1024).map(item => JSON.stringify(item)).join('\n');
        fs.writeFileSync(file, previous + '\n' + line, { mode: 0o600 });
      } else fs.appendFileSync(file, line, { mode: 0o600 });
    } catch {}
  };
}
