#!/usr/bin/env bash
# Source as root during deployment. Preserve an existing private entry.
install -d -m 700 /etc/kua-yipu
install -d -m 755 /etc/systemd/system/kua-yipu-auth.service.d
if [[ ! -f /etc/kua-yipu/admin-entry.env ]]; then
  python3 - <<'PY'
import os, secrets
fd = os.open('/etc/kua-yipu/admin-entry.env', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
with os.fdopen(fd, 'w') as output:
    output.write('KUA_YIPU_ADMIN_PATH=/manage-' + secrets.token_hex(16) + '\n')
PY
fi
printf '%s\n' '[Service]' 'EnvironmentFile=/etc/kua-yipu/admin-entry.env' > /etc/systemd/system/kua-yipu-auth.service.d/admin-entry.conf
chmod 644 /etc/systemd/system/kua-yipu-auth.service.d/admin-entry.conf
