#!/usr/bin/env pwsh
# Build the Windows installer locally.
#   1. packages cli/app into dist/win
#   2. compiles installer/originrouter.iss with Inno Setup 6
param(
  # Deliberately not a literal: a hardcoded default is a version that drifts, and a
  # mislabelled build is an update that the installed app will never offer. Pass
  # -Version to override (CI names the installer after the tag instead).
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $Version) {
  $Version = (Get-Content package.json -Raw | ConvertFrom-Json).version
  if (-not $Version) { throw "Could not read a version from package.json and none was passed." }
  Write-Host "Version taken from package.json: $Version" -ForegroundColor Cyan
}

if (-not (Test-Path "cli\app")) {
  throw "cli/app is missing. Run `npm run build` inside cli/ first."
}

node scripts/package-cli.mjs --platform=win

$iscc = @(
  # ${env:...} is required: "$env:ProgramFiles(x86)" expands to "C:\Program Files(x86)"
  # (the parentheses are literal text), so the lookup always missed a real install.
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "${env:ProgramFiles}\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $iscc) {
  throw "Inno Setup 6 not found. Install it from https://jrsoftware.org/isdl.php"
}

& $iscc "installer\originrouter.iss" "/DAppVersion=$Version"
Write-Host "Installer written to dist\installer" -ForegroundColor Green
