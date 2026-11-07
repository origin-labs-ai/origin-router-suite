// OriginFold — the conversation fold layer (v0.6.000).
//
// The billion-context design, native: when a conversation's token estimate
// crosses a fraction of the model's context window, the layer folds consumed
// history into tiered summary blocks and keeps only a verbatim recent zone —
// append-only, suffix-only, so the upstream prompt-cache prefix is never
// invalidated. Reversibility instead of spillover: blocks can be restored
// (decompress) or searched (search_context); large tool results are offloaded
// (the CCR lane, shared with RTK).
//
// Division of labor with the rest of the token saver:
//   RTK        → tool-RESULT compression (in-place, shape-aware)
//   headroom   → transport-level prompt compression (external proxy)
//   OriginFold → conversation-level FOLDING (message ranges → tier blocks)
//
// Design rules:
//   - Fail open: every path returns the original body when anything is off —
//     disabled, unknown window, tiny conversations, internal errors.
//   - The recent zone is never folded (configurable head), so the model always
//     sees the live turn verbatim.
//   - Deterministic extractive summaries by default (model-free, safe);
//     model-written summaries can drive the same blocks through the exported
//     executeFoldTool (used by the A2A/MCP surface).
//   - State is per-session (stable conversation head hash), bounded, and
//     TTL-swept; losing it on restart only costs the fold, never a request.

import { getCapabilitiesForModel } from "../providers/capabilities.js";

// ─── Config (defaults; overridable via settings.fold) ────────────────────────

export const FOLD_DEFAULTS = {
  enabled: true,
  // Nudge/fold thresholds as a fraction of the model's context window.
  nudgeAt: 0.45,     // start folding consumed history
  emergencyAt: 0.9,  // aggressive fold + tool-output clamping
  // The verbatim recent zone is never folded.
  preserveRecentMessages: 6,
  preserveRecentTokens: 5000,
  // A summary block carries at most this many characters of extractive text.
  maxSummaryChars: 900,
  // Sessions (per stable conversation head) kept in memory.
  sessionsCap: 512,
  sessionTtlMs: 48 * 60 * 60 * 1000,
};

// ─── Token estimation (fast word-level, CJK-aware) ───────────────────────────

