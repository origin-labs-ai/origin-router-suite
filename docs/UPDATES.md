# Updates and release feed

## How an installed build updates itself

The installer build carries `install.json` next to `cli.js`:

```json
{
  "mode": "installer",
  "name": "origin-router",
  "version": "0.5.115",
  "updateRepo": "origin-labs-ai/origin-router-suite"
}
```

At startup the launcher asks that repository's release feed:

```text
https://api.github.com/repos/origin-labs-ai/origin-router-suite/releases/latest
```

When `tag_name` is newer than the installed version and the release carries
`OriginRouter-Setup-<version>.exe`, the updater:

1. downloads the asset to `%TEMP%`,
2. verifies it against `OriginRouter-Setup-<version>.exe.sha256` (or a `checksums.sha256` /
   `sha256sums.txt` asset — the first 64-hex value in it is the expected digest), and
   refuses to install on a mismatch,
3. stops the running server/tray processes,
4. launches a detached helper that runs the installer with
   `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-`,
5. relaunches `originrouter.cmd --tray --skip-update`.

The per-user installer needs no UAC, and the old process exits as soon as the helper is
spawned. Every step is appended to `~/.or/updates.log`.

`--skip-update` disables the check for one launch. `install.json` is what tells the launcher
it is an installed build — keep it next to `cli.js`, `src`, `hooks`, `or.cmd`,
`originrouter.cmd` and the bundled `app` folder.

The dashboard's own version probe (`GET /api/version`) uses the same release feed. It used
to query the npm registry for a package that has never been published, which made the
answer permanently "unknown" while the sidebar still offered `npm i -g` as the fix.

## What a release contains

| Asset | Built by |
|---|---|
| `OriginRouter-Setup-<version>.exe` + `.sha256` | gateway + dashboard installer (Inno Setup) |
| `OriginRouter-Desktop-Setup-<version>.exe` + `.sha256` | desktop window installer (electron-builder unpacked dir, then Inno) |
| `origin-router-<version>.tgz` | CLI launcher package (`npm pack`) |
| `checksums.sha256` | aggregate digests of all three |

Version numbers must match across root, `cli/` and `desktop/` `package.json` — the Docker
workflow refuses a tag that disagrees, and `scripts/build-installer.ps1` takes its default
from `package.json` so a build cannot mislabel itself.

## Publishing a release

1. Bump the three `package.json` versions and add a `CHANGELOG.md` section.
2. Commit, push, tag:

   ```powershell
   git push origin main
   git tag v<version>
   git push origin v<version>
   ```

3. `.github/workflows/release.yml` builds all three artifacts on a Windows runner, writes
   the `.sha256` files and opens the GitHub Release with them.
4. `.github/workflows/docker-publish.yml` builds the multi-platform image on the same tag:
   GHCR always, Docker Hub only when `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` exist.

Creating a tag does not publish anything from your working tree by itself, and building the
installers locally is still supported (see [INSTALL.md](INSTALL.md)); if you release
manually, `gh release create v<version> <assets…> --target main` attaches the same files.

## Desktop app

The Electron window has no background updater of its own. Run the newer desktop installer
over the existing install — the bundled gateway and window files are replaced, `~/.or` is
not touched. The server installer's self-update covers the gateway that both front ends use.

## Manual update / rollback

Run any newer (or older) installer over the current install:

```powershell
Start-Process -FilePath ".\OriginRouter-Setup-<version>.exe" `
  -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-' -Wait
```

Settings, chats and `~/.or` survive. If a release should stop offering an update, delete
its installer asset from the release or move `latest` by releasing the version you want
current.

## Troubleshooting

| Symptom | Check |
|---|---|
| Banner never appears | `~/.or/updates.log`; the feed needs the release to carry `OriginRouter-Setup-<v>.exe` |
| `Installer checksum mismatch` | the release's `.sha256` no longer matches the asset — re-upload the built installer, do not edit the hash |
| Update loop | the tag version and `package.json` versions disagree, so each start looks outdated |
| Nothing updates at all | launched with `--skip-update`, or `install.json` missing next to `cli.js` (treated as a source install) |
