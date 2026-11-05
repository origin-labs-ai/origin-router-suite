# OriginRouter

Local AI gateway with a dashboard and playground for every connected provider, combo and
fallback. Everything runs on your machine; chats and router data stay local.

## Install (recommended)

There are **two** per-user Windows installers, both built from this repository:

| Installer | What it installs |
|---|---|
| `OriginRouter-Setup-0.5.114.exe` | Gateway + dashboard. Starts with Windows, self-updates, runs `or` / `originrouter`. |
| `OriginRouter-Desktop-Setup-0.5.114.exe` | Separate desktop window with the same dashboard UI. Bundles its own gateway copy and starts it with the system Node runtime. |

```powershell
cd C:\Users\thaku\Workspaces\side-projects\origin-router
.\dist\installer\OriginRouter-Setup-0.5.114.exe           # server + dashboard
.\dist\installer\OriginRouter-Desktop-Setup-0.5.114.exe   # desktop window
```

The desktop window title is simply **OriginRouter**; no “AI Infrastructure Management” tagline
is appended and no tagline is written into the window title. The server installer installs under
`%LOCALAPPDATA%\Programs\OriginRouter`; the desktop app installs under
`%LOCALAPPDATA%\Programs\OriginRouter Desktop`. No admin prompt and no manual `npm` commands are
required.

### Desktop window

