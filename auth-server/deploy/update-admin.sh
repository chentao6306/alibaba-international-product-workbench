#!/usr/bin/env bash
# Run from a reviewed full source checkout. Account and entry changes require
# the matching server modules; use the complete service deployment and backup.
# This changes code only; licenses, sessions and uploaded packages stay intact.
set -euo pipefail
exec bash "$(dirname "$0")/update-service.sh"
