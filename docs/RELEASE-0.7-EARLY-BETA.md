# 0.7 early beta — preparation

Version `0.6` is the stable base: one exact version string across the app,
CLI and desktop package, with the release history rewritten to match. This
document is the plan for `0.7` early beta. It is written from our own code
audit (`docs/OMNIROUTE-COMPARISON.md`), not from another project's wording.

## What "early beta" means here

Early beta is a labelled, opt-in channel. It ships the new agent-protocol work
behind a settings switch, keeps the default routing path unchanged, and is
allowed to have rough edges as long as the core gateway stays healthy. The
stable `0.6` install must keep working; beta features never land as silent
breaking changes.

## Scope — the gaps worth closing first

Ordered by value ÷ risk:

1. **Wire the quota source.** `setQuotaSource()` exists but is never called
   (`open-sse/services/comboOrderers.js`). Feed it a snapshot from the usage
   tables so `quota-weighted`, `headroom` and `reset-window` stop falling back
   to fairness rotation. This makes existing code useful without new UI.
2. **Tool-call audit table.** Add a SQLite table for MCP/A2A invocations:
   timestamp, protocol, tool name, caller, duration, status, redacted argument
   digest. Never store raw tokens or full prompts. A settings toggle controls
   retention, default off.
3. **End-to-end correlation IDs.** Read an inbound `X-Request-Id` (or generate
   one), carry it through chat/core/executors, and echo it on responses and
   request-detail records. Keep generating fresh upstream IDs only where the
   provider requires it.
4. **p50 and p99 telemetry.** `providerHealth.js` already has `percentile()`;
   compute the two extra values and expose them in the health card. Cheap,
   low-risk, closes an overstated claim.
5. **A2A streaming.** The card currently says `streaming: false`. Adding
   `message/stream` plus task resubscribe is the natural beta feature. Keep
   the in-memory task store honest about durability.
6. **Encryption boundary decision.** Either encrypt provider secret columns at
   rest with a documented key story, or explicitly document that protection is
   OS-file-permission based. Do not ship a half-encrypted store with a claim.
7. **Prompt-injection guard — research spike only.** Decide whether a guard
   runs before routing, what it does with a suspect prompt, and how it avoids
   breaking legitimate tool results. Implementation is later, not 0.7 beta.

## Explicitly out of scope for 0.7

- Claiming an MCP tool count we do not have (built-ins are 7; federation is
  opt-in).
- Calling manual free-tier combos an automatic 4-tier cascade.
- Rewriting the translator core — it is the stable part of the product.
- Changing the `0.6` version string; beta uses `0.7` with a clear pre-release
  label chosen at release time.

## Release criteria

Before an early beta tag is cut:

- `npm run build` passes and the patched gateway answers on port `20128`.
- `tests/` regression baseline shows no new failures beyond the documented
  known-fails list.
- The four verification scripts under `tests/__baseline__/` pass.
- Secrets stay redacted in cloud sync and audit records (unit test).
- No new absolute machine paths in UI copy or committed config.
- CHANGELOG has a `0.7` section that names the beta features and the known
  limits in plain language.

## Suggested commit slices

1. `feat(quota): wire quota snapshot source into seat ordering`
2. `feat(audit): tool-call audit table with redacted arguments`
3. `feat(observability): end-to-end correlation ID and p50/p99`
4. `feat(a2a): streaming tasks behind beta flag`
5. `docs: 0.7 early-beta notes and honest capability matrix`

Each slice should be independently testable and revertible. Security review
comes before any change to auth, headers, credential storage or audit records.
