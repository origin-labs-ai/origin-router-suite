# OriginRouter - FREE AI Router & Token Saver

**Never stop coding. Cut 60-90% of your tool-output tokens with RTK + auto-fallback to FREE & cheap AI models.**

**Connect every AI code tool (Claude Code, Cursor, Antigravity, Copilot, Codex, Gemini, OpenCode, Cline, OpenClaw...) to 90+ AI providers & 100+ models.**

[![Release](https://img.shields.io/github/v/release/origin-labs-ai/origin-router-suite?style=flat-square)](https://github.com/origin-labs-ai/origin-router-suite/releases/latest)
[![Docker](https://img.shields.io/badge/docker-ghcr.io%2Forigin--labs--ai%2Forigin--router-2B7FFF?style=flat-square&logo=docker&logoColor=white)](https://github.com/origin-labs-ai/origin-router-suite/pkgs/container/origin-router)
[![GHCR](https://img.shields.io/badge/GHCR-origin--labs--ai%2Forigin--router-blue?logo=github)](https://github.com/origin-labs-ai/origin-router-suite/pkgs/container/origin-router)
[![License](https://img.shields.io/github/license/origin-labs-ai/origin-router-suite)](https://github.com/origin-labs-ai/origin-router-suite/blob/main/LICENSE)

[🌐 Website](https://originrouter.com) • [📖 Full Docs](https://github.com/origin-labs-ai/origin-router-suite)

---

## 🤔 Why OriginRouter?

**Stop wasting money, tokens and hitting limits:**

- ❌ Subscription quota expires unused every month
- ❌ Rate limits stop you mid-coding
- ❌ Tool outputs (git diff, grep, ls...) burn tokens fast
- ❌ Expensive APIs ($20-50/month per provider)

**OriginRouter solves this:**

- ✅ **RTK Token Saver** - Auto-compress tool output, 60-90% fewer input tokens
- ✅ **A routing brain** - Panda ranks your seats, Jev reads the task, seat fairness spreads the load
- ✅ **Maximize subscriptions** - Track quota, use every bit before reset
- ✅ **Auto fallback** - Subscription → Cheap → Free, zero downtime
- ✅ **Multi-account** - Round-robin between accounts per provider
- ✅ **Universal** - Works with any OpenAI/Claude-compatible CLI

---

## ⚡ Quick Start

**Option 1 — installer (recommended for desktop):**

```powershell
# Windows
irm https://raw.githubusercontent.com/origin-labs-ai/origin-router-suite/main/install.ps1 | iex
```

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/origin-labs-ai/origin-router-suite/main/install.sh | bash
```

Either one installs the launcher as `originrouter` (or `or`) and starts the gateway.

**Option 2 — Docker (server/VPS):**

```bash
docker run -d --name origin-router -p 20128:20128 \
  -v "$HOME/.or:/app/data" -e DATA_DIR=/app/data \
  ghcr.io/origin-labs-ai/origin-router:latest
```

Published images: [GHCR](https://github.com/origin-labs-ai/origin-router-suite/pkgs/container/origin-router) (multi-platform amd64/arm64).

🎉 Dashboard opens at `http://localhost:20128`

**2. Connect a FREE provider (no signup needed):**

Dashboard → Providers → Connect **Kiro AI** (free Claude unlimited) or **OpenCode Free** (no auth) → Done!

**3. Use in your CLI tool:**

```
Claude Code/Codex/OpenClaw/Cursor/Cline Settings:
  Endpoint: http://localhost:20128/v1
  API Key:  [copy from dashboard]
  Model:    kr/claude-sonnet-4.5
```

That's it! Start coding with FREE AI models.

---

## 🚀 CLI Options

```bash
originrouter                    # Start with default settings
originrouter --port 8080        # Custom port
originrouter --no-browser       # Don't open browser
originrouter --skip-update      # Skip auto-update check
originrouter --help             # Show all options
```

**Dashboard**: `http://localhost:20128/dashboard`

---

## 🔌 Connect to a Remote OriginRouter

Already running OriginRouter on another machine (e.g. a team server on your LAN)? Point this machine's CLI tools at it — no local server is started:

```bash
originrouter connect http://<server-host>:20128                       # pick tools interactively
originrouter connect http://<server-host>:20128 --tools claude,codex  # or choose up front
originrouter connect --reset --tools claude,codex                     # undo
```

It logs in with the dashboard password (hidden prompt), reuses or creates an API key named `cli-<hostname>`, and writes each tool's config (backing up the original once as `*.bak-originrouter`).

Supported tools: `claude`, `codex`, `opencode`, `droid`, `crush`, `kilo`, `cline`, `pi`, `omp`, or `all`.

### Models

Models come from the **server's own CLI-tools configuration**, so a client gets whatever the operator already picked on the dashboard. Nothing is hardcoded.

| Tool | Model taken from (first match wins) |
|---|---|
| `claude` | tier flag (`--opus` …) → server's Claude tier → *left unset* (Claude Code's own default) |
| others | `--model` → that tool's own model on the server → server's OpenCode model → *tool skipped* |

`kilo` has no readable model on the server, so it always uses `--model` or the OpenCode model. `omp` (Oh My Pi) needs no model: it uses proxy discovery, so every server model appears under `originrouter` in `/model`. A Claude tier the server doesn't set is removed from your config rather than kept from an earlier run. A skipped tool makes the command exit `1`.

### Overriding the server's models

```bash
# One Claude tier; the other tiers still come from the server
originrouter connect http://<server-host>:20128 --tools claude --sonnet cc/claude-sonnet-5-5

# Every Claude tier
originrouter connect http://<server-host>:20128 --tools claude \
  --fable cc/claude-fable-5-1 --opus cc/claude-opus-5-5 \
  --sonnet cc/claude-sonnet-5-5 --haiku cc/claude-haiku-4-5-20251001

# All non-Claude tools at once
originrouter connect http://<server-host>:20128 --tools codex,opencode,kilo --model ocg/deepseek-flash

# Claude and other tools in one run
originrouter connect http://<server-host>:20128 --tools claude,codex --opus cc/claude-opus-5-5 --model gpt-6

# A different model per tool: --model covers every non-Claude tool in a run, so run once per tool
originrouter connect http://<server-host>:20128 --tools codex --model gpt-6
originrouter connect http://<server-host>:20128 --tools opencode --model ocg/glm-5.3
```

A model the server doesn't list is still written, with a `not listed by server` warning. To see the ids it serves: `curl http://<server-host>:20128/v1/models -H "Authorization: Bearer <your key>"`.

### Checking the current config

`originrouter show` prints what each CLI tool on this machine is currently set to — base URL, masked API key and models. It only reads local files and never contacts a server.

```bash
originrouter show                 # every supported tool
originrouter show claude          # one tool
originrouter show claude codex    # several
originrouter show claude --json   # machine-readable (key still masked)
```

```
✅ Claude Code
   File:     ~/.claude/settings.json
   Base URL: http://<server-host>:20128/v1
   API key:  sk-a1b…9f3c
   Models:
     fable   cc/claude-fable-5-1
     opus    cc/claude-opus-5-5
     sonnet  cc/claude-sonnet-5-5
```

Tools not pointed at originrouter are listed as `not configured`. For Codex, OpenCode and Cline it also warns when a originrouter entry exists but another provider is the active one.

### Other options

| Option | Purpose |
|---|---|
| `--password <pw>` | Dashboard password (or `NINE_ROUTER_PASSWORD`); prompted if omitted — preferred, keeps it out of shell history |
| `--save` | After a successful login, save the password for this server to `~/.originrouter/connect.env` (plain text, mode 600) so later runs skip the prompt. Delete the file to forget it |
| `--api-key <key>` | Use this key and skip login. The server's models can't be read without a login, so pass model flags |
| `--key-name <name>` | API key name to reuse/create (default `cli-<hostname>`) |
| `--print-env` | Also print `OPENAI_BASE_URL` / `OPENAI_API_KEY` for other CLIs |
| `--reset` | Remove the originrouter settings from the selected tools |

See `originrouter connect --help` for the full list.

> ⚠️ Over plain `http://` the password and API key are sent unencrypted — use a trusted LAN/VPN or put HTTPS in front. The API key is stored in each tool's config file.

---

## 🛠️ Supported CLI Tools

Claude-Code • OpenClaw • Codex • OpenCode • Cursor • Antigravity • Cline • Continue • Droid • Roo • Copilot • Kilo Code • Gemini CLI • Qwen Code • iFlow • Crush • Crusher • Aider

Any tool supporting OpenAI/Claude-compatible API works.

---

## 💾 Data Location

- **macOS/Linux**: `~/.originrouter/db/data.sqlite`
- **Windows**: `%APPDATA%/originrouter/db/data.sqlite`
- **Docker**: `/app/data/db/data.sqlite` (mount `$HOME/.originrouter` to persist)

---

## 📚 Documentation

Full docs, advanced setup, video tutorials & development guide:

- **GitHub**: https://github.com/origin-labs-ai/origin-router-suite
- **Full README**: https://github.com/origin-labs-ai/origin-router-suite/blob/master/README.md
- **Website**: https://originrouter.com

---

## 🙏 Acknowledgments

- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** - Original Go implementation

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.
