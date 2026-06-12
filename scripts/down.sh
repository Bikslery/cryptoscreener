#!/usr/bin/env bash
set -euo pipefail
if docker compose version >/dev/null 2>&1; then
  exec docker compose -f compose.yaml -p crypto-screener down --remove-orphans "$@"
fi
echo "ERROR: Compose V2 plugin missing. Run: ./scripts/install-compose-v2.sh  (or: sudo make bootstrap)" >&2
exit 2
