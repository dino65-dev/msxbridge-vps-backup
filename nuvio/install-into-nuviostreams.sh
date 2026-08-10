#!/usr/bin/env bash
set -euo pipefail

SELF_DIR="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &&
  pwd
)"

REPO_DIR="$(
  cd "$SELF_DIR/.." &&
  pwd
)"

NUVIO_DIR="${NUVIO_DIR:-$HOME/NuvioStreamsAddon}"

RUNTIME_ENV="${
  NUVIO_RUNTIME_ENV:-
  $NUVIO_DIR/.nuvio-runtime.env
}"

BRIDGE_ENV="${BRIDGE_ENV:-$REPO_DIR/.env}"

BRIDGE_URL="${
  NUVIO_MOVIEBOX_BRIDGE_URL:-
  http://nuvio-moviebox-bridge:8090
}"

SOURCE_PROVIDER="$SELF_DIR/MovieBoxBridgeProvider.js"

DEST_PROVIDER="$NUVIO_DIR/providers/moviebox.js"

echo "Nuvio directory:"
echo "  $NUVIO_DIR"
echo

if [ ! -d "$NUVIO_DIR" ]; then
  echo "ERROR: Nuvio directory does not exist:"
  echo "  $NUVIO_DIR"
  exit 1
fi

if [ ! -f "$RUNTIME_ENV" ]; then
  echo "ERROR: Nuvio runtime env not found:"
  echo "  $RUNTIME_ENV"
  exit 1
fi

if [ ! -f "$BRIDGE_ENV" ]; then
  echo "ERROR: bridge .env not found:"
  echo "  $BRIDGE_ENV"
  exit 1
fi

if [ ! -f "$SOURCE_PROVIDER" ]; then
  echo "ERROR: MovieBoxBridgeProvider.js missing."
  exit 1
fi

TOKEN="$(
  grep '^NUVIO_MOVIEBOX_BRIDGE_TOKEN=' \
    "$BRIDGE_ENV" |
  cut -d= -f2- ||
  true
)"

if [ -z "$TOKEN" ]; then
  echo "ERROR:"
  echo "NUVIO_MOVIEBOX_BRIDGE_TOKEN is missing"
  echo "from:"
  echo "  $BRIDGE_ENV"
  exit 1
fi

mkdir -p "$NUVIO_DIR/providers"

if [ -f "$DEST_PROVIDER" ]; then
  BACKUP="$DEST_PROVIDER.backup.$(date +%Y%m%d-%H%M%S)"

  cp \
    "$DEST_PROVIDER" \
    "$BACKUP"

  echo "Existing provider backed up:"
  echo "  $BACKUP"
fi

cp \
  "$SOURCE_PROVIDER" \
  "$DEST_PROVIDER"

echo
echo "Installed MovieBox bridge provider."

node --check "$DEST_PROVIDER"

python3 - \
  "$RUNTIME_ENV" \
  "$TOKEN" \
  "$BRIDGE_URL" <<'PY'
import sys
from pathlib import Path

env_path = Path(sys.argv[1])
token = sys.argv[2]
bridge_url = sys.argv[3]

updates = {
    "NUVIO_MOVIEBOX_BRIDGE_URL":
        bridge_url,

    "NUVIO_MOVIEBOX_BRIDGE_TOKEN":
        token,

    # MovieBox is supplied by the private
    # CloudStream bridge now.
    #
    # Do not load the broken external
    # MovieBox implementation as well.
    "NUVIO_REPO_PROVIDERS":
        "allwish,streamflix",

    "NUVIO_REPOS":
        (
            "https://raw.githubusercontent.com/"
            "phisher98/phisher-nuvio-providers/"
            "refs/heads/main/,"
            "https://raw.githubusercontent.com/"
            "yoruix/nuvio-providers/"
            "refs/heads/main/"
        ),
}

lines = env_path.read_text().splitlines()

out = []
seen = set()

for line in lines:
    if "=" in line:
        key = line.split("=", 1)[0]

        if key in updates:
            if key not in seen:
                out.append(
                    f"{key}={updates[key]}"
                )
                seen.add(key)

            continue

    out.append(line)

for key, value in updates.items():
    if key not in seen:
        out.append(
            f"{key}={value}"
        )

env_path.write_text(
    "\n".join(out) + "\n"
)
PY

chmod 600 "$RUNTIME_ENV"

unset TOKEN

echo
echo "Nuvio runtime configuration updated."
echo
echo "Bridge URL:"
grep '^NUVIO_MOVIEBOX_BRIDGE_URL=' \
  "$RUNTIME_ENV"

if grep -q \
  '^NUVIO_MOVIEBOX_BRIDGE_TOKEN=.' \
  "$RUNTIME_ENV"
then
  echo "Bridge token: SET"
else
  echo "Bridge token: MISSING"
  exit 1
fi

echo
echo "Checking Docker network..."

if ! sudo docker network inspect \
  stremio-net >/dev/null 2>&1
then
  echo "Creating stremio-net..."
  sudo docker network create \
    stremio-net >/dev/null
fi

echo "stremio-net: OK"

echo
echo "Installation complete."
echo
echo "IMPORTANT:"
echo "Rebuild/recreate the Nuvio container"
echo "so the new provider is included."
