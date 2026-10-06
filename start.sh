#!/usr/bin/env bash
# start.sh - install dependencies and run the RAT (Repo Analysis Tool) server.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js (>= 18) is required but was not found on PATH." >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "ERROR: git is required but was not found on PATH." >&2
  exit 1
fi

NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js >= 18 is required (found $(node --version))." >&2
  exit 1
fi

mkdir -p data

if [ ! -d node_modules ] || [ ! -d node_modules/express ]; then
  echo "Installing dependencies..."
  npm install --no-audit --no-fund
fi

echo
echo "Starting RAT on http://localhost:3000"
echo
exec node server/index.js
