#!/usr/bin/env bash
# Run from an extracted, reviewed website deployment bundle as root.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
stage=$(cd "$(dirname "$0")/../.." && pwd)
auth=/opt/kua-yipu-auth/auth-server
site=/etc/nginx/sites-available/kua-yipu
link=/var/www/chaodekuai-website
snippet=/etc/nginx/snippets/chaodekuai-website.conf
stamp=$(date -u +%Y%m%d%H%M%S)
backup=/var/backups/chaodekuai-website-$stamp
release=/var/www/chaodekuai-website-releases/$stamp

for item in dist-website/index.html dist-website/wechat-qr.png website/deploy/nginx-location.conf; do
  [[ -s "$stage/$item" ]] || { echo "Missing bundle file: $item" >&2; exit 1; }
done
[[ -f "$site" && -d "$auth" ]] || { echo 'Expected existing authorization service was not found.' >&2; exit 1; }
[[ ! -e "$link" || -L "$link" ]] || { echo 'Website path is not a managed symlink; migration required.' >&2; exit 1; }
# Deploy the matching authorization service first with its own backup workflow.
# Website releases must not replace the administrator account/security modules.
systemctl is-active --quiet kua-yipu-auth
nginx -t
install -d -m 700 "$backup"
cp -a "$site" "$backup/nginx-site"
previous=''
if [[ -L "$link" ]]; then previous=$(readlink "$link"); printf '%s\n' "$previous" > "$backup/previous-website"; fi
if [[ -f "$snippet" ]]; then cp -a "$snippet" "$backup/nginx-snippet"; fi

rollback() {
  trap - ERR
  cp -a "$backup/nginx-site" "$site"
  if [[ -f "$backup/nginx-snippet" ]]; then cp -a "$backup/nginx-snippet" "$snippet"; else rm -f "$snippet"; fi
  if [[ -n "$previous" ]]; then ln -sfn "$previous" "$link"; else rm -f "$link"; fi
  if nginx -t; then systemctl reload nginx; fi
  echo "Deployment failed and previous service files restored. Backup: $backup" >&2
}
trap rollback ERR

install -d -m 755 "$release" /etc/nginx/snippets
cp -a "$stage/dist-website/." "$release/"
find "$release" -type d -exec chmod 755 {} +
find "$release" -type f -exec chmod 644 {} +
install -m 644 "$stage/website/deploy/nginx-location.conf" "$snippet"
python3 - "$site" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
include = '    include /etc/nginx/snippets/chaodekuai-website.conf;'
# The base IP configuration also permits an optional wildcard include before
# the website is installed. Do not add a duplicate location through both forms.
has_include = any(line.strip() in (
    include.strip(), 'include /etc/nginx/snippets/chaodekuai-website*.conf;',
) for line in text.splitlines())
if not has_include:
    anchor = '    location / {'
    if text.count(anchor) != 1:
        raise SystemExit('Unexpected Nginx site structure; no configuration written')
    p.write_text(text.replace(anchor, include + '\n' + anchor, 1))
PY
ln -s "$release" "$link.next-$stamp"
mv -Tf "$link.next-$stamp" "$link"
nginx -t
healthy=0
for attempt in {1..15}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:8790/health >/dev/null; then healthy=1; break; fi
  sleep 1
done
[[ "$healthy" == 1 ]]
systemctl reload nginx
website_ready=0
# reload queues a graceful worker replacement; the previous worker may still
# return its old 404 before the new location becomes active.
for attempt in {1..15}; do
  if curl --fail --silent --max-time 3 --resolve 106.55.45.126:443:127.0.0.1 https://106.55.45.126/website/ >/dev/null; then website_ready=1; break; fi
  sleep 1
done
[[ "$website_ready" == 1 ]]
update_status=$(curl --silent --output /dev/null --write-out '%{http_code}' --resolve 106.55.45.126:443:127.0.0.1 https://106.55.45.126/updates/chaodekuai/latest.json)
# A withdrawn/missing release pauses downloads, not website deployment.
[[ "$update_status" == 200 || "$update_status" == 404 ]]
trap - ERR
echo "Website deployed: https://106.55.45.126/website/"
echo "Backup: $backup"
echo "Static release: $release"
