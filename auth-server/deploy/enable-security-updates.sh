#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || exit 1
backup="/var/backups/kua-yipu-security-updates-$(date +%Y%m%d%H%M%S)"
install -d -m 700 "$backup"
target=/etc/apt/apt.conf.d/52-kua-yipu-security-updates
if [[ -f "$target" ]]; then cp -a "$target" "$backup/apt.conf"; fi
install -m 644 "$(dirname "$0")/52-kua-yipu-security-updates" "$target"
apt-config dump | grep -E 'Unattended-Upgrade::(Allowed-Origins|Automatic-Reboot)'
echo "Security update configuration backup: $backup"
