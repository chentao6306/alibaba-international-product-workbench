#!/usr/bin/env bash
# Add manual diagnostic ingestion and the admin viewer without modifying licenses.
set -euo pipefail
[[ $(id -u) == 0 ]] || exit 1
cd "$(dirname "$0")/.."
export PATH=/opt/kua-yipu-runtime/node-v22.23.2-linux-x64/bin:$PATH
files=(index.js admin-pages.js admin.html admin.js diagnostics.js diagnostic-schema.js diagnostic-evidence.js admin-diagnostics.js)
for file in "${files[@]}"; do
  if [[ "$file" == *.js ]]; then node --input-type=module --check < "$file"; fi
done
backup="/var/backups/kua-yipu-auth-diagnostics-$(date +%Y%m%d%H%M%S)"
override=/etc/systemd/system/kua-yipu-auth.service.d/zz-diagnostics.conf
proxy=/etc/nginx/sites-available/kua-yipu
install -d -m 700 "$backup"
cp -a /opt/kua-yipu-auth/auth-server "$backup/auth-server"
cp -a "$proxy" "$backup/nginx.conf"
if [[ -f "$override" ]]; then cp -a "$override" "$backup/diagnostics.conf"; fi
rollback() {
  trap - ERR
  cp -a "$backup/auth-server/." /opt/kua-yipu-auth/auth-server/
  cp -a "$backup/nginx.conf" "$proxy"
  nginx -t && systemctl reload nginx
  if [[ -f "$backup/diagnostics.conf" ]]; then cp -a "$backup/diagnostics.conf" "$override"; else rm -f "$override"; fi
  systemctl daemon-reload
  systemctl restart kua-yipu-auth
  echo "Diagnostic deployment failed; previous code restored from $backup" >&2
}
trap rollback ERR
install -m 644 "${files[@]}" /opt/kua-yipu-auth/auth-server/
install -d -m 700 -o kua-yipu -g kua-yipu /var/lib/kua-yipu/diagnostics
install -d -m 755 /etc/systemd/system/kua-yipu-auth.service.d
install -m 644 deploy/diagnostics.conf "$override"
node ../tools/deploy-diagnostics-proxy.mjs "$proxy"
nginx -t
systemctl reload nginx
systemctl daemon-reload
systemctl restart kua-yipu-auth
for attempt in {1..20}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:8790/health; then
    status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 -H 'content-type: application/json' --data '{}' http://127.0.0.1:8790/api/client/diagnostics)
    [[ "$status" == 401 ]]
    echo "Diagnostics deployed; backup: $backup"
    exit 0
  fi
  sleep 1
done
rollback
exit 1
