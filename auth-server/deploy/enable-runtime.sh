#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || exit 1
[[ ${1:-} == isolated-tests-passed ]] || { echo 'Run isolated tests with the new runtime first'; exit 1; }
backup="/var/backups/kua-yipu-runtime-$(date +%Y%m%d%H%M%S)"
install -d -m 700 "$backup"
target=/etc/systemd/system/kua-yipu-auth.service.d/runtime.conf
install -d -m 755 "$(dirname "$target")"
if [[ -f "$target" ]]; then cp -a "$target" "$backup/runtime.conf"; fi
rollback() {
  trap - ERR
  if [[ -f "$backup/runtime.conf" ]]; then cp -a "$backup/runtime.conf" "$target"; else rm -f "$target"; fi
  systemctl daemon-reload
  systemctl restart kua-yipu-auth
  echo "Runtime update rolled back: $backup" >&2
}
trap rollback ERR
install -m 644 "$(dirname "$0")/runtime.conf" "$target"
systemctl daemon-reload
systemctl restart kua-yipu-auth
for attempt in {1..20}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:8790/health; then
    echo "Runtime updated. Backup: $backup"
    exit 0
  fi
  sleep 1
done
rollback
exit 1
