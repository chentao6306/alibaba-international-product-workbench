#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || exit 1
archive=node-v22.23.2-linux-x64.tar.xz
checksum=d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307
install -d -m 755 /opt/kua-yipu-runtime
download=$(mktemp -d /var/tmp/kua-yipu-node-XXXXXX)
curl --fail --silent --show-error --max-time 180 "https://nodejs.org/dist/v22.23.2/$archive" --output "$download/$archive"
printf '%s  %s\n' "$checksum" "$download/$archive" | sha256sum --check
tar --no-same-owner -xJf "$download/$archive" -C /opt/kua-yipu-runtime
/opt/kua-yipu-runtime/node-v22.23.2-linux-x64/bin/node --version
echo 'Runtime prepared; run isolated tests before installing runtime.conf.'
