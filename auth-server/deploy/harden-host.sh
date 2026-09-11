#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run with sudo'; exit 1; }
mode=${1:-prepare}
backup="/var/backups/kua-yipu-host-$(date +%Y%m%d%H%M%S)"
install -d -m 700 "$backup"
if [[ "$mode" == prepare ]]; then
  key=${2:?Public key file required}
  ssh-keygen -lf "$key" >/dev/null
  [[ $(wc -l < "$key") -eq 1 ]] || exit 1
  install -d -m 700 -o ubuntu -g ubuntu /home/ubuntu/.ssh
  authorized=/home/ubuntu/.ssh/authorized_keys
  if [[ -f "$authorized" ]]; then cp -a "$authorized" "$backup/authorized_keys"; fi
  touch "$authorized"
  if ! grep -qxF "$(cat "$key")" "$authorized"; then cat "$key" >> "$authorized"; fi
  chown ubuntu:ubuntu "$authorized"
  chmod 600 "$authorized"
  echo "Public key installed. Verify a separate key-only SSH connection before hardening. Backup: $backup"
elif [[ "$mode" == harden ]]; then
  # The caller must have verified the new key in a second SSH connection.
  [[ "${2:-}" == key-login-verified ]] || exit 1
  target=/etc/ssh/sshd_config.d/00-kua-yipu-security.conf
  if [[ -f "$target" ]]; then cp -a "$target" "$backup/sshd.conf"; fi
  install -m 644 "$(dirname "$0")/sshd-security.conf" "$target"
  if ! /usr/sbin/sshd -t; then
    if [[ -f "$backup/sshd.conf" ]]; then cp -a "$backup/sshd.conf" "$target"; else rm -f "$target"; fi
    exit 1
  fi
  systemctl reload ssh
  /usr/sbin/sshd -T | grep -E '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|maxauthtries|logingracetime) '
  echo "SSH hardening backup: $backup"
else
  echo 'Unknown mode' >&2
  exit 1
fi
