#!/usr/bin/env bash
# Forces Compose V2 CLI. Aborts if only legacy v1 docker-compose is found.
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not installed" >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  exec docker compose -f compose.yaml -p crypto-screener up -d --build "$@"
fi

if command -v docker-compose >/dev/null 2>&1; then
  echo "ERROR: only legacy docker-compose v1 detected. Install the Compose V2 plugin:"
  echo "  Debian/Ubuntu:  sudo apt update && sudo apt install docker-compose-plugin"
  echo "  Manual plugin:  https://docs.docker.com/compose/install/linux/"
  echo "After install, use 'docker compose' (space, not hyphen)."
  exit 2
fi

echo "ERROR: Docker and Compose V2 are required." >&2
exit 1
