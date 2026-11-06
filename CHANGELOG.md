# v0.5.117 (2026-11-06)

The product's name, links and documentation now match the product. Full working log: [docs/RELEASE-LOG.md](docs/RELEASE-LOG.md).

## Changes
- **The launcher's npm identity is `@origin-labs-ai/origin-router`** (`cli/package.json`), and the release tarball is `origin-router-<version>.tgz`. The package name is exactly "origin-router"; the scope only exists because the unscoped name on the registry belongs to an unrelated 2014 package that cannot be claimed. The GitHub repository slug stays `origin-labs-ai/origin-router-suite` — GitHub retired the shorter name for this organisation (`name has been retired and cannot be reused`), so a rename there is refused by the platform. The `originrouter` / `or` commands, the autostart entry and the install paths are unchanged, so existing installs keep working.
- **The Docker image is `ghcr.io/origin-labs-ai/origin-router-suite`.** It was derived from the repository slug, so it was published as `.../origin-router-suite` while every document said `.../origin-router`. The name is now explicit in the workflow.
- **The landing page pointed at somebody else's project.** Eleven GitHub links, two npm links and the copy-command in the landing page still pointed at a different repository — a visitor clicking **GitHub** or **Docs** on the product page was taken away from the product. All of them now point at this project. The same block also claimed the data lives in `~/.originrouter/db/data.sqlite`; it lives in `~/.or`, and the page now says so. The copyright year was 2025.
- **The product has a link preview now.** `public/og-image.png` is a 1200×630 card rendered from the real dashboard (`scripts/make-og-image.js`), and `src/app/layout.js` declares the Open Graph and Twitter card metadata that use it.
- **The README tells the whole story**: the routing brain and what its three signals are, the four combo strategies with what each costs, the token saver with measured numbers, the installer / CLI / desktop app / Docker surfaces, the endpoints, and what OriginRouter actually does differently — including the parts that are *not* differentiators, so the README never claims someone else's feature as ours.
- **Screenshots in both themes** — Providers, Combos and Token Saver in light and dark, in `images/`.
- **`install.ps1` no longer depends on npm.** It installs the npm package when it is available and falls back to the GitHub release installer when it is not, so the one-liner works either way.

## Fixes
- **The release workflow packs a scoped package**, which npm names `<scope>-<name>-<version>.tgz`; the asset is renamed to `origin-router-<version>.tgz` before it is checksummed and uploaded.
- **`bin` paths dropped by npm**: `"originrouter": "./cli.js"` is rejected by npm 10's publish validation, which removed *both* bin entries from the published package — a global install would have had no `originrouter` and no `or`. Now `"cli.js"`, verified with `npm publish --dry-run`.
- `tests/README.md` was still titled "OriginRouter Embeddings Tests", and `tests/translator/AGENTS.md` pointed at the old database path.

## Added
- `scripts/shoot-screenshots.js` — captures the dashboard in both themes.
- `scripts/make-og-image.js` — renders the social preview card.
- `docs/releases/<tag>.md` — curated release notes, picked up by the release workflow when present.

# v0.5.116 (2026-11-06)

Docker boot fix, API-key hardening, architecture docs that describe reality — and the two failures that kept this cut from shipping. Full working log: [docs/RELEASE-LOG.md](docs/RELEASE-LOG.md).

## Fixes
- **The Docker image answered 403 to its own host.** Inside a container the host's traffic to a published port is NAT-ed to the container's default gateway, and the LAN gate read that address as "another device on the network" — so `docker run -p 20128:20128` was unusable, the dashboard could not be opened to switch LAN access on, and the CI smoke test failed on both architectures. A new `src/lib/containerNetwork.js` resolves the container's default route from `/proc/net/route` and counts that one address as "this computer"; LAN devices keep their real IP and stay blocked. The lookup only runs when the image sets `OR_CONTAINER=1`. Covered by `tests/unit/container-network.test.js`.
- **The Windows release ran out of disk** (`ENOSPC` after 1h47m). The job carried a redundant root `npm run build`, the CLI build's own `.next-cli-build` tree and the root `node_modules` — none of which ship, because the installer only packages `cli/app` → `dist/win`. The job now builds the CLI bundle once and reclaims ~3.2 GB before packaging; it also prints free space so the next disk failure is visible.
- **Docker boot fix.** v0.5.115's GHCR images built for both architectures but died on startup — the standalone bundle ships `next/dist/server` code that imports `@swc/helpers` subpaths at runtime, file tracing omits the package, the health check never came up, and manifest publishing skipped. The Dockerfile now copies `@swc/helpers` + `@next/env` into the runner stage (same explicit-copy pattern already used for `next`, `sql.js` and `node-machine-id`).
- **API keys minted with real randomness + per-install secret.** `keyId` went from 6 `Math.random()` chars (~31 bits, predictable) to 16 `crypto.randomInt` chars (~2^83); the HMAC integrity digest uses `API_KEY_SECRET` if set, else an auto-generated secret persisted at `DATA_DIR/api-key-secret` (0600), instead of a constant baked into the source tree. Existing keys stay valid — request auth is an exact match against the `apiKeys` table; the digest is integrity-only.
- **`docs/ARCHITECTURE.md` describes the current storage model** — state and usage live in `${DATA_DIR}/db/data.sqlite` (default `DATA_DIR` is `~/.or`), not the doc's old `~/.originrouter` JSON files; the per-install API-key secret file is documented too.

