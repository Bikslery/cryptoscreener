#!/usr/bin/env bash
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not installed — run: make bootstrap" >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  exec docker compose -f compose.yaml -p crypto-screener up -d --build "$@"
fi

echo "============================================================" >&2
echo "ERROR: legacy 'docker-compose' v1 is installed; Compose V2 plugin is missing." >&2
echo "============================================================" >&2
echo "Pick ONE:" >&2
echo "  (a) Bootstrap:    sudo make bootstrap" >&2
echo "  (b) Just the plugin: ./scripts/install-compose-v2.sh" >&2
echo "  (c) Hotpatch v1 (NOT recommended):  sudo ./scripts/v1-hotfix.sh" >&2
exit 2
