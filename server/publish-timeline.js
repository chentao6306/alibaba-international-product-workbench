import { performance } from 'node:perf_hooks';
import { diagnosticStage } from '../auth-server/diagnostic-schema.js';

const MAX_ENTRIES = 120;
const MAX_DURATION_MS = 7 * 86400000;

// One bounded, in-memory trace per product attempt. No product contents, URLs,
// browser reads or disk writes are needed to observe existing progress events.
export function createPublishTimeline(initialStage = 'publishing', { clock = () => performance.now() } = {}) {
  const start = clock();
  let elapsed = 0;
  let truncated = false;
  const entries = [];
  let current = { stage: diagnosticStage(initialStage), startedMs: 0, waiting: false };
  const now = () => {
    const value = clock() - start;
    if (Number.isFinite(value)) elapsed = Math.max(elapsed, Math.min(MAX_DURATION_MS, Math.round(value)));
    return elapsed;
  };
  const entry = (at, outcome) => ({ stage: current.stage, startedMs: current.startedMs,
    durationMs: at - current.startedMs, outcome });
  return {
    advance(stage, { waiting = false } = {}) {
      const normalized = diagnosticStage(stage);
      if (normalized === current.stage && waiting === current.waiting) return null;
      const at = now();
      const completed = entry(at, current.waiting ? 'waiting' : 'completed');
      entries.push(completed);
      if (entries.length >= MAX_ENTRIES) {
        // Retain the start and the most recent stages, especially the failure.
        entries.splice(1, 1);
        truncated = true;
      }
      current = { stage: normalized, startedMs: at, waiting };
      return { ...completed };
    },
    snapshot(outcome = 'active') {
      const at = now();
      const lastOutcome = ['completed', 'failed'].includes(outcome) ? outcome : current.waiting ? 'waiting' : 'active';
      return { totalMs: at, entries: [...entries.map(item => ({ ...item })), entry(at, lastOutcome)], truncated };
    },
  };
}
