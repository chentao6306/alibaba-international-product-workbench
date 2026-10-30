#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || exit 1
cd "$(dirname "$0")/.."
backup="/var/backups/kua-yipu-auth-$(date +%Y%m%d%H%M%S)"
install -d -m 700 "$backup"
cp -a /opt/kua-yipu-auth/auth-server "$backup/auth-server"
override=/etc/systemd/system/kua-yipu-auth.service.d/security.conf
if [[ -f "$override" ]]; then cp -a "$override" "$backup/security.conf"; fi
update_override=/etc/systemd/system/kua-yipu-auth.service.d/updates.conf
if [[ -f "$update_override" ]]; then cp -a "$update_override" "$backup/updates.conf"; fi
diagnostic_override=/etc/systemd/system/kua-yipu-auth.service.d/zz-diagnostics.conf
if [[ -f "$diagnostic_override" ]]; then cp -a "$diagnostic_override" "$backup/diagnostics.conf"; fi
proxy=/etc/nginx/sites-available/kua-yipu
cp -a "$proxy" "$backup/nginx.conf"
entry_override=/etc/systemd/system/kua-yipu-auth.service.d/admin-entry.conf
if [[ -f "$entry_override" ]]; then cp -a "$entry_override" "$backup/admin-entry.conf"; fi
node --input-type=module --check < index.js
node --input-type=module --check < security.js
node --input-type=module --check < http-security.js
node --input-type=module --check < admin-account.js
node --input-type=module --check < admin-pages.js
node --input-type=module --check < bulk-licenses.js
node --input-type=module --check < admin-bulk-licenses.js
node --input-type=module --check < diagnostics.js
node --input-type=module --check < diagnostic-schema.js
node --input-type=module --check < diagnostic-evidence.js
node --input-type=module --check < admin-diagnostics.js
set -a
source /etc/kua-yipu/auth.env
set +a
database=$(node --input-type=module -e 'console.log(decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1)))')
role=$(node --input-type=module -e 'console.log(decodeURIComponent(new URL(process.env.DATABASE_URL).username))')
[[ "$database" =~ ^[a-zA-Z0-9_]+$ && "$role" =~ ^[a-zA-Z0-9_]+$ ]] || exit 1
runuser -u postgres -- pg_dump --format=custom --dbname "$database" > "$backup/database.dump"
chmod 600 "$backup/database.dump"
rollback() {
  trap - ERR
  cp -a "$backup/auth-server/." /opt/kua-yipu-auth/auth-server/
  if [[ -f "$backup/security.conf" ]]; then cp -a "$backup/security.conf" "$override"; else rm -f "$override"; fi
  if [[ -f "$backup/updates.conf" ]]; then cp -a "$backup/updates.conf" "$update_override"; else rm -f "$update_override"; fi
  if [[ -f "$backup/diagnostics.conf" ]]; then cp -a "$backup/diagnostics.conf" "$diagnostic_override"; else rm -f "$diagnostic_override"; fi
  if [[ -f "$backup/admin-entry.conf" ]]; then cp -a "$backup/admin-entry.conf" "$entry_override"; else rm -f "$entry_override"; fi
  cp -a "$backup/nginx.conf" "$proxy"
  nginx -t && systemctl reload nginx
  systemctl daemon-reload
  systemctl restart kua-yipu-auth
  echo "Update failed; code restored from $backup. Additive schema is retained." >&2
}
trap rollback ERR
runuser -u postgres -- psql --set ON_ERROR_STOP=1 --dbname "$database" < schema.sql >/dev/null
runuser -u postgres -- psql --set ON_ERROR_STOP=1 --dbname "$database" --command "GRANT ALL PRIVILEGES ON TABLE admin_sessions TO \"$role\"" >/dev/null
install -m 644 index.js security.js http-security.js policy.js schema.sql admin.html admin.js admin.css admin-updates.js admin-account.js admin-pages.js admin-announcements.js admin-image-upload.js admin-bulk-licenses.js bulk-licenses.js announcement-content.js announcement-images.js updates.js update-key.js update-protocol.js /opt/kua-yipu-auth/auth-server/
install -m 644 diagnostics.js diagnostic-schema.js diagnostic-evidence.js admin-diagnostics.js /opt/kua-yipu-auth/auth-server/
mkdir -p /etc/systemd/system/kua-yipu-auth.service.d
install -m 644 deploy/service-hardening.conf "$override"
install -d -m 700 -o kua-yipu -g kua-yipu /var/lib/kua-yipu/updates
install -m 644 deploy/updates.conf "$update_override"
install -d -m 700 -o kua-yipu -g kua-yipu /var/lib/kua-yipu/diagnostics
install -m 644 deploy/diagnostics.conf "$diagnostic_override"
source deploy/admin-entry.sh
node ../tools/deploy-diagnostics-proxy.mjs "$proxy"
nginx -t
systemctl reload nginx
systemctl daemon-reload
systemctl restart kua-yipu-auth
for attempt in {1..20}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:8790/health; then
    echo "Authorization service updated; backup: $backup"
    exit 0
  fi
  sleep 1
done
rollback
exit 1
