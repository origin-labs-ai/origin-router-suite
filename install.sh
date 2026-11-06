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

REPO="origin-labs-ai/origin-router-suite"

echo "Installing OriginRouter..."
if npm install -g @origin-labs-ai/origin-router@latest --prefer-online; then
  :
else
  # The npm package is the primary path, but it is not published for every
  # version yet. The release tarball is the fallback that always exists.
  echo "npm package unavailable - falling back to the release tarball." >&2
  API="https://api.github.com/repos/${REPO}/releases/latest"
  URL="$(curl -fsSL "$API" | grep -o '"browser_download_url": *"[^"]*origin-router-[^"]*\.tgz"' | head -1 | cut -d'"' -f4)"
  if [ -z "$URL" ]; then
    echo "No release tarball found for the latest release." >&2
    exit 1
  fi
  TMP="$(mktemp -d)"
  curl -fsSL "$URL" -o "$TMP/origin-router.tgz"
  npm install -g "$TMP/origin-router.tgz"
  rm -rf "$TMP"
fi

echo
echo "Done. Start it with:"
echo "  originrouter"
echo "Dashboard: http://localhost:20128"
