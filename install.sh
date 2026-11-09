#!/usr/bin/env bash
# OriginRouter installer (macOS / Linux)
# Usage: curl -fsSL https://raw.githubusercontent.com/origin-labs-ai/origin-router-suite/main/install.sh | bash
#
# Installs the portable build from the release, verified against the .sha256
# published next to it. No package registry and no admin rights.

set -euo pipefail

REPO="origin-labs-ai/origin-router-suite"
API="https://api.github.com/repos/${REPO}/releases/latest"

echo "==> Installing OriginRouter"

# ── the portable build: no registry, no admin rights ──────────────────────────
case "$(uname -s)" in
  Darwin) ASSET="OriginRouter-mac-portable.zip"; TARGET="$HOME/Applications/OriginRouter" ;;
  Linux)  ASSET="OriginRouter-linux-portable.zip"; TARGET="$HOME/.local/opt/origin-router" ;;
  *)
    echo "This script installs on macOS and Linux. On Windows use install.ps1." >&2
    exit 1
    ;;
esac

echo "==> Looking for the latest release"
RELEASE_JSON="$(curl -fsSL "$API")"
URL="$(printf '%s' "$RELEASE_JSON" | grep -o '"browser_download_url": *"[^"]*'"$ASSET"'"' | head -1 | cut -d'"' -f4)"
if [ -z "$URL" ]; then
  echo "No $ASSET found in the latest release." >&2
  exit 1
fi
SHA_URL="$(printf '%s' "$RELEASE_JSON" | grep -o '"browser_download_url": *"[^"]*'"$ASSET"'.sha256"' | head -1 | cut -d'"' -f4)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> Downloading $(basename "$URL")"
curl -fsSL "$URL" -o "$TMP/$ASSET"

if [ -n "$SHA_URL" ]; then
  echo "==> Verifying the checksum"
  EXPECTED="$(curl -fsSL "$SHA_URL" | awk '{print $1}' | tr 'A-Z' 'a-z')"
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "$TMP/$ASSET" | awk '{print $1}')"
  else
    ACTUAL="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
  fi
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "The checksum does not match - the download was damaged. Nothing was installed." >&2
    exit 1
  fi
  echo "    SHA256 matches"
fi

echo "==> Unpacking into $TARGET"
mkdir -p "$TARGET"
unzip -oq "$TMP/$ASSET" -d "$TARGET"
chmod +x "$TARGET/originrouter" 2>/dev/null || true

echo
echo "Done. Start it with:"
echo "  $TARGET/originrouter"
echo "Dashboard: http://localhost:20128/dashboard"
echo "Your keys and settings live in $HOME/.or"
