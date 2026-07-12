#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -f .env ]]; then
  echo "Missing .env. Copy .env.example to .env and configure ROOM_SECRET or ROOM_SECRETS first." >&2
  exit 1
fi
exec node src/index.js
