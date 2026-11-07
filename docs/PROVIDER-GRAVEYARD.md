# Provider Graveyard — who is alive, who is dead, and why

> The honest ledger. The reference platforms (OmniRoute v3.8.54 advertises
> 296 registry entries across 276 directories) carry many providers that are
> dead, expired, or unreachable. This document records, per provider, what
> its actual status is and whether OriginRouter ships it. Nothing here is
> guesswork presented as fact: each entry names its evidence class.
>
> Evidence classes:
>   [A] shut down with a dated announcement (service notice)
>   [B] deprecated in the reference's own code (RISK_NOTICE / lifecycle)
>   [C] web-cookie or bespoke-executor only — no portable public API
>   [D] unreachable/offline at review time (2026-11-07)
>   [E] judgment call — small/young router with no verified uptime

## 1. The dead list (excluded from the v0.6.000 port)

| Provider | Status | Class | Notes |
|---|---|---|---|
| poolside | Shut down 2026-10-31 | [A] | Direct Poolside Platform inference ended; OmniRoute's own notice says so. Laguna preview models were free during preview only. |
| api-airforce | Dead | [D] | Free proxy; upstream long gone. |
| beatapi | Offline | [D] | Aggregator offline at review. |
| demonroute, dxnt, gitlawb, bazaarlink | Offline | [D] | Small resellers, no service. |
| nan, navy, chenzk, crof, dahl, gisoo, ofoxai, onomeo | Unreachable | [D] | No verified endpoint. |
| freeaiapikey | Defunct | [D] | Free-key distributor site gone. |
| g4f-gemini / g4f-groq / g4f-nvidia / g4f-ollama / g4f-pollinations | Unstable proxy family | [D] | g4f proxies flap between working and dead; not shippable. |
| wafer | Preview ended | [A] | FCC catalog notes the preview program ended. |
| llm-kiwi, seekai, regolo | Defunct | [D] | No service. |
| tabitoken, speka, uncloseai | Service ended | [D] | No service. |

## 2. Deprecated inside OriginRouter itself (entries exist, connections refused)

These ship as registry entries flagged `deprecated: true` with a RISK_NOTICE —
the entry survives for migration/import compat, but new connections are
refused. This is the "Trae-type" case the owner asked about: an entry can
exist without being connectable.

| Provider | Why |
|---|---|
| antigravity | Upstream IDE-flow changes; OAuth session pool unstable upstream. |
| codex | ChatGPT backend flow moved; needs the codex executor to stay current. |
| claude | OAuth session flow superseded by the native Claude Code setup. |
| gemini-cli | CLI OAuth pool flagged risky upstream. |
| github | Copilot device-flow deprecation upstream. |
| kiro | Service restructuring upstream. |

## 3. Not portable without bespoke executors (intentionally skipped)

These are REAL and alive, but they are not plain bearer-key OpenAI-compatible
endpoints — porting them faithfully means porting their executors too, which
is fusion-pack territory, not the base registry:

- **OAuth/web-session pools**: chatgpt-web, claude-web, gemini-web, grok-web,
  perplexity-web, muse-spark-web, notion-web, conol-web, t3-web,
  chatplayground, adapta-web, uc-web family, cloudflare-playground.
- **Special-auth enterprise clouds**: databricks, watsonx, snowflake, oci,
  heroku, sap, predibase, baseten (per-model URLs), modal (per-deployment),
  aws-bedrock (Mantle variant beyond the existing bedrock entry).
- **Local runtimes**: lmstudio, llama.cpp, ollama-local — served by the Local
  Models page instead (see dashboard → Local Models).
- **Small unverified routers** [E]: eurouter, fastrouter, literouter,
  unorouter, agentrouter, anyapi, y-api, nube, auriko, apmix, mnn-ai,
  poixe-ai, sumopod, charm-hyper, hyperagent, dgrid, dit, bai variants.
  Real businesses may run behind these, but none had verifiable public
  OpenAI-compatible uptime at review time. They join via the fusion pack's
  `providers-plus` category when verified.

## 4. Alive and ported (the 41)

The v0.6.000 port table (open-sse/providers/registry/v060-port.js) carries
41 verified OpenAI-compatible bearer-key providers from the OmniRoute and
Free Claude Code catalogs — DeepInfra, W&B Inference, Atlas Cloud, xKiro,
Opper, NaraRoute, Experiential Labs, Cheaper Inference, OrcaRouter, Lightning
AI, ZenMux, Z.ai, Kimi Code, Codestral, Alibaba Cloud ModelStudio, QwenCloud
(Token Plan + Coding), Ollama Cloud, AI/ML API, Novita, ElectronHub, LLM
Gateway, NanoGPT, Requesty, FriendliAI, Inference.net, Lambda, DigitalOcean
GenAI, Nscale, Monster API, OVHcloud AI Endpoints, AI21, Writer, Segmind,
Upstage Solar, Sarvam, Typhoon, SEA Lion, Qianfan, iFlyTek Spark, ModelScope.

## 5. OAuth connection options

Every shipped provider whose `authType` is `oauth` (25 in the base registry)
has its connect flow on the Providers page — the dashboard drives the same
OAuth/device flow the registry declares, token refresh is automatic
(`open-sse/services/tokenRefresh/`), and `display.notice` carries the signup
URL. A reference-only OAuth provider (claude-web, gemini-web, …) is listed in
section 3, not the connect grid, because its flow needs a bespoke executor.

## 6. Review cadence

Statuses decay. The port table's inline comments name the review date
(2026-11-07); a graveyard entry graduates OUT of section 1 the moment a
provider verifies alive again — re-test, move to the port table, note the
date. Dead providers are never silently re-added: the exclusion comment
travels with the id.
