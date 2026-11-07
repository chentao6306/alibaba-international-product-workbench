#!/usr/bin/env bash
# Deploy only the reviewed bulk-authorization feature. No license data changes.
set -euo pipefail
[[ $(id -u) == 0 ]] || exit 1
cd "$(dirname "$0")/.."
export PATH=/opt/kua-yipu-runtime/node-v22.23.2-linux-x64/bin:$PATH
files=(index.js admin-pages.js admin.html admin.js bulk-licenses.js admin-bulk-licenses.js)
for file in index.js admin-pages.js admin.js bulk-licenses.js admin-bulk-licenses.js; do node --input-type=module --check < "$file"; done
backup="/var/backups/kua-yipu-auth-bulk-$(date +%Y%m%d%H%M%S)"
install -d -m 700 "$backup"
cp -a /opt/kua-yipu-auth/auth-server "$backup/auth-server"
set -a
source /etc/kua-yipu/auth.env
set +a
database=$(node --input-type=module -e 'console.log(decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1)))')
[[ "$database" =~ ^[a-zA-Z0-9_]+$ ]] || exit 1
runuser -u postgres -- pg_dump --format=custom --dbname "$database" > "$backup/database.dump"
chmod 600 "$backup/database.dump"
rollback() {
  trap - ERR
  cp -a "$backup/auth-server/." /opt/kua-yipu-auth/auth-server/
  systemctl restart kua-yipu-auth
  echo "Deployment failed; previous code restored from $backup" >&2
}
trap rollback ERR
install -m 644 "${files[@]}" /opt/kua-yipu-auth/auth-server/
systemctl restart kua-yipu-auth
for attempt in {1..20}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:8790/health; then
    echo "Bulk authorization deployed; backup: $backup"
    exit 0
  fi
  sleep 1
done
rollback
exit 1
