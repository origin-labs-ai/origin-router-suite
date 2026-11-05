# Docker

Run the OriginRouter gateway in a container. Nothing is published to a registry today, so
the supported path is **build from this repository**; the `docker-publish` workflow exists
to publish GHCR images once its credentials are configured.

---

# 👤 For Users

## Quick start (compose)

```bash
cp .env.example .env      # set INITIAL_PASSWORD - the shipped default is a placeholder
docker compose up -d --build
```

App on port `20128` → http://localhost:20128. State lands in the named volume
`origin-router-data`, and an optional `headroom` sidecar is defined for the token saver.

## Quick start (plain docker)

```bash
docker build -t origin-router:local .

docker run -d \
  -p 20128:20128 \
  -v "$HOME/.or:/app/data" \
  -e DATA_DIR=/app/data \
  --name origin-router \
  origin-router:local
```

## Manage the container

```bash
docker logs -f origin-router        # view logs
docker stop origin-router           # stop
docker start origin-router          # start again
docker rm -f origin-router          # remove
```

## Data persistence

```bash
-v "$HOME/.or:/app/data" \
-e DATA_DIR=/app/data
```

Without `DATA_DIR` the app falls back to `~/.or` on macOS/Linux and `%LOCALAPPDATA%`
equivalents on Windows. Inside the container `DATA_DIR=/app/data` is what makes the bind
mount authoritative.

Layout under `$DATA_DIR/`:

```text
$DATA_DIR/
├── db/
│   ├── data.sqlite       # main SQLite database
│   └── backups/          # auto backups
└── ...                   # certs, logs, runtime configs
```

## Optional env vars

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.or:/app/data" \
  -e DATA_DIR=/app/data \
  -e PORT=20128 \
  -e HOSTNAME=0.0.0.0 \
  -e DEBUG=true \
  --name origin-router \
  origin-router:local
```

The full environment contract lives in `.env.example` and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). `INITIAL_PASSWORD` must be overridden on
anything reachable from outside the machine.

## Optional Headroom sidecar

The image bundles neither Python nor Headroom. Run Headroom as a second service and point
the gateway at it (`HEADROOM_URL: http://headroom:8787`) — `docker-compose.yml` already
does this. In the dashboard: `Endpoint` → `Token Saver` → `Headroom`, confirm the URL,
recheck status, then enable it. Headroom on the Docker host itself is reachable as
`http://host.docker.internal:8787`; on Linux add
`--add-host=host.docker.internal:host-gateway` (or the compose `extra_hosts` equivalent).
Without a reachable Headroom the gateway keeps using its own RTK compressor — nothing else
changes.

## Updating

Rebuild the image and recreate the container; the volume keeps your data:

```bash
docker build -t origin-router:local .
docker rm -f origin-router
# re-run the start command above
```

The in-app self-updater is for the Windows installer builds and does not run inside a
container.

---

# 🛠 For Developers

## Regional mirrors

```bash
docker build \
  --build-arg ALPINE_MIRROR=mirrors.aliyun.com \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com/ \
  -t origin-router:local .
```

## Publishing (CI)

`.github/workflows/docker-publish.yml` triggers on a `vX.Y.Z` tag (or a prerelease such as
`vX.Y.Z-rc.1`) and on manual dispatch. It builds `linux/amd64` and `linux/arm64` on native
runners, health-checks each platform image, verifies the resolved manifest and
`/api/health`, then publishes:

- `ghcr.io/<owner>/<repository-lowercase>:X.Y.Z`, plus `:latest` for a stable tag
- Docker Hub only when `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` exist as repository
  secrets — without them the job skips Docker Hub instead of failing on it

Notes that matter in practice:

- Image tags omit the `v`; the git tag and the root, `cli/` and `desktop/`
  `package.json` versions must match exactly, and SemVer build metadata (`+build.7`) is
  rejected because it is not a valid image tag.
- A stable tag push promotes `latest` only after both platform builds, both platform
  health checks, manifest inspection and the resolved-manifest smoke test succeed.
  Prereleases publish their numbered tag only; moving `latest` for one needs the explicit
  `promote_latest` opt-in on a manual run.
- Numbered tags are mutable (a republish replaces the manifest), so pin a digest for an
  immutable deployment: `docker pull ghcr.io/<owner>/<repo>@sha256:<digest>`.
- Creating a git tag does **not** create a GitHub Release. The Windows installers are
  published by `.github/workflows/release.yml` on the same tag; the CLI tarball and the
  desktop installer are attached to that release.
- GHCR uses the workflow's `GITHUB_TOKEN` with `packages: write`. Docker Hub publication
  additionally needs the two secrets above.
- Optional repository variables `ALPINE_MIRROR` and `NPM_REGISTRY` override the package
  mirrors used by the CI build.

Workflow: `.github/workflows/docker-publish.yml`