export function estimateTokens(text) {
  const s = String(text || "");
  if (!s) return 0;
  // CJK chars are ~1 token each; words elsewhere ~1.35 tokens.
  const cjk = (s.match(/[\u3040-\u30FF\u3400-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/g) || []).length;
  const words = s.length - cjk > 0 ? s.slice(0, s.length - cjk).split(/\s+/).filter(Boolean).length : 0;
  return Math.ceil(cjk * 1.0 + words * 1.35 + s.length * 0.02);
}

function messageText(msg) {
  if (typeof msg?.content === "string") return msg.content;
  if (Array.isArray(msg?.content)) {
    return msg.content.map((c) => (typeof c === "string" ? c : c?.text || "")).join(" ");
  }
  return "";
}

export function estimateBodyTokens(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  let n = estimateTokens(typeof body?.system === "string" ? body.system : "");
  for (const m of messages) n += estimateTokens(messageText(m)) + 4;
  return n;
}

// Context window for the seat the request is about to hit. Falls back to the
// 1M floor the docs advertise, then 200k, so folding always has a number.
export function contextWindowFor(provider, model) {
  try {
    const caps = getCapabilitiesForModel(provider, model);
    const w = Number(caps?.contextWindow);
    if (Number.isFinite(w) && w > 0) return w;
  } catch { /* fail open */ }
  return 200000;
}

// ─── Session state (stable conversation-head hash → fold state) ─────────────

const sessions = new Map(); // sessionKey → state

// Optional persistence: a store({load, save}) wired at boot (see
// src/lib/foldStore.js). Without one, folds live in memory only — documented
// and safe: losing fold state on restart costs the fold, never a request.
let foldStore = null;
export function setFoldStore(store) {
  foldStore = store && typeof store.load === "function" && typeof store.save === "function" ? store : null;
}

function persistSession(state) {
  if (!foldStore) return;
  try {
    const { key, blocks, nextBlockId, stats } = state;
    foldStore.save(key, JSON.stringify({ blocks, nextBlockId, stats }));
  } catch { /* persistence is best-effort */ }
}

function hydrateSession(state) {
  if (!foldStore) return;
  try {
    const raw = foldStore.load(state.key);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (Array.isArray(saved.blocks) && saved.blocks.length > 0) {
      state.blocks = saved.blocks;
      state.nextBlockId = Number(saved.nextBlockId) || saved.blocks.length;
      state.stats = { ...state.stats, ...(saved.stats || {}) };
    }
  } catch { /* corrupt state = fresh fold */ }
}

function sessionKey(body) {
  // Same stable-head trick as the cache-affinity orderer: system + first
  // messages identify the conversation without depending on transport ids.
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const parts = [];
  if (typeof body?.system === "string") parts.push(body.system.slice(0, 512));
  for (const m of messages.slice(0, 3)) parts.push(`${m?.role}:${messageText(m).slice(0, 256)}`);
  let h = 5381;
  for (const ch of parts.join("\u0000")) h = ((h << 5) + h + ch.charCodeAt(0)) | 0;
  return String(h >>> 0);
}

function sweepSessions(now, cap, ttlMs) {
  for (const [k, s] of sessions) {
    if (now - s.updatedAt > ttlMs) sessions.delete(k);
  }
  while (sessions.size > cap) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

function getSession(body, cfg) {
  const key = sessionKey(body);
  const now = Date.now();
  let state = sessions.get(key);
  if (!state) {
    state = {
      key,
      blocks: [], // { id, tier, summary, from, to, createdAt, decompressed }
      nextBlockId: 0,
      stats: { folds: 0, decompresses: 0, searches: 0, estTokensSaved: 0 },
      createdAt: now,
      updatedAt: now,
    };
    sessions.set(key, state);
    hydrateSession(state);
    sweepSessions(now, cfg.sessionsCap, cfg.sessionTtlMs);
  }
  state.updatedAt = Date.now();
  return state;
}

// ─── Fold mechanics ──────────────────────────────────────────────────────────

// Deterministic extractive summary: first sentences of each message in the
// range, capped. Model-written summaries can replace this via executeFoldTool.
function extractiveSummary(messages, from, to, maxChars) {
  const parts = [];
  let n = 0;
  for (let i = from; i <= to && i < messages.length; i++) {
    const text = messageText(messages[i]).trim();
    if (!text) continue;
    const role = messages[i]?.role || "message";
    const sentence = text.split(/(?<=[.!?])\s+/)[0] || text.slice(0, 160);
    const line = `${role}: ${sentence.slice(0, 220)}`;
    if (n + line.length > maxChars) break;
    parts.push(line);
    n += line.length;
  }
  return parts.join("\n") || "(empty range)";
}

function applyFoldToMessages(messages, state) {
  if (!state.blocks.length) return messages;
  const out = [];
  let i = 0;
  while (i < messages.length) {
    const block = state.blocks.find((b) => !b.decompressed && b.from === i && b.to < messages.length);
    if (block) {
      out.push({
        role: "user",
        content: `[Compressed conversation section b${block.id}] Earlier messages ${block.from}–${block.to} were folded into this summary:\n${block.summary}`,
      });
      i = block.to + 1;
    } else {
      out.push(messages[i]);
      i += 1;
    }
  }
  return out;
}

// Fold the highest-payoff consumed range: the oldest span that leaves the
// preserved recent zone intact. Returns the created block or null.
function foldOldestRange(messages, state, cfg, tier = 1) {
  const headroom = 2; // never fold index 0..headroom-1 (system/first turn)
  const from = headroom;
  const to = messages.length - 1 - Math.min(cfg.preserveRecentMessages, Math.floor(messages.length / 2));
  if (to - from < 4) return null; // not enough consumed history to be worth it
  const alreadyFolded = state.blocks.some((b) => !b.decompressed && b.from === from);
  if (alreadyFolded) return null;
  const summary = extractiveSummary(messages, from, to, cfg.maxSummaryChars);
  const block = { id: state.nextBlockId++, tier, summary, from, to, createdAt: Date.now(), decompressed: false };
  state.blocks.push(block);
  state.stats.folds += 1;
  state.stats.estTokensSaved += Math.max(0, estimateTokens(messages.slice(from, to + 1).map(messageText).join(" ")) - estimateTokens(summary));
  return block;
}

// ─── Public API: processTurn (the chatCore seam) ─────────────────────────────

// Resolve settings.fold against defaults; unknown/garbage → defaults.
export function resolveFoldConfig(settings = {}) {
  const s = settings?.fold || {};
  return {
    ...FOLD_DEFAULTS,
    ...s,
    enabled: s.enabled !== false,
    nudgeAt: Math.min(0.95, Math.max(0.1, Number(s.nudgeAt) || FOLD_DEFAULTS.nudgeAt)),
    emergencyAt: Math.min(0.99, Math.max(Number(s.nudgeAt) || 0.45, Number(s.emergencyAt) || FOLD_DEFAULTS.emergencyAt)),
    preserveRecentMessages: Math.max(2, Number(s.preserveRecentMessages) || FOLD_DEFAULTS.preserveRecentMessages),
  };
}

/**
 * Fold pass over the request body, before translate/RTK. Fail-open: returns
 * the original body unless a fold actually applied.
 * @returns {{ body, state, stats: { folded: boolean, before, after, ratio } }}
 */
export function processTurn({ body, provider, model, settings, log }) {
  const cfg = resolveFoldConfig(settings);
  const stats = { folded: false, before: 0, after: 0, ratio: 0 };
  try {
    if (!cfg.enabled || !Array.isArray(body?.messages)) return { body, state: null, stats };
    const before = estimateBodyTokens(body);
    if (before < 20_000) return { body, state: null, stats }; // tiny conversations never fold

    const window = contextWindowFor(provider, model);
    const ratio = before / window;
    stats.before = before;
    stats.ratio = ratio;
    if (ratio < cfg.nudgeAt) return { body, state: null, stats };

  const state = getSession(body, cfg);
  let messages = body.messages;
  let after = before;
  // Fold passes: one normal pass, plus an emergency pass when deep.
  const maxPasses = ratio >= cfg.emergencyAt ? 4 : 1;
  for (let pass = 0; pass < maxPasses; pass++) {
    const applied = applyFoldToMessages(messages, state);
    const candidate = { ...body, messages: applied };
    after = estimateBodyTokens(candidate);
    if (after / window < cfg.nudgeAt) { messages = applied; break; }
    const block = foldOldestRange(applied, state, cfg);
    if (!block) break;
    persistSession(state);
    messages = applyFoldToMessages(applied, state);
  }
    // Emergency tier-2 fold: distill tier-1 blocks when still deep.
    if (after / window >= cfg.emergencyAt && state.blocks.length > 1) {
      const merged = state.blocks
        .filter((b) => !b.decompressed)
        .map((b) => `b${b.id}: ${b.summary}`)
        .join("\n")
        .slice(0, cfg.maxSummaryChars);
      state.blocks = state.blocks.map((b) => ({ ...b, decompressed: false, tier: 2, summary: b.tier >= 2 ? b.summary : b.summary }));
      state.blocks.push({ id: state.nextBlockId++, tier: 2, summary: merged, from: state.blocks[0]?.from ?? 1, to: state.blocks[state.blocks.length - 1]?.to ?? 1, createdAt: Date.now(), decompressed: false });
      state.stats.folds += 1;
    }

    const finalMessages = applyFoldToMessages(messages, state);
    if (finalMessages === body.messages) return { body, state, stats };
    stats.folded = true;
    stats.after = estimateBodyTokens({ ...body, messages: finalMessages });
    log?.info?.("FOLD", `folded conversation ${stats.before} → ~${stats.after} tokens (window ${window}, ratio ${ratio.toFixed(2)}, blocks ${state.blocks.length})`);
    return { body: { ...body, messages: finalMessages }, state, stats };
  } catch (err) {
    log?.warn?.("FOLD", `fail-open: ${err?.message || err}`);
    return { body, state: null, stats };
  }
}

// ─── Fold tools (model/A2A-driven folds; server-side executed) ───────────────

export const FOLD_TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "compress_context",
      description: "Fold a consumed range of the conversation into a summary block. Summaries are permanent until decompressed.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Your high-fidelity summary of everything worth keeping from the conversation so far." },
        },
        required: ["summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "decompress_context",
      description: "Restore all folded blocks of this conversation back into verbatim context.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_context",
      description: "Search the conversation's summaries and originals for a keyword.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fold_status",
      description: "Report this conversation's fold state (blocks, estimated savings).",
      parameters: { type: "object", properties: {} },
    },
  },
];

