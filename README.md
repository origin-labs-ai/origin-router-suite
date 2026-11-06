<div align="center">
  <img src="./public/favicon.svg" alt="OriginRouter" width="96" />

  # OriginRouter

  **One endpoint for every AI provider. Never stop coding.**

  Route across **90+ providers** from a single local port, fall back before an upstream error ever reaches your code, and cut **60-90%** of tool-output tokens.

  <p>
    <a href="#-quick-start"><b>Quick Start</b></a> •
    <a href="#-the-routing-brain"><b>The Brain</b></a> •
    <a href="#-combos"><b>Combos</b></a> •
    <a href="#-token-saver"><b>Token Saver</b></a> •
    <a href="#-screenshots"><b>Screenshots</b></a> •
    <a href="#-install"><b>Install</b></a> •
    <a href="#-docs"><b>Docs</b></a>
  </p>

  [![GitHub release](https://img.shields.io/github/v/release/origin-labs-ai/origin-router-suite?style=flat-square&label=release)](https://github.com/origin-labs-ai/origin-router-suite/releases/latest)
  [![License: MIT](https://img.shields.io/github/license/origin-labs-ai/origin-router-suite?style=flat-square)](LICENSE)
  [![Docker](https://img.shields.io/badge/docker-ghcr.io%2Forigin--labs--ai%2Forigin--router-2B7FFF?style=flat-square&logo=docker&logoColor=white)](https://github.com/origin-labs-ai/origin-router-suite/pkgs/container/origin-router)
  [![Local first](https://img.shields.io/badge/data-never%20leaves%20your%20machine-22c55e?style=flat-square)](https://github.com/origin-labs-ai/origin-router-suite/blob/main/docs/ARCHITECTURE.md)
  [![UI languages](https://img.shields.io/badge/UI-37%20languages-8b5cf6?style=flat-square)](i18n)
</div>

---

Point Claude Code, Cursor, Codex, Cline, Gemini CLI, OpenCode, Copilot, Antigravity — anything that speaks OpenAI or Anthropic — at `http://localhost:20128`. OriginRouter answers with whichever provider is actually healthy right now, and the failure never reaches your terminal.

<div align="center">
  <img src="./images/origin-router.png" alt="OriginRouter providers dashboard" width="880" />
</div>

---

## 🚀 Quick Start

**Windows** — one line, no Node required:

```powershell
irm https://raw.githubusercontent.com/origin-labs-ai/origin-router-suite/main/install.ps1 | iex
```

**Anywhere with Node 18+:**

```bash
npx @origin-labs-ai/origin-router
```

**Docker:**

```bash
docker run -d -p 20128:20128 --name origin-router \
  -v origin-router-data:/app/data \
  ghcr.io/origin-labs-ai/origin-router:latest
```

Then open **http://localhost:20128/dashboard**, connect a provider, and point your tool at the endpoint.

```bash
# every OpenAI-compatible client
export OPENAI_BASE_URL=http://localhost:20128/v1

# every Anthropic-compatible client
export ANTHROPIC_BASE_URL=http://localhost:20128
```

<details>
<summary><b>What actually happens on <code>npm i -g</code></b></summary>

1. The launcher installs a portable copy of the gateway and warms its SQLite runtime — no network needed on first start.
2. It writes `~/.or/install.json` (mode, install root, update repo, version).
3. It starts the gateway on **20128** and, with `--tray`, adds a system-tray entry with the dashboard, the playground and a stop action.
4. `originrouter update` checks the GitHub release feed, verifies the `.sha256` next to the installer, and runs the silent Inno update.

</details>

---

## 🧠 The Routing Brain

Most routers pick one provider and hope. OriginRouter runs a **local decision layer** that scores, classifies and steers every request before it leaves the machine.

<div align="center">
  <img src="./images/fusion-combo-ui.png" alt="OriginRouter combo with the Panda brain and a fallback chain" width="880" />
</div>

Three signals decide one request:

| Signal | Engine | What it contributes |
|---|---|---|
| **Rank** | **Panda** | Scores every candidate seat by `P(success)`, cost and latency; keeps the top-K, explores a little, picks the best one. |
| **Classify** | **Jev** (System One) | Reads the task itself and decides which kind of model it needs — a hard coding task, a long-context read, a cheap answer. |
| **Steer** | **Seat fairness + tier bias** | Stops one seat from eating the whole quota, and pushes a cheap task onto a cheap tier without downgrading a hard one. |

When the two engines disagree, the brain **hedges** instead of guessing: it answers from the leader and keeps the other attempt running until the deadline, so a wrong pick costs latency, not the answer.

Defaults, all overridable by env var or by the dashboard:

| Setting | Default | Env var |
|---|---|---|
| Brain mode | `merged` (`panda` \| `jev` \| `off`) | `OR_ROUTER_BRAIN` |
| Panda weight / Jev weight | `0.55` / `0.45` | `OR_PANDA_WEIGHT`, `OR_JEV_WEIGHT` |
| Brain timeout | `3500 ms` | `OR_BRAIN_TIMEOUT_MS` |
| Seat fairness | `0.3` over a 15-minute window | `OR_SEAT_FAIRNESS` |
| Tier bias (Pro vs Flash) | `0.18` | `OR_TIER_BIAS` |
| Hedge window | `12000 ms` / `64 KB` | — |
| Failover routes tried | `12` | — |
| Degrade cooldown / seat silence | `45 s` / `45 s` | — |

Everything runs **locally**. The brain never sends your prompt to a service you did not already use.

### When it is worth it

- **One key, many providers.** Keep a single paid key and let free tiers carry the cheap work.
- **Quota that resets at midnight.** The brain rotates seats so the reset actually helps you.
- **Two tiers, one name.** Point `fast` at the cheap tier and `deep` at the paid one — the brain picks per task.

---

## 🧩 Combos

A **combo** is one name that stands for several models, with a strategy that decides how a request is served.

| Strategy | Behaviour | Costs |
|---|---|---|
| **Fallback** | Tries the models in order until one succeeds. | 1 model per request |
| **Round Robin** | Rotates across the models to spread load and burn every quota evenly. | 1 model per request |
| **Smart Router** | Asks a System One decision model which model to use *before* generating; supports adaptive switch and per-turn billing modes. | 1 extra call |
| **Fusion** | Runs every panel model in parallel and has a judge synthesise one answer. | N + 1 calls |

Combos also answer on **`POST /v1/origin`**, which accepts OpenAI chat, Anthropic messages and Responses payloads in the shape the caller sent them — so one combo can serve every client shape you have.

<details>
<summary><b>Reliability rules the router keeps</b></summary>

- An upstream error is **never** surfaced to your client while a healthy seat is left.
- A seat that starts failing is **degraded** for a cooldown instead of being retried into the ground.
- A seat that has gone quiet is **silenced** for a while instead of holding the request open.
- A **last-resort** completion may answer, but it is counted as a last resort — never as a clean success.

</details>

---

## 🪙 Token Saver

The dashboard's **Token Saver** page is where the money is:

| Saver | What it does | Measured effect |
|---|---|---|
| **RTK** (tool output) | Compresses `git`, `grep`, `ls`, `tree`, `logs` output before it enters the prompt. | **60-90% fewer input tokens** |
| **Headroom** | Compresses the prompt itself through `/v1/compress` before routing. | prompt bytes shrink |
| **Caveman** | Terse-style system prompt. | **~65% fewer output tokens** (up to 87%) |
| **Ponytail** | Biases the model towards minimal code: YAGNI, reuse still, deletion over addition. | shorter diffs |

RTK is **fail-open by design**: if compression cannot make a payload smaller, the original payload is sent unchanged. A savings feature must never break a request.

---

## 📸 Screenshots

<div align="center">

| Dark | Light |
|---|---|
| <img src="./images/providers-dark.png" alt="Providers, dark theme" width="420" /> | <img src="./images/providers-light.png" alt="Providers, light theme" width="420" /> |
| <img src="./images/combos-dark.png" alt="Combos, dark theme" width="420" /> | <img src="./images/combos-light.png" alt="Combos, light theme" width="420" /> |
| <img src="./images/token-saver-dark.png" alt="Token Saver, dark theme" width="420" /> | <img src="./images/token-saver-light.png" alt="Token Saver, light theme" width="420" /> |

</div>

The dashboard is available in **37 languages** and follows the light/dark theme of your system.

---

## ✨ What is inside

| Area | What you get |
|---|---|
| **The routing brain** | Panda ranks your provider seats by `P(success)`, cost and latency. Jev (System One) reads the task and decides which kind of model it needs. Seat fairness rotates so one key doesn't eat the whole quota, and tier bias pushes an easy task onto a cheap tier. When the two engines disagree, the brain hedges instead of guessing. |
| **Reliability** | An upstream error is never surfaced to your client while a healthy seat is left. Failing seats are degraded for a cooldown, quiet seats are silenced, and a last-resort completion is labelled as a last resort. |
| **Model identity** | The model test reports **which model actually answered** (`answered by: <id>`), can re-check a verdict, and separates a broken provider from a provider that returned a different model than it claimed. |
| **A naming system** | Provider heads, vendor namespaces, deployment tags, snapshot dates and quant/build stamps are folded away. Class words — `flash`, `pro`, `mini` — stay, because those are the ones you actually route on. |
| **Packaging** | The **Windows installer**, the **desktop window app**, the **npm launcher** (`originrouter` / `or`), portable zips for Windows, macOS and Linux, and a **Docker image**. |
| **Release engineering** | The pipeline builds every artifact, publishes them with curated release notes and checksums, and the launcher verifies the `.sha256` before it installs anything. |
| **Local-first storage** | State and usage live in `~/.or/db/data.sqlite`. Old installs migrate themselves on first start instead of starting empty. |
| **Safety** | The LAN gate derives the peer address from the socket, not from a spoofable header; local-only routes need the CLI token; the container gateway counts as "this computer" so a published Docker port still works. |
| **Honest docs** | Every claim in this README is checked against the code, and the architecture doc describes the storage model and the env contract that actually exist. |

---

## 📦 What is in the box

| Surface | What it is |
|---|---|
| **Gateway + dashboard** | The Next.js app on port 20128 — providers, combos, usage, quota, playground, CLI tools, skills, proxy pools, media providers, translator. |
| **CLI launcher** | `originrouter` (or `or`) — install, start, tray, update, logs, doctor. Publishable to npm as `@origin-labs-ai/origin-router`. |
| **Desktop app** | A native window around the gateway (`OriginRouter-Desktop-Setup-<version>.exe`), built with electron-builder and packaged with Inno Setup. |
| **Windows installer** | `OriginRouter-Setup-<version>.exe` — the gateway, the dashboard, the tray and the uninstaller. |
| **Docker image** | `ghcr.io/origin-labs-ai/origin-router` for `linux/amd64` and `linux/arm64`. |
| **Portable zips** | `OriginRouter-mac.zip`, `OriginRouter-linux.zip` — no installer, no admin rights. |

---

## 🔌 Endpoints

| Path | What it serves |
|---|---|
| `POST /v1/chat/completions` | OpenAI chat |
| `POST /v1/messages` | Anthropic messages |
| `POST /v1/responses` | OpenAI Responses |
| `POST /v1/origin` | Combo endpoint — OpenAI, Anthropic and Responses payloads in the caller's own shape |
| `POST /v1/embeddings` | Embeddings |
| `GET /v1/models` | Every model you can reach (or combo names only — your choice) |
| `GET /api/health` | Liveness |

---

## 🐳 Docker

```bash
docker run -d -p 20128:20128 \
  -v origin-router-data:/app/data \
  ghcr.io/origin-labs-ai/origin-router:latest
```

```yaml
# docker-compose.yml
services:
  origin-router:
    image: ghcr.io/origin-labs-ai/origin-router:latest
    container_name: origin-router
    restart: unless-stopped
    ports: ["20128:20128"]
    volumes: ["./data:/app/data"]
```

The data directory holds the SQLite database, your keys and your logs. Mount it and the container is stateless.

---

## 🔒 Local first, on purpose

- Keys, usage and history stay in `~/.or` on your machine. Nothing is uploaded anywhere.
- The LAN is **off by default**: the dashboard answers on loopback only until you switch on "Allow access from this network".
- The peer address comes from the socket, so a forged `X-Forwarded-For` cannot talk its way in.
- Local-only routes (spawning processes, reading host secrets) need the CLI token.

---

## 🔄 Auto-update

The launcher does not trust npm for updates — the npm package has never been the source of an update. It reads the GitHub release feed, downloads `OriginRouter-Setup-<version>.exe`, verifies the `.sha256` next to it, and runs the silent Inno update.

---

## 🛠 Build from source

```bash
git clone https://github.com/origin-labs-ai/origin-router-suite.git
cd origin-router-suite
npm install
npm run build
npm start            # gateway + dashboard on http://localhost:20128
```

The CLI package is built from `cli/` (it bundles the gateway into `cli/app`):

```bash
cd cli
npm install
npm run build
npm pack
```

Tests:

```bash
cd tests && npm install && npx vitest run
```

---

## 📚 Docs

| Document | What is in it |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the gateway is put together, the storage model, the env contract |
| [docs/INSTALL.md](docs/INSTALL.md) | Every install path, and what each one gives you |
| [docs/UPDATES.md](docs/UPDATES.md) | How updating works, and what the updater verifies |
| [docs/RELEASE-LOG.md](docs/RELEASE-LOG.md) | The working log of every release |
| [CHANGELOG.md](CHANGELOG.md) | Release notes, newest first |

---

## 👥 Built by

OriginRouter is built by **Origin Labs AI** — a local-first AI router that keeps your keys, your usage and your prompts on your own machine.

## 📄 License

[MIT](LICENSE) © Origin Labs AI
