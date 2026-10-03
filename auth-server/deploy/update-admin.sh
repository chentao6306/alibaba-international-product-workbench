#!/usr/bin/env bash
# Run from a staging auth-server directory containing the five listed files.
# This changes code only; licenses, sessions and uploaded packages stay intact.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run as root' >&2; exit 1; }
source_dir=$(cd "$(dirname "$0")/.." && pwd)
target=/opt/kua-yipu-auth/auth-server
backup=/var/backups/kua-yipu-admin-$(date +%Y%m%d%H%M%S)
files=(admin.html admin.js admin.css admin-updates.js updates.js)
for name in "${files[@]}"; do [[ -f "$source_dir/$name" && -f "$target/$name" ]]; done
for name in admin.js admin-updates.js updates.js; do node --input-type=module --check < "$source_dir/$name"; done
install -d -m 700 "$backup"
for name in "${files[@]}"; do cp -a "$target/$name" "$backup/$name"; done
rollback() {
  trap - ERR
  for name in "${files[@]}"; do cp -a "$backup/$name" "$target/$name"; done
  systemctl restart kua-yipu-auth
  echo "Admin update failed; restored code from $backup" >&2
}
trap rollback ERR
for name in "${files[@]}"; do install -m 644 "$source_dir/$name" "$target/$name"; done
systemctl restart kua-yipu-auth
for attempt in {1..20}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:8790/health >/dev/null; then
    echo "Administration updated; backup: $backup"
    exit 0
  fi
  sleep 1
done
rollback
exit 1
