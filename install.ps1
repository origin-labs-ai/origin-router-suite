# OriginRouter installer (Windows)
# Usage: irm https://raw.githubusercontent.com/origin-labs-ai/origin-router-suite/main/install.ps1 | iex
#
# The npm package is the nicest way in - it gives you the `originrouter`
# launcher. When npm cannot reach the package, the release installer from
# GitHub takes over, and it needs neither npm nor admin rights.
#
# Options when you run it from a file (not through the one-liner):
#   -Version <tag>   install a specific release, e.g. v0.5.117
#   -Portable        unzip the portable build instead of using npm or the installer
#   -SkipRun         download and verify only, install nothing

[CmdletBinding()]
param(
  [string]$Version = "",
  [switch]$Portable,
  [switch]$SkipRun
)

$ErrorActionPreference = "Stop"
$Repo = "origin-labs-ai/origin-router-suite"
$Headers = @{ "User-Agent" = "OriginRouter-Installer" }

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "    $Message" -ForegroundColor Green }

function Get-LatestRelease {
  if ($Version) {
    $tag = if ($Version.StartsWith("v")) { $Version } else { "v$Version" }
    return Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$tag" -Headers $Headers
  }
  return Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $Headers
}

function Get-VerifiedFile {
  param(
    [object]$Asset,
    [object[]]$Assets
  )
  # Download the asset and check it against the checksum the release ships.
  $work = Join-Path $env:TEMP "originrouter-$($Asset.name)"
  if (Test-Path $work) { Remove-Item -Recurse -Force $work }
  New-Item -ItemType Directory -Force -Path (Split-Path $work) | Out-Null
  $file = Join-Path (Split-Path $work) $Asset.name

  Write-Step "Downloading $($Asset.name)"
  $progress = $ProgressPreference
  $ProgressPreference = "SilentlyContinue"
  try {
    Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $file -UseBasicParsing
  } finally {
    $ProgressPreference = $progress
  }

  $shaAsset = $Assets | Where-Object { $_.name -eq "$($Asset.name).sha256" } | Select-Object -First 1
  if ($shaAsset) {
    Write-Step "Verifying the checksum"
    $expected = ((Invoke-RestMethod -Uri $shaAsset.browser_download_url -Headers $Headers) -split "\s+")[0].Trim().ToLower()
    $actual = (Get-FileHash -Path $file -Algorithm SHA256).Hash.ToLower()
    if (-not $expected -or $expected -ne $actual) {
      throw "The checksum does not match - the download was damaged. Nothing was installed."
    }
    Write-Ok "SHA256 matches"
  } else {
    Write-Host "    No checksum published for this asset - continuing anyway" -ForegroundColor Yellow
  }

  return $file
}

# ── portable: no npm, no installer, just the folder ─────────────────────────
if ($Portable) {
  Write-Step "Looking for the latest release"
  $release = Get-LatestRelease
  $version = $release.tag_name -replace "^v", ""
  $assets = @($release.assets)
  $asset = $assets | Where-Object { $_.name -eq "OriginRouter-win-portable.zip" } | Select-Object -First 1
  if (-not $asset) { throw "The release $version has no OriginRouter-win-portable.zip." }

  if ($SkipRun) { Write-Ok "Ready to download $($asset.name)"; return }

  $file = Get-VerifiedFile -Asset $asset -Assets $assets
  $target = Join-Path $env:LOCALAPPDATA "Programs\OriginRouter"
  Write-Step "Unpacking into $target"
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Expand-Archive -Path $file -DestinationPath $target -Force
  $launcher = Get-ChildItem -Path $target -Filter "originrouter.cmd" -Recurse | Select-Object -First 1
  if (-not $launcher) { throw "The portable build has no originrouter.cmd." }
  Write-Ok "Installed"
  Write-Host ""
  Write-Host "Start it with: `"$($launcher.FullName)`"" -ForegroundColor Green
  Write-Host "Dashboard: http://localhost:20128/dashboard" -ForegroundColor Green
  return
}

# ── npm: the nicest path, when it is available ──────────────────────────────
$node = Get-Command node -ErrorAction SilentlyContinue
$npmUsable = $false
if ($node) {
  $major = [int](& node -p "process.versions.node.split('.')[0]")
  if ($major -lt 18) {
    Write-Host "Node.js 18+ is required (found $(& node -v))." -ForegroundColor Red
    exit 1
  }
  $npmUsable = $true
}

if ($npmUsable -and -not $SkipRun) {
  Write-Step "Installing OriginRouter from npm"
  & npm install -g @origin-labs-ai/origin-router@latest --prefer-online
  if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "Done. Start it with:" -ForegroundColor Green
    Write-Host "  originrouter"
    Write-Host "Dashboard: http://localhost:20128/dashboard"
    exit 0
  }
  Write-Host "The npm package is not reachable - falling back to the release installer." -ForegroundColor Yellow
} elseif (-not $npmUsable) {
  Write-Host "Node.js 18+ was not found - using the release installer instead." -ForegroundColor Yellow
}

# ── the release installer: always there, needs no npm and no admin rights ───
Write-Step "Looking for the latest release"
$release = Get-LatestRelease
$version = $release.tag_name -replace "^v", ""
$assets = @($release.assets)
$asset = $assets | Where-Object { $_.name -eq "OriginRouter-Setup-$version.exe" } | Select-Object -First 1
if (-not $asset) {
  throw "The release $version has no OriginRouter-Setup-$version.exe."
}

if ($SkipRun) { Write-Ok "Ready to download $($asset.name)"; return }

$file = Get-VerifiedFile -Asset $asset -Assets $assets

Write-Step "Running the installer"
# MERGETASKS keeps the installer at its lowest privileges and still selects the
# startup entry, so the gateway is up before the first tool call - the same
# thing the graphical installer does.
$process = Start-Process -FilePath $file -ArgumentList "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-", "/MERGETASKS=autostart" -Wait -PassThru
if ($process.ExitCode -ne 0) {
  throw "The installer exited with code $($process.ExitCode)."
}

Write-Host ""
Write-Host "Done. Start it with:" -ForegroundColor Green
Write-Host "  originrouter"
Write-Host "Dashboard: http://localhost:20128/dashboard"
Write-Host "Your keys and settings live in $env:USERPROFILE\.or" -ForegroundColor DarkGray
