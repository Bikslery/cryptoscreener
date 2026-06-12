#!/usr/bin/env bash
# Install Docker Compose V2 (Go-based CLI plugin). Idempotent.
# Drops the legacy docker-compose v1 python package to prevent confusion.
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "FATAL: 'docker' is not installed." >&2
  echo "       Install Docker Engine first: https://docs.docker.com/engine/install/" >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  echo "Compose V2 already installed: $(docker compose version --short 2>/dev/null || docker compose version)"
  exit 0
fi

. /etc/os-release 2>/dev/null || true
DISTRO="${ID:-unknown}"

install_v2_apt() {
  export DEBIAN_FRONTEND=noninteractive
  if ! command -v curl >/dev/null 2>&1; then apt-get update && apt-get install -y curl ca-certificates; fi
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/${ID}/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-compose-plugin
}

install_v2_dnf() {
  dnf -y install dnf-plugins-core
  dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
  dnf -y install docker-compose-plugin
}

install_v2_apk() {
  apk add --no-cache docker-compose
}

case "$DISTRO" in
  ubuntu|debian) install_v2_apt ;;
  fedora|rhel|centos|rocky|almalinux) install_v2_dnf ;;
  alpine) install_v2_apk ;;
  *)
    echo "Unsupported distro '$DISTRO'. Falling back to manual plugin install." >&2
    mkdir -p ~/.docker/cli-plugins
    curl -fsSL https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-$(uname -s)-$(uname -m) \
      -o ~/.docker/cli-plugins/docker-compose
    chmod +x ~/.docker/cli-plugins/docker-compose
    ;;
esac

if docker compose version >/dev/null 2>&1; then
  echo "Compose V2 installed: $(docker compose version)"
else
  echo "FATAL: Compose V2 plugin installation failed." >&2
  exit 1
fi

case "$DISTRO" in
  ubuntu|debian)
    if dpkg -l docker-compose 2>/dev/null | grep -q '^ii'; then
      apt-get remove -y docker-compose || true
      echo "Removed legacy docker-compose v1 package."
    fi
    ;;
esac
if command -v pip >/dev/null 2>&1 && pip show docker-compose >/dev/null 2>&1; then
  pip uninstall -y docker-compose || true
  echo "Removed legacy docker-compose v1 pip package."
fi

echo "Done. Use 'docker compose' (space) — not 'docker-compose' (hyphen)."
