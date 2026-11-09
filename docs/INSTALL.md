# Install, update and auto-start

## Recommended: Windows installers

Two per-user installers ship from this repository, on the
[releases page](https://github.com/origin-labs-ai/origin-router/releases/latest):

| Artifact | Purpose |
|---|---|
| `OriginRouter-Setup-<version>.exe` | Gateway + dashboard; adds `or` / `originrouter`; auto-start and auto-update. |
| `OriginRouter-Desktop-Setup-<version>.exe` | Electron desktop window with the same UI; bundles its own gateway copy. |

Double-click, or run from the folder you downloaded to:

```powershell
.\OriginRouter-Setup-<version>.exe
.\OriginRouter-Desktop-Setup-<version>.exe
```

### Server installer

- Installs per-user: `%LOCALAPPDATA%\Programs\OriginRouter` (no admin, no UAC).
- Start Menu shortcut, optional desktop shortcut.
- Auto-start entry: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\OriginRouter`
  → `"...\originrouter.cmd" --tray`, written when the autostart task is selected (it is by
  default). An older `originrouter.vbs` Startup entry is deleted so only one copy starts.
- Adds its folder to the user `PATH`, so a **new** terminal resolves `or` or `originrouter`.
- Installed builds self-update from GitHub Releases (see [UPDATES.md](UPDATES.md)).

### Desktop installer

- Installs per-user: `%LOCALAPPDATA%\Programs\OriginRouter Desktop`.
- Start Menu shortcut **OriginRouter Desktop**; the window title is exactly **OriginRouter**.
- Bundles the gateway at `resources\server` and starts it on `127.0.0.1:20128` with the
  **system Node** runtime (Electron's embedded Node lacks the SQLite driver ABI). If a
  gateway is already running, the window attaches to it instead of starting a second one.
- Starts the PandaOrchestrator brain when that service is installed, resolving it from
  `OR_PANDA_SERVE`, then `~\Tools\PandaOrchestrator`, then
  `%LOCALAPPDATA%\Programs\PandaOrchestrator`, then a copy shipped with the app. Its output
  goes to `~/.or/panda/panda.log` / `panda.err.log`; when it is absent the router keeps
  routing with its own ordering and the settings panel reports which brains are live.
- Registers itself as a login item on first run; closing the window stops only the gateway
  copy it started itself.

### Silent install (what the updater also does)

```powershell
Start-Process -FilePath ".\OriginRouter-Setup-<version>.exe" `
  -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-' -Wait
```

Both installers run with `CloseApplications=force`, so a running instance is closed instead
of blocking the upgrade with a dialog.

## Commands

| Command | Effect |
|---|---|
| `or` / `originrouter` | menu + tray launcher |
| `or --tray` | start gateway + tray without the menu |
| `or --skip-update` | start without touching the release feed for this run |

`where or` / `Get-Command or -All` show which copy a shell resolved if you also have a
source checkout on `PATH`.

## Port already in use

```text
Error: listen EADDRINUSE: address already in use 0.0.0.0:20128
```

The launcher finds the listener with `%SystemRoot%\System32\netstat.exe` and kills it with
`%SystemRoot%\System32\taskkill.exe`; stale `node.exe` helpers are found through WMI via
the absolute PowerShell path. On an old build, close the tray icon (or reboot once) and
start the new build. No `PATH` configuration is required — current builds never call bare
`powershell`, `netstat` or `taskkill`.

## Phone / LAN access

Endpoint page → **Allow access from this network**.

- ON: devices on the same network open the URL shown on the card, e.g.
  `http://10.117.175.241:20128`; login is still required.
- OFF: non-loopback private peers get HTTP 403 (`LAN access is disabled`).
- Tunnel / Tailscale exposure is a separate toggle.

If a phone cannot connect: check both devices are on the same network, allow TCP 20128 for
Node.js in Windows Defender Firewall on **Private** networks, make sure the server was not
started with `--host 127.0.0.1`, and remember that guest/isolated Wi-Fi often blocks
client-to-client traffic.

## Installing the CLI launcher

The launcher ships with the installer and the portable zips; there is no
package registry in the install path. The Windows installer puts `originrouter`
and `or` on your `PATH` as part of the install, and the portable build carries
the same launcher.

To build the launcher from the repository instead:

```powershell
npm install --prefix cli
npm run build --prefix cli
Push-Location cli; npm pack; Pop-Location   # -> cli/origin-router-<version>.tgz
```

Either way the commands it puts on your `PATH` are `originrouter` and `or`.

## Building the installers locally

Needs Node 22+ and [Inno Setup 6](https://jrsoftware.org/isdl.php). Run from the repository
root; the version is read from `package.json`.

```powershell
npm install
npm run build
.\scripts\build-installer.ps1                      # -> dist\installer\OriginRouter-Setup-<version>.exe

npm install --prefix desktop
npm run dist:win --prefix desktop                   # -> dist\installer\OriginRouter-Desktop-Setup-<version>.exe
```

`.github/workflows/release.yml` runs the same steps on a `v*` tag and attaches the
artifacts plus their `.sha256` files to the release.

## Data

| Path | Contents |
|---|---|
| `~/.or` | database (`db/data.sqlite` + `db/backups`), keys, logs, cache, `updates.log` |
| `~/.or/desktop` | desktop window bounds and Electron profile |
| `~/.or/panda` | PandaOrchestrator brain state + logs |
| `~/.fusion/.or` | mirrored copy of `~/.or` kept by `dataMirror.js` |

Uninstalling either installer leaves `~/.or` untouched; delete it to reset completely.
