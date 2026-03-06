#!/usr/bin/env bash
# One-click build and preview for SlurmClusterInsight.
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_ROOT"

PORT="${PORT:-4173}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required (>=18). Please install Node.js and rerun." >&2
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js >=18 is required. Found $(node -v)." >&2
  exit 1
fi

echo "Installing dependencies..."
npm install

echo "Building frontend..."
npm run build

echo "Starting full-stack server (API + static frontend) on 0.0.0.0:${PORT} ..."
echo "Logs will be written to logs/app.log. Use ./manage.sh status|logs to manage."
HOST=0.0.0.0 PORT="${PORT}" ./manage.sh start
