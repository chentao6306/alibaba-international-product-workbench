#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || exit 1
[[ ${1:-} == isolated-tests-passed ]] || { echo 'Run isolated PostgreSQL tests first'; exit 1; }
cd "$(dirname "$0")/../.."
staging=$(pwd -P)
[[ "$staging" == /var/tmp/kua-yipu-announcements-* ]] || exit 1
export PATH=/opt/kua-yipu-runtime/node-v22.23.2-linux-x64/bin:$PATH
node --input-type=module -e 'import sharp from "sharp"; await sharp({create:{width:1,height:1,channels:3,background:"white"}}).webp().toBuffer();'
for file in auth-server/{index,policy,announcement-content,announcement-images,admin,admin-announcements,admin-pages}.js; do node --check "$file"; done
backup="/var/backups/kua-yipu-announcements-$(date +%Y%m%d%H%M%S)"
install -d -m 700 "$backup"
cp -a /opt/kua-yipu-auth/auth-server /opt/kua-yipu-auth/package.json /opt/kua-yipu-auth/package-lock.json "$backup/"
cp -a /opt/kua-yipu-auth/node_modules "$backup/node_modules"
nginx_file=$(readlink -f /etc/nginx/sites-enabled/kua-yipu)
cp -a "$nginx_file" "$backup/nginx.conf"
set -a
source /etc/kua-yipu/auth.env
set +a
database=$(node --input-type=module -e 'console.log(decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1)))')
[[ "$database" =~ ^[a-zA-Z0-9_]+$ ]] || exit 1
runuser -u postgres -- pg_dump --format=custom --dbname "$database" > "$backup/database.dump"
rollback() {
  trap - ERR
  cp -a "$backup/auth-server/." /opt/kua-yipu-auth/auth-server/
  cp -a "$backup/package.json" "$backup/package-lock.json" /opt/kua-yipu-auth/
  cp -a "$backup/node_modules/." /opt/kua-yipu-auth/node_modules/
  cp -a "$backup/nginx.conf" "$nginx_file"
  nginx -t && systemctl reload nginx
  systemctl restart kua-yipu-auth
  echo "Announcement update rolled back; backup: $backup" >&2
}
trap rollback ERR
runuser -u postgres -- psql --set ON_ERROR_STOP=1 --dbname "$database" < auth-server/schema.sql >/dev/null
cp -a node_modules/. /opt/kua-yipu-auth/node_modules/
install -m 644 package.json package-lock.json /opt/kua-yipu-auth/
install -m 644 auth-server/{index,policy,announcement-content,announcement-images,admin,admin-announcements,admin-pages,http-security}.js auth-server/{admin.html,admin.css,schema.sql} /opt/kua-yipu-auth/auth-server/
chown -R kua-yipu:kua-yipu /opt/kua-yipu-auth/node_modules
chown kua-yipu:kua-yipu /opt/kua-yipu-auth/package*.json /opt/kua-yipu-auth/auth-server/*.{js,css,html,sql}
install -d -m 700 -o kua-yipu -g kua-yipu /var/lib/kua-yipu/updates/announcement-images
node tools/deploy-announcement-proxy.mjs "$nginx_file"
nginx -t
systemctl restart kua-yipu-auth
for attempt in {1..20}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:8790/health >/dev/null; then
    systemctl reload nginx
    echo "Announcement update completed; backup: $backup"
    exit 0
  fi
  sleep 1
done
rollback
exit 1
