#!/usr/bin/env bash
# One-shot bootstrap for Debian/Ubuntu/Fedora/Alpine:
#   - Install Docker Engine if missing
#   - Install Docker Compose V2 plugin
#   - Drop legacy docker-compose v1 binary
#   - Bring the crypto-screener stack up
# Run as root (uses sudo internally).
set -euo pipefail

if [ "$(id -u)" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
  echo "FATAL: need root or sudo." >&2
  exit 1
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO=sudo; fi

. /etc/os-release 2>/dev/null || true
DISTRO="${ID:-unknown}"

install_docker_apt() {
  export DEBIAN_FRONTEND=noninteractive
  $SUDO apt-get update
  $SUDO apt-get install -y ca-certificates curl gnupg
  $SUDO install -m 0755 -d /etc/apt/keyrings
  $SUDO curl -fsSL https://download.docker.com/linux/${ID}/gpg | $SUDO gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  $SUDO chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
  $SUDO apt-get update
  $SUDO apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

install_docker_dnf() {
  $SUDO dnf -y install dnf-plugins-core
  $SUDO dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
  $SUDO dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  $SUDO systemctl enable --now docker
}

install_docker_apk() {
  $SUDO apk add --no-cache docker docker-compose
  $SUDO rc-update add docker default || true
  $SUDO service docker start || true
}

if ! command -v docker >/dev/null 2>&1; then
  echo ">>> Installing Docker Engine"
  case "$DISTRO" in
    ubuntu|debian) install_docker_apt ;;
    fedora|rhel|centos|rocky|almalinux) install_docker_dnf ;;
    alpine) install_docker_apk ;;
    *) echo "Unsupported distro '$DISTRO'. Install docker manually: https://docs.docker.com/engine/install/" >&2; exit 1 ;;
  esac
  if command -v systemctl >/dev/null 2>&1; then $SUDO systemctl enable --now docker; fi
  $SUDO usermod -aG docker "${SUDO_USER:-${USER:-root}}" 2>/dev/null || true
else
  echo ">>> docker already installed: $(docker --version)"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SCRIPT_DIR/install-compose-v2.sh"
$SUDO docker compose version

cd "$(dirname "$SCRIPT_DIR")"
echo ">>> Removing any stale docker-compose v1 containers"
$SUDO "$SCRIPT_DIR/cleanup-v1.sh" || true
echo ">>> docker compose up -d --build"
$SUDO docker compose -f compose.yaml -p crypto-screener up -d --build --remove-orphans

echo
$SUDO docker compose -f compose.yaml -p crypto-screener ps