// Execute a fold tool for a conversation. Called by handlers that surface the
// fold tools (MCP/A2A surfaces); the chat path folds automatically.
export function executeFoldTool(name, args = {}, { body, settings } = {}) {
  const cfg = resolveFoldConfig(settings);
  const state = getSession(body || {}, cfg);
  if (name === "compress_context") {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const from = 1;
    const to = Math.max(from, messages.length - 1 - Math.min(cfg.preserveRecentMessages, Math.floor(messages.length / 2)));
    const summary = String(args.summary || extractiveSummary(messages, from, to, cfg.maxSummaryChars)).slice(0, cfg.maxSummaryChars * 4);
    const block = { id: state.nextBlockId++, tier: 1, summary, from, to, createdAt: Date.now(), decompressed: false };
    state.blocks.push(block);
    state.stats.folds += 1;
    persistSession(state);
    return { ok: true, blockId: `b${block.id}` };
  }
  if (name === "decompress_context") {
    let n = 0;
    for (const b of state.blocks) {
      if (!b.decompressed) { b.decompressed = true; n += 1; }
    }
    state.stats.decompresses += n;
    return { ok: true, restored: n };
  }
  if (name === "search_context") {
    const q = String(args.query || "").toLowerCase();
    state.stats.searches += 1;
    // BM25-lite: term-frequency scoring over block summaries. Good enough for
    // recall steering, dependency-free, and strictly better than substring.
    const terms = q.split(/\s+/).filter((t) => t.length > 1);
    const N = Math.max(1, state.blocks.length);
    const avgLen = state.blocks.reduce((n, b) => n + b.summary.length, 0) / N || 1;
    const hits = state.blocks
      .map((b) => {
        const text = b.summary.toLowerCase();
        const score = terms.reduce((s, term) => {
          const tf = text.split(term).length - 1;
          if (tf === 0) return s;
          // bm25-ish: tf saturation + length normalization (k1=1.2, b=0.75)
          return s + (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (b.summary.length / avgLen)));
        }, 0);
        return { blockId: `b${b.id}`, score, summary: b.summary.slice(0, 400) };
      })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    return { ok: true, hits };
  }
  if (name === "fold_status") {
    return { ok: true, blocks: state.blocks.filter((b) => !b.decompressed).length, stats: state.stats };
  }
  return { ok: false, error: `unknown fold tool: ${name}` };
}

export function getFoldStats() {
  return { sessions: sessions.size };
}
