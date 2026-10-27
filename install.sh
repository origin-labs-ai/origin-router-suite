#!/usr/bin/env bash
# OriginRouter installer (macOS / Linux)
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required: https://nodejs.org/en/download" >&2
  exit 1
fi

MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 18 ]; then
  echo "Node.js 18+ is required (found $(node -v))." >&2
  exit 1
fi

echo "Installing OriginRouter..."
npm install -g originrouter@latest --prefer-online

echo
echo "Done. Start it with:"
echo "  originrouter"
echo "Dashboard: http://localhost:20128"