- Same dashboard UI in a native Electron window.
- Bundles a copy of the gateway at `resources\server` and starts it on
  `http://127.0.0.1:20128` using the installed **system Node** (not Electron's embedded Node),
  which keeps `node:sqlite`/`sql.js` available and avoids the
  `[DB] No SQLite driver available` error.
- If the gateway is already running (server installer/tray), the window simply attaches to it.
- Window bounds are remembered in `~/.or/desktop/window-bounds.json`.
- Adds itself to login items on first run; the Start Menu shortcut is
  **OriginRouter Desktop**.

### Stop the desktop app's gateway

Closing the desktop window stops only the gateway copy it started itself. A gateway started by
the server installer/tray is left running.

Silent install/update:

```powershell
Start-Process -FilePath "C:\Users\thaku\Workspaces\side-projects\origin-router\dist\installer\OriginRouter-Setup-0.5.114.exe" `
  -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-' -Wait
```

After installing, use the Start Menu shortcut or open a **new** terminal (the installer adds
the app folder to your user `PATH`):

```powershell
or            # shortcut for originrouter
originrouter
```

Both commands start the gateway and tray icon. The old `9router` command is gone.

### Auto-start

The installer writes:

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Run
Name:  OriginRouter
Value: "...\OriginRouter\originrouter.cmd" --tray
```

The old startup VBS entry is removed during install and upgrade.

### Auto-update

Installed builds check `https://api.github.com/repos/origin-labs-ai/origin-router-suite/releases/latest`
at startup. When a newer release with a Windows installer is available, the app:

1. downloads `OriginRouter-Setup-<version>.exe` to `%TEMP%`,
2. verifies `<installer>.sha256` when the release publishes it,
3. stops the old server/helper processes,
4. runs the per-user installer silently (`/VERYSILENT`),
5. relaunches the new build in tray mode.

No terminal command and no UAC prompt is needed. Progress is written to:

```text
~/.or/updates.log
```

`--skip-update` disables the check for that launch. Auto-update is only active for the
installer build; global npm copies keep the manual update path.

## Install from source (development)

Run these commands **inside the repository** — `cd cli` fails if you start in
`C:\Users\thaku`, because `cli` is not in your home directory.

```powershell
cd C:\Users\thaku\Workspaces\side-projects\origin-router

# 1. Build the bundled app
node cli/scripts/build-cli.js

# 2. Pack the CLI (must run inside cli/, which has its own package.json)
Push-Location cli
npm pack
Pop-Location

# 3. Install the tarball using its full path
npm install -g "C:\Users\thaku\Workspaces\side-projects\origin-router\cli\originrouter-0.5.114.tgz"

# 4. Start
originrouter
```

Common mistakes:

| Error | Cause / fix |
|---|---|
| `cd : Cannot find path 'C:\Users\thaku\cli'` | You are not in the repo. `cd` into `C:\Users\thaku\Workspaces\side-projects\origin-router` first. |
| `npm error Invalid package, must have name and version` | `npm pack` ran in a folder without `package.json`. Run it inside `cli\`. |
| `ENOENT ... C:\Users\thaku\originrouter-0.5.114.tgz` | Use the full path to the tarball created in `cli\`. |
| `EADDRINUSE 0.0.0.0:20128` | An old server was still running. Current CLI kills it automatically; if you use an old build, close the tray/or run `originrouter` from the new install. |
| `'powershell' is not recognized` / `'netstat' is not recognized` | Fixed in the current launcher: Windows tools are resolved from `%SystemRoot%\System32` by absolute path. |

## LAN access (phones / other PCs)

Endpoint page → **Allow access from this network**.

- ON: devices on the same Wi-Fi/LAN can open the dashboard via the shown URL, e.g.
  `http://10.117.175.241:20128`. Login is still required.
- OFF: LAN requests get `403 — LAN access is disabled`; only this computer can connect.
- Tunnel/Tailscale access stays controlled by the separate **Allow dashboard access via tunnel**
  toggle.
- The URL is chosen from the real Wi-Fi/Ethernet adapter, not VMware, Bluetooth, WSL or
  `169.254.x.x` link-local addresses.

If the page does not open on the phone:

1. Make sure both devices are on the same Wi-Fi/LAN.
2. Allow **Node.js** or TCP port **20128** through Windows Defender Firewall
   (Private networks). The LAN toggle blocks application requests but does not create a
   firewall rule.
3. If the server was started with `--host 127.0.0.1`, restart without that flag.

## Playground

`/dashboard/playground` includes:

- **Model menu** grouped by provider, with every connected provider visible and
  **Show all N models** per group.
- **Thinking** and **Extended thinking** switches inside the model menu.
- **Max context limit** filter (`Any`, `32K`, `64K`, `128K`, `200K`, `256K`, `512K`, `1M`).
- Human-readable model names derived from ids (`glm-5.3-flash` → `GLM 5.3 Flash`); provider
  pages keep raw ids until you set a name.
- Compact composer, 12px user bubble, edit/delete/regenerate/copy actions.
- History with per-chat rename/delete and **Clear all** for every stored chat.
- Open-in-new-window button opens the standalone `/playground`.

## Models and context windows

Every model is advertised with a **1,000,000-token context floor** so combos can be built at
1M regardless of the conservative provider catalogue. Combos with an explicit ceiling still
publish that ceiling; member filtering and API validation use the same value.

## API keys and logs

- Endpoint → API Keys → pencil icon renames a key (the secret value does not change).
- Usage → Logs includes an **API Key** column with the current key name.
- Provider and account columns use the names you configured, not raw
  `openai-compatible-chat-…` ids.

## Data locations

| Data | Path |
|---|---|
| Router DB / settings | `~/.or` (mirrored to `~/.fusion/.or`) |
| Update log | `~/.or/updates.log` |
| Installer build | `%LOCALAPPDATA%\Programs\OriginRouter` |
| Installer output | `dist\installer\OriginRouter-Setup-<version>.exe` |

## Build the installer

```powershell
cd C:\Users\thaku\Workspaces\side-projects\origin-router
node cli/scripts/build-cli.js
node scripts/package-cli.mjs --platform win
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\originrouter.iss /DAppVersion=0.5.114
```

The installer includes the app bundle, CLI source, `or.cmd`, `install.json` marker and the
silent-updater metadata. Release CI (`.github/workflows/release.yml`) builds the same artifact
on a `v*` tag and publishes the `.exe` plus its `.sha256` checksum; the desktop installer and
the CLI tarball are added to that release from the machine that built them.

## Docs

- [docs/INSTALL.md](docs/INSTALL.md) — installer, silent update, PATH, firewall, troubleshooting
- [docs/FEATURES.md](docs/FEATURES.md) — LAN toggle, context filter, API keys and playground
- [docs/UPDATES.md](docs/UPDATES.md) — release feed, checksums and update logs
