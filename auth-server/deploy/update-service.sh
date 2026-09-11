#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
backup="/var/backups/kua-yipu-auth-$(date +%Y%m%d%H%M%S)"
mkdir -p "$backup"
chmod 700 "$backup"
cp -a /opt/kua-yipu-auth/auth-server/index.js "$backup/index.js"
if [[ -f /opt/kua-yipu-auth/auth-server/http-security.js ]]; then cp -a /opt/kua-yipu-auth/auth-server/http-security.js "$backup/http-security.js"; fi
override=/etc/systemd/system/kua-yipu-auth.service.d/security.conf
if [[ -f "$override" ]]; then cp -a "$override" "$backup/security.conf"; fi
node --input-type=module --check < index.js
node --input-type=module --check < http-security.js
rollback() {
  trap - ERR
  cp -a "$backup/index.js" /opt/kua-yipu-auth/auth-server/index.js
  if [[ -f "$backup/http-security.js" ]]; then cp -a "$backup/http-security.js" /opt/kua-yipu-auth/auth-server/http-security.js; else rm -f /opt/kua-yipu-auth/auth-server/http-security.js; fi
  if [[ -f "$backup/security.conf" ]]; then cp -a "$backup/security.conf" "$override"; else rm -f "$override"; fi
  systemctl daemon-reload
  systemctl restart kua-yipu-auth
  echo "Update failed; restored $backup" >&2
}
trap rollback ERR
install -m 644 index.js http-security.js /opt/kua-yipu-auth/auth-server/
mkdir -p /etc/systemd/system/kua-yipu-auth.service.d
install -m 644 deploy/service-hardening.conf /etc/systemd/system/kua-yipu-auth.service.d/security.conf
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
