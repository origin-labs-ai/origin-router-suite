#!/usr/bin/env pwsh
# Build the Windows installer locally.
#   1. packages cli/app into dist/win
#   2. compiles installer/originrouter.iss with Inno Setup 6
param(
  [string]$Version = "0.5.111"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path "cli\app")) {
  throw "cli/app is missing. Run `npm run build` inside cli/ first."
}

node scripts/package-cli.mjs --platform=win

$iscc = @(
  "$env:ProgramFiles(x86)\Inno Setup 6\ISCC.exe",
  "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $iscc) {
  throw "Inno Setup 6 not found. Install it from https://jrsoftware.org/isdl.php"
}

& $iscc "installer\originrouter.iss" "/DAppVersion=$Version"
Write-Host "Installer written to dist\installer" -ForegroundColor Green
