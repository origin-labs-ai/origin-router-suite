# OriginRouter installer (Windows)
# Usage: irm https://raw.githubusercontent.com/origin-labs-ai/originrouter/main/install.ps1 | iex

$ErrorActionPreference = "Stop"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js 18+ is required: https://nodejs.org/en/download" -ForegroundColor Red
  Start-Process "https://nodejs.org/en/download"
  exit 1
}

$major = [int](& node -p "process.versions.node.split('.')[0]")
if ($major -lt 18) {
  Write-Host "Node.js 18+ is required (found $(& node -v))." -ForegroundColor Red
  exit 1
}

Write-Host "Installing OriginRouter..." -ForegroundColor Cyan
& npm install -g originrouter@latest --prefer-online
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "Done. Start it with:" -ForegroundColor Green
Write-Host "  originrouter"
Write-Host "Dashboard: http://localhost:20128"
