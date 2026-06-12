#!/usr/bin/env bash
set -euo pipefail
if docker compose version >/dev/null 2>&1; then
  exec docker compose -f compose.yaml -p crypto-screener logs -f --tail=200 "$@"
fi
echo "ERROR: legacy docker-compose v1 detected; install docker-compose-plugin (V2)." >&2
exit 2
