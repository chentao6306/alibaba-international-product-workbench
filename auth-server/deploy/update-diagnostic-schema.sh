#!/usr/bin/env bash
# Deploy the diagnostic schema/evidence pair without modifying customer data.
# Usage: update-diagnostic-schema.sh [--verify-only] schema.js evidence.js
# A one-file invocation deliberately fails before touching production:
# schema.js imports evidence.js and mismatched versions can stop the service.
set -Eeuo pipefail
verify_only=false
if [[ ${1:-} == --verify-only ]]; then verify_only=true; shift; fi
if [[ $# != 2 ]]; then
  echo 'Usage: update-diagnostic-schema.sh [--verify-only] diagnostic-schema.js diagnostic-evidence.js' >&2
  exit 2
fi
schema_source=$1
evidence_source=$2
[[ -f "$schema_source" && -f "$evidence_source" ]] || { echo 'Both staged modules are required' >&2; exit 2; }
export PATH=/opt/kua-yipu-runtime/node-v22.23.2-linux-x64/bin:$PATH
staging=$(mktemp -d)
cleanup() { rm -rf -- "$staging"; }
trap cleanup EXIT
install -m 600 "$schema_source" "$staging/diagnostic-schema.js"
install -m 600 "$evidence_source" "$staging/diagnostic-evidence.js"
printf '%s\n' '{"type":"module"}' > "$staging/package.json"

# Run the same contract check on the isolated pair and the installed pair.
# Importing the schema checks its real dependency, not only JS syntax.
verify_pair() {
  node --input-type=module - "$1" <<'NODE'
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const directory = process.argv[2];
const { diagnosticCode, sanitizeDiagnosticEvent, sanitizeDiagnosticReport } = await import(pathToFileURL(path.join(directory, 'diagnostic-schema.js')));
const { sanitizeDiagnosticFailure } = await import(pathToFileURL(path.join(directory, 'diagnostic-evidence.js')));
const attemptId = '9a099b74-3893-4797-9141-b77fdc953dd0';
const event = sanitizeDiagnosticEvent({ event: 'service-stopped', code: 'ERR_WORKER_OUT_OF_MEMORY',
  exitCode: 1, expected: false, reason: 'oom', memoryScope: 'worker',
  route: '/api/products/reference/preview', method: 'POST', attemptId, mode: 'draft', processingMode: 'rules', stageMs: 120,
  body: { secret: 'PRIVATE' }, url: '/api/products/PRIVATE?token=PRIVATE' });
assert.equal(diagnosticCode({ code: 'ERR_WORKER_OUT_OF_MEMORY' }), 'ERR_WORKER_OUT_OF_MEMORY');
assert.equal(event.exitCode, 1);
assert.equal(event.memoryScope, 'worker');
assert.equal(event.route, '/api/products/reference/preview');
assert.equal(event.expected, false);
assert.equal(event.body, undefined);
assert.equal(event.url, undefined);
assert.equal(event.attemptId, attemptId);
assert.equal(event.stageMs, 120);
assert.equal(sanitizeDiagnosticEvent({ event: 'publish-stage-completed' }).event, 'publish-stage-completed');
const failure = { id: attemptId, attemptId, at: '2026-11-10T00:00:00.000Z', mode: 'draft', processingMode: 'rules', targetCategoryId: '201',
  stage: 'save-draft', product: { id: 'synthetic-fixture', title: 'Synthetic verification item', apiKey: 'PRIVATE' },
  error: { code: 'PUBLISH_PAGE_INCOMPLETE', message: 'password=PRIVATE', token: 'PRIVATE' },
  timeline: { totalMs: 120, entries: [{ stage: 'save-draft', startedMs: 0, durationMs: 120, outcome: 'failed', cookie: 'PRIVATE' }] },
  truncated: true, truncation: { source: true }, evidence: 'included' };
const base = { schemaVersion: 1, reportId: attemptId, createdAt: failure.at, appVersion: '1.0.0', events: [event] };
const legacy = sanitizeDiagnosticReport(base);
assert.equal(legacy.schemaVersion, 1);
assert.equal(legacy.failures.length, 0);
assert.deepEqual(sanitizeDiagnosticReport(legacy), legacy);
const report = sanitizeDiagnosticReport({ ...base, failures: [failure], failureIndex: [failure],
  failureCoverage: { retainedSnapshots: 1, omittedIndexEntries: 0 } });
assert.equal(report.failures[0].timeline.entries[0].stage, 'save-draft');
assert.equal(report.failures[0].truncation.source, true);
assert.equal(report.failureIndex[0].attemptId, attemptId);
assert.equal(report.failureIndex[0].processingMode, 'rules');
assert.equal(report.failureIndex[0].targetCategoryId, '201');
assert.equal(report.failureCoverage.indexLimit, 60);
assert.equal(sanitizeDiagnosticFailure(failure).timeline.totalMs, 120);
assert.deepEqual(sanitizeDiagnosticReport(report), report);
assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
console.log('Diagnostic module pair: import, new fields, legacy reports and redaction verified');
NODE
}
verify_pair "$staging"
if [[ "$verify_only" == true ]]; then exit 0; fi
[[ $(id -u) == 0 ]] || { echo 'Deployment requires root; use --verify-only for an offline check' >&2; exit 1; }
exec 9>/var/lock/kua-yipu-diagnostic-schema.lock
flock -n 9 || { echo 'Another diagnostic module deployment is already running' >&2; exit 1; }

target_directory=/opt/kua-yipu-auth/auth-server
backup=$(mktemp -d /var/backups/kua-yipu-diagnostic-schema-XXXXXXXX)
chmod 700 "$backup"
for module in diagnostic-schema.js diagnostic-evidence.js; do
  [[ -f "$target_directory/$module" ]] || { echo "Missing installed module: $module" >&2; exit 1; }
  cp -a "$target_directory/$module" "$backup/$module"
done
rollback() {
  local failed_status=$?
  trap - ERR INT TERM
  set +e
  # Keep the service stopped until both prior modules have been restored.
  systemctl stop kua-yipu-auth
  local restored=true
  for module in diagnostic-schema.js diagnostic-evidence.js; do
    cp -a "$backup/$module" "$target_directory/$module.rollback" && mv -f "$target_directory/$module.rollback" "$target_directory/$module" || restored=false
    rm -f -- "$target_directory/$module.new"
  done
  if [[ "$restored" == true ]]; then
    systemctl restart kua-yipu-auth || echo 'Prior code restored, but service restart failed; inspect systemd' >&2
  else
    echo 'Module rollback failed; service kept stopped to avoid running a mixed pair' >&2
  fi
  echo "Diagnostic pair deployment failed; backup: $backup" >&2
  [[ "$failed_status" != 0 ]] || failed_status=1
  exit "$failed_status"
}
trap rollback ERR INT TERM
for module in diagnostic-schema.js diagnostic-evidence.js; do
  install -m 644 "$staging/$module" "$target_directory/$module.new"
done
# Two renames cannot be one transaction. Stopping the service makes the pair
# atomic to the running application; rollback restores both prior modules.
systemctl stop kua-yipu-auth
for module in diagnostic-schema.js diagnostic-evidence.js; do
  mv -f "$target_directory/$module.new" "$target_directory/$module"
done
verify_pair "$target_directory"
systemctl restart kua-yipu-auth
healthy=false
for attempt in {1..20}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:8790/health >/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done
[[ "$healthy" == true ]]
status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 \
  -H 'content-type: application/json' --data '{}' http://127.0.0.1:8790/api/client/diagnostics)
[[ "$status" == 401 ]]
trap - ERR INT TERM
echo "Diagnostic module pair deployed; health OK; anonymous upload denied; backup: $backup"
