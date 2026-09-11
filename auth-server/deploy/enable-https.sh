#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mapfile -t sites < <(readlink -f /etc/nginx/sites-enabled/*)
[[ ${#sites[@]} -eq 1 ]] || { echo 'Expected one existing nginx site; inspect configuration first'; exit 1; }
site="${sites[0]}"
[[ "$site" == /etc/nginx/sites-available/* ]] || exit 1
backup="/var/backups/kua-yipu-https-$(date +%Y%m%d%H%M%S)"
mkdir -p "$backup" /var/lib/letsencrypt/.well-known/acme-challenge
chmod 700 "$backup"
cp -a "$site" "$backup/nginx.conf"
restore_on_error() { cp -a "$backup/nginx.conf" "$site"; nginx -t && systemctl reload nginx; }
trap restore_on_error ERR
install -m 644 nginx-http.conf "$site"
nginx -t
systemctl reload nginx
/snap/bin/certbot certonly --webroot -w /var/lib/letsencrypt --ip-address 106.55.45.126 --cert-name 106.55.45.126 --preferred-profile shortlived --non-interactive --agree-tos --register-unsafely-without-email --deploy-hook 'nginx -t && systemctl reload nginx'
install -m 644 nginx-https.conf "$site"
nginx -t
ufw allow 443/tcp
systemctl reload nginx
curl --fail --silent --show-error --max-time 10 --resolve 106.55.45.126:443:127.0.0.1 https://106.55.45.126/health
echo "HTTPS configuration backup: $backup"
