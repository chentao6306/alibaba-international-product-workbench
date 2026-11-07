#!/usr/bin/env bash
# Update only the diagnostic allowlist; no license, account or product data.
set -euo pipefail
[[ $(id -u) == 0 ]] || exit 1
source_file=${1:?Pass the staged diagnostic-schema.js file}
[[ -f "$source_file" ]] || exit 1
export PATH=/opt/kua-yipu-runtime/node-v22.23.2-linux-x64/bin:$PATH
target=/opt/kua-yipu-auth/auth-server/diagnostic-schema.js
backup="/var/backups/kua-yipu-diagnostic-schema-$(date +%Y%m%d%H%M%S)"
node --input-type=module --check < "$source_file"
install -d -m 700 "$backup"
cp -a "$target" "$backup/diagnostic-schema.js"
rollback() {
  trap - ERR
  cp -a "$backup/diagnostic-schema.js" "$target"
  systemctl restart kua-yipu-auth
  echo "Diagnostic schema rolled back: $backup" >&2
}
trap rollback ERR
install -m 644 "$source_file" "${target}.new"
mv -f "${target}.new" "$target"
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { diagnosticCode, sanitizeDiagnosticEvent } from '/opt/kua-yipu-auth/auth-server/diagnostic-schema.js';
const event = sanitizeDiagnosticEvent({ event: 'service-stopped', code: 'ERR_WORKER_OUT_OF_MEMORY',
  exitCode: 1, expected: false, reason: 'oom', memoryScope: 'worker',
  route: '/api/products/reference/preview', method: 'POST',
  body: { secret: 'PRIVATE' }, url: '/api/products/PRIVATE?token=PRIVATE' });
assert.equal(diagnosticCode({ code: 'ERR_WORKER_OUT_OF_MEMORY' }), 'ERR_WORKER_OUT_OF_MEMORY');
assert.equal(event.exitCode, 1);
assert.equal(event.memoryScope, 'worker');
assert.equal(event.route, '/api/products/reference/preview');
assert.equal(event.expected, false);
assert.equal(event.body, undefined);
assert.equal(event.url, undefined);
assert.equal(JSON.stringify(event).includes('PRIVATE'), false);
console.log('Diagnostic allowlist and redaction verified');
NODE
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
trap - ERR
echo "Diagnostic schema deployed; health OK; anonymous upload denied; backup: $backup"
