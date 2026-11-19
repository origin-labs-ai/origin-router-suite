# OriginRouter vs OmniRoute — evidence-based comparison

This is our own read of the two products, written for the 0.7 early-beta
planning. It deliberately avoids marketing words from the other project's
announcement. Every verdict below was checked against this checkout on
`main` at version `0.6`; the file paths are the evidence.

Legend:

- **Already here** — the code ships it today.
- **Partly here** — a real implementation exists, but it is narrower than the
  claim being made.
- **Not here** — no code supports the claim. A related endpoint elsewhere in
  the app does not count.

## 1. Agent tooling (MCP)

**Partly here.** We have our own MCP endpoint at `/api/mcp`
(`src/app/api/mcp/route.js`) with `initialize`, `ping`, `tools/list` and
`tools/call`, and exactly **7** built-in tools: `list_models`, `routing_plan`,
`memory_stats`, `strategy_list`, `fold_stats`, `harness_list` and
`mcp_hub_status`. There is also an opt-in federation hub
(`src/lib/mcp/hub.js`) that can merge remote tools into the list, but its only
configured server is disabled by default. A stdio-to-SSE bridge exists for one
bundled plugin (`src/lib/mcp/stdioSseBridge.js`).

What we should **not** say: that we ship 87–104 MCP tools. That number has no
counterpart in our source. If a future release wants a big tool catalog, it
has to be built and tested, not asserted.

Protocol surface still missing: `resources/*`, `prompts/*`, logging and
completion methods, plus a GET-SSE stream / session handshake on `/api/mcp`
itself.

## 2. Agent-to-agent handoff (A2A)

**Partly here.** `/a2a` and the Agent Card at `/.well-known/agent.json` are
live (`src/app/a2a/route.js`, `src/lib/a2a/index.js`). Four JSON-RPC methods
work: `message/send`, `tasks/get`, `tasks/cancel`, `tasks/stats`. Tasks are
kept in memory (500 max, 24 h TTL). Only `smart-routing` has a real executor;
the other two advertised skills are honest stubs.

Missing: `message/stream`, `tasks/resubscribe`, push notification config, and
durable tasks. The card itself says `streaming: false` and
`pushNotifications: false` — that is accurate and should stay that way until
the features exist.

## 3. Cost cascade

**Partly here.** Pricing-aware ordering is real: `orderCostOptimized` in
`open-sse/services/comboOrderers.js`, and `cost-optimized` /
`latency-arbitrage` strategies in `src/lib/routing/strategies.js`. Seat
fallback and account rotation are core behavior of `src/sse/handlers/chat.js`.

What is missing is an automatic four-tier ladder (paid → cheap → free, with a
hard price band). Our docs describe those tiers as **manual combos** the user
builds; there is no cascade state machine in code. Calling it a "4-tier cost
cascade" today would be a documentation claim, not a product claim.

## 4. Format translation

**Already here.** `open-sse/translator/index.js` pivots through OpenAI and
also registers direct pairs for fragile formats. Twelve formats are listed in
`open-sse/translator/formats.js`, including Claude, Gemini, Kiro, Cursor,
Codex and OpenAI Responses, with `/v1/messages`, `/v1/responses` and
`/v1/chat/completions` all served. This is the strongest part of the
comparison: it is real, tested and used on every request.

## 5. Quota-aware routing

**Partly here — with a real gap.** The strategy family exists: P2C,
`expiry-first`, `reset-window`, `quota-weighted`, `headroom` and fairness
rotation are in `open-sse/services/comboOrderers.js` and
`src/lib/routing/strategies.js`. But `setQuotaSource(fn)` is only defined and
never called anywhere in the checkout. Without a live quota snapshot, those
strategies fall through to fairness rotation. This is the single most useful
0.7 fix: wire the source, then the existing code starts earning its name.

## 6. Encryption at rest

**Partly here.** `aes-256-gcm` is used in four places: the MITM CA material
(`src/mitm/manager.js`), the Shadow Cache (`open-sse/services/shadowCache.js`),
the Google Drive refresh token (`src/lib/cloudsync/googleDrive.js`) and the
Xiaomi OAuth callback (`src/lib/oauth/providers/xiaomi-mimo.js`).

The main SQLite credential store is **not** encrypted: provider tokens and API
keys are plain JSON text in `data`/`key` columns (`src/lib/db/schema.js`,
`src/lib/db/repos/connectionsRepo.js`). Saying "all credentials encrypted at
rest" would be wrong. Threat-model note: this is a local-first app; the SQLite
file is protected by OS account permissions, not by an app-level cipher.
0.7 should either encrypt the secret columns explicitly or document the
boundary precisely.

## 7. Prompt-injection guard

**Not here.** There is no middleware that scans incoming prompts. The
dashboard guard (`src/dashboardGuard.js`) is authentication and network
policy; `/v1/moderations` is a separate derived endpoint, not a request-path
filter. `buildMemoryInjection()` in `src/lib/memoryFabric/index.js` injects
recalled memory into prompts — the opposite direction. Do not confuse the two.

## 8. Audit log for tool calls

**Not here.** No `mcp_tool_audit` table or equivalent exists. The SQLite
schema has request usage and request details, which record HTTP calls and
cost, not which MCP/A2A tool a client invoked with which arguments. A 0.7
compliance story needs a real table plus redaction rules for arguments.

## 9. Correlation IDs

**Partly here.** Upstream calls get a fresh `X-Request-ID`
(`open-sse/executors/default.js` and others). Nothing reads an inbound
`X-Request-Id`, nothing echoes or propagates it through the routing layers.
The internal `traceId` per plan is not an HTTP correlation header. End-to-end
tracing is therefore not available yet.

## 10. Latency percentiles

**Partly here — p95 only.** `src/lib/providerHealth.js` has a generic
`percentile()` helper but calls it once, for `p95LatencyMs`. The dashboard
shows p95 (`src/shared/components/ProviderHealthCard.js`). No p50 or p99 is
computed. (The strings `p50`/`p99` in the provider registry are provider
variable names, not latency statistics.)

## 11. Cloud sync and packaging

**Already here.** Google Drive appDataFolder backup with redaction before
upload and an AES-sealed refresh token (`src/lib/cloudsync/googleDrive.js`,
`src/app/api/cloudsync/sync/route.js`). Release workflow ships signed-by-hash
installers and portable builds with `.sha256` files
(`.github/workflows/release.yml`, `install.ps1`, `install.sh`,
`cli/cli.js` self-updater).

## Honest one-line summary

OriginRouter is ahead on request routing, protocol translation and local
durability; it is behind on the "enterprise agent" layer — streaming A2A,
tool audit, prompt-injection defense, end-to-end correlation, full percentile
telemetry, wired quota snapshots and encrypted credential columns. Those gaps,
not inflated numbers, are the 0.7 early-beta worklist.
