#!/usr/bin/env bash
# OriginRouter installer (macOS / Linux)
# Usage: curl -fsSL https://raw.githubusercontent.com/origin-labs-ai/origin-router-suite/main/install.sh | bash
#
# The npm package is the nicest way in - it gives you the `originrouter`
# launcher. When npm cannot reach the package, the portable build from the
# release takes over: it needs neither npm nor admin rights.

set -euo pipefail

REPO="origin-labs-ai/origin-router-suite"
API="https://api.github.com/repos/${REPO}/releases/latest"

echo "==> Installing OriginRouter"

# ── the npm package, when it is available ──────────────────────────────────
if command -v npm >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$MAJOR" -lt 18 ]; then
    echo "Node.js 18+ is required (found $(node -v))." >&2
    exit 1
  fi

  if npm install -g @origin-labs-ai/origin-router@latest --prefer-online; then
    echo
    echo "Done. Start it with:"
    echo "  originrouter"
    echo "Dashboard: http://localhost:20128/dashboard"
    exit 0
  fi
  echo "The npm package is not reachable - falling back to the portable build." >&2
else
  echo "Node.js 18+ was not found - using the portable build instead." >&2
fi

# ── the portable build: no npm, no admin rights ────────────────────────────
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
