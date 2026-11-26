#!/bin/sh
set -e

# Match the server's DATA_DIR default so permissions are repaired on the
# directory the app will actually use.
if [ -n "${DATA_DIR:-}" ]; then
  data_dir="$DATA_DIR"
elif [ "${NODE_ENV:-}" = "production" ]; then
  data_dir="/app/data"
else
  data_dir="/app"
fi

links_file="$data_dir/custom_links.json"

mkdir -p "$data_dir" 2>/dev/null || true

# A Docker-managed volume is normally writable already. A host bind mount can
# replace the image directory with another owner or mode, so repair it when
# possible. Never stop the app from starting when the mount is read-only.
chmod 777 "$data_dir" 2>/dev/null || true
if [ -f "$links_file" ]; then
  chmod 666 "$links_file" 2>/dev/null || true
fi

if ! touch "$data_dir/.write-test" 2>/dev/null; then
  echo "WARNING: $data_dir is not writable by UID $(id -u)." >&2
  echo "WARNING: Mount a Docker volume at $data_dir or make the host mount writable." >&2
else
  rm -f "$data_dir/.write-test" 2>/dev/null || true
fi

exec "$@"
