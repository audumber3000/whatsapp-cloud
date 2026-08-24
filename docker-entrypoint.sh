#!/bin/sh
# Redirect the app's runtime dirs onto a single mounted volume.
#
# Railway allows only ONE volume per service, but the app writes to three
# places (data/, sessions/, uploads/). When a volume is present we point all
# three at it via symlinks. Without a volume mount path set (e.g. local
# docker-compose, which bind-mounts each dir separately) this is a no-op.
set -e

VOL="${RAILWAY_VOLUME_MOUNT_PATH:-}"

if [ -n "$VOL" ]; then
  echo "[entrypoint] volume detected at $VOL — linking runtime dirs"
  for d in data sessions uploads; do
    mkdir -p "$VOL/$d"
    if [ ! -L "/app/backend/$d" ]; then
      rm -rf "/app/backend/$d"
      ln -sfn "$VOL/$d" "/app/backend/$d"
    fi
    echo "[entrypoint]   /app/backend/$d -> $VOL/$d"
  done
else
  echo "[entrypoint] no volume mount path set — using image-local dirs"
fi

exec node server.js