## Changed
- **Release notes ship with the release.** `release.yml` picks up curated notes from `docs/releases/<tag>.md` when they exist, and falls back to the generated changelog when they do not.
- In-range dependency updates: undici 7.30.2, eslint-config-next 16.4.5. Major bumps deferred deliberately — a release cut is the wrong time to take chalk 6 / undici 8 / eslint 10 / better-sqlite3 13.

# v0.5.115 (2026-11-05)

Naming, docs and the machinery around releases. Full working log: [docs/RELEASE-LOG.md](docs/RELEASE-LOG.md).

## Changes
- **Packages are named `origin-router`**: `origin-router-app` (gateway), `origin-router` (CLI launcher), `origin-router-desktop` (window app), with the installer scripts now `installer/origin-router.iss` and `installer/origin-router-desktop.iss`. The `or` / `originrouter` commands, the `Programs\OriginRouter` install paths and the Inno `AppId`s are unchanged so an existing install keeps its PATH shims, autostart entry and upgrade path.
- **The dashboard's version check asks the release feed, not npm** (`/api/version`): the npm package it looked for has never been published, so the update banner could never appear while the UI still offered `npm i -g` as the answer.
- **Release CI works**: `release.yml` no longer installs with `npm ci` against ignored lockfiles (every CI release had failed in 18 seconds), and one Windows job now builds and publishes everything the release needs — gateway installer, desktop installer, CLI tarball, each with its `.sha256`, plus `checksums.sha256`.
- **Docker**: `docker-compose.yml` builds this repository instead of pulling another project's image, and `docker-publish.yml` decides Docker Hub publishing by credential presence rather than by comparing the repository to upstream's name.
- **Docs rewritten without machine-specific paths or frozen version numbers**: README, [docs/INSTALL.md](docs/INSTALL.md), [docs/UPDATES.md](docs/UPDATES.md), [DOCKER.md](DOCKER.md); `CLAUDE.md` corrected about the data directory (`~/.or`) and about usage/request details living in SQLite; the docs site branding repointed; the Pages deploy workflow for someone else's site removed.
- **Brand cleanup across everything user-facing** — docs, gitbook, package metadata, i18n READMEs. Wire-protocol identifiers providers actually check (`X-Msh-Platform`, the `x-9*` response headers, the legacy data-folder migration) stay, and `LICENSE` keeps its MIT notice because that is a licence condition, not branding.

## Fixes
- `tests/__baseline__/snapshot-providers.mjs` no longer writes OAuth client secrets into the committed baseline: credential fields are stripped at generation time (`verify-providers.mjs` never compared them, so the gate loses nothing).

# v0.5.114 (2026-11-05)

## Changes
- **Release home is now `origin-labs-ai/origin-router-suite`.** Every place that decides where an installed build looks for its next version moved with it: the dashboard's GitHub/About links and changelog fetch, the CLI updater's default repo and the `install.json` marker written by `package-cli.mjs`, the desktop app's Issues/Releases links, both Inno `AppURL` fields, and the pinned darwin-arm64 tray release. The old `origin-labs-ai/originrouter` repository no longer resolves (`git ls-remote` → repository not found), so an installed build was pointing its auto-update, its changelog modal and its tray-binary gate at a dead URL; the `tray-binaries` workflow re-derives the repo from that pinned constant, so it follows this move and needs one run there to re-upload the asset.
- **build-installer.ps1 takes its default version from package.json** instead of a literal, so a build cannot silently label itself with a stale version again (pass `-Version` to override).
- **README corrected against reality**: installer names, the release-check URL and the repository path (it still said `Workspaces\originrouter`, two folders ago), plus a note that the desktop installer and CLI tarball are attached to the tag's release from the build machine.
- Publisher string unified to **Origin Labs AI** in the gateway installer, matching the desktop installer, so the two products no longer report different publishers.
