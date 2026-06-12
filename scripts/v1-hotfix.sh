#!/usr/bin/env bash
# Hot-patch legacy docker-compose v1.29.x service.py to stop the
# "KeyError: 'ContainerConfig'" crash. Use ONLY when you cannot install
# the Compose V2 plugin (air-gapped, locked host, etc).
#
# Re-runnable. Replaces apt/pip-managed file on the system; reverted by
# any package upgrade that re-installs the file. Pin from future upgrades
# with `apt-mark hold python3-docker-compose` after applying.
set -euo pipefail

TARGET="/usr/lib/python3/dist-packages/compose/service.py"
BACKUP="${TARGET}.pre-hotfix"

for candidate in \
  /usr/lib/python3/dist-packages/compose/service.py \
  /usr/local/lib/python3/dist-packages/compose/service.py \
  /usr/lib/python3/site-packages/compose/service.py; do
  if [ -f "$candidate" ]; then TARGET="$candidate"; break; fi
done

if [ ! -f "$TARGET" ]; then
  echo "FATAL: cannot locate compose service.py on this host." >&2
  echo "        (Checked apt and pip paths.)" >&2
  exit 1
fi

if grep -q "image_config\['ContainerConfig'\]\.get" "$TARGET"; then
  echo "Hotfix already applied at $TARGET"
  exit 0
fi

cp -a "$TARGET" "$BACKUP"
sed -i "s|container\.image_config\['ContainerConfig'\]\.get|container.image_config.get('ContainerConfig', {}).get|" "$TARGET"

if grep -q "image_config\.get('ContainerConfig', {}).get" "$TARGET"; then
  echo "Hotfix applied to $TARGET (backup at $BACKUP)"
  if command -v apt-mark >/dev/null 2>&1; then
    apt-mark hold python3-docker-compose 2>/dev/null || true
  fi
  echo "Re-run your usual: docker-compose up -d --build"
else
  echo "FATAL: hotfix did not apply cleanly. Restore from $BACKUP." >&2
  exit 1
fi
