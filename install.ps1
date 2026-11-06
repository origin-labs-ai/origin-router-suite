# OriginRouter installer (Windows)
# Usage: irm https://raw.githubusercontent.com/origin-labs-ai/origin-router/main/install.ps1 | iex

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
& npm install -g @origin-labs-ai/origin-router@latest --prefer-online
if ($LASTEXITCODE -ne 0) {
  # The npm package is the primary path, but it is not published for every
  # version yet. The release installer is the fallback that always exists.
  Write-Host "npm package unavailable - falling back to the release installer." -ForegroundColor Yellow
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/origin-labs-ai/origin-router/releases/latest" -Headers @{ "User-Agent" = "OriginRouter-Installer" }
  $asset = $release.assets | Where-Object { $_.name -like "OriginRouter-Setup-*.exe" } | Select-Object -First 1
  if (-not $asset) {
    Write-Host "No Windows installer found in the latest release ($($release.tag_name))." -ForegroundColor Red
    exit 1
  }
  $installer = Join-Path $env:TEMP $asset.name
  Write-Host "Downloading $($asset.name)..." -ForegroundColor Cyan
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installer
  Write-Host "Running the installer..." -ForegroundColor Cyan
  $process = Start-Process -FilePath $installer -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    Write-Host "Installer failed with exit code $($process.ExitCode)." -ForegroundColor Red
    exit $process.ExitCode
  }
  Write-Host ""
  Write-Host "Done. Start it with:" -ForegroundColor Green
  Write-Host "  originrouter"
  Write-Host "Dashboard: http://localhost:20128"
  exit 0
}

Write-Host ""
Write-Host "Done. Start it with:" -ForegroundColor Green
Write-Host "  originrouter"
Write-Host "Dashboard: http://localhost:20128"
