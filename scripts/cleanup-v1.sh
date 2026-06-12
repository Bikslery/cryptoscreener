#!/usr/bin/env bash
# Remove stale docker-compose v1 containers (underscore-named) so Compose V2
# (hyphen-named) can take over the shared data volumes without conflict.
# No-op when none exist. Volumes are preserved — only containers are removed.
set -euo pipefail

stale="$(docker ps -aq --filter "name=crypto-screener_" 2>/dev/null || true)"
if [ -n "$stale" ]; then
  echo ">>> Removing stale docker-compose v1 containers:"
  docker ps -a --filter "name=crypto-screener_" --format '    {{.Names}}'
  docker rm -f $stale >/dev/null
  echo ">>> Done."
else
  echo ">>> No stale v1 containers found."
fi
