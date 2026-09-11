#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || exit 1
mapfile -t sites < <(readlink -f /etc/nginx/sites-enabled/*)
[[ ${#sites[@]} -eq 1 && "${sites[0]}" == /etc/nginx/sites-available/* ]] || exit 1
site=${sites[0]}
backup="/var/backups/kua-yipu-compatible-tls-$(date +%Y%m%d%H%M%S)"
install -d -m 700 "$backup"
cp -a "$site" "$backup/site.conf"
for name in kua-yipu-tls-probe.conf kua-yipu-dual-test.conf; do
  if [[ -f "/etc/nginx/conf.d/$name" ]]; then mv "/etc/nginx/conf.d/$name" "$backup/$name"; fi
done
rollback() {
  trap - ERR
  cp -a "$backup/site.conf" "$site"
  for name in kua-yipu-tls-probe.conf kua-yipu-dual-test.conf; do
    if [[ -f "$backup/$name" ]]; then cp -a "$backup/$name" "/etc/nginx/conf.d/$name"; fi
  done
  nginx -t && systemctl reload nginx
}
trap rollback ERR
install -m 644 "$(dirname "$0")/nginx-compatible-https.conf" "$site"
nginx -t
systemctl reload nginx
ready=false
for attempt in {1..15}; do
  if curl --fail --silent --max-time 2 --resolve 106.55.45.126:80:127.0.0.1 https://106.55.45.126:80/health; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]]
node "$(dirname "$0")/transport-probe.mjs" 80
echo "Compatible TLS enabled. Backup: $backup"
