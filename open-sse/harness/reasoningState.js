// Reasoning state preservation — the harness half that keeps strict
// thinking-mode upstreams (DeepSeek, Gemini thinking, Kiro) from rejecting
// follow-up turns that reference earlier tool calls without their reasoning.
//
// Ported concept (the references' reasoning-replay cache, adapted to this
// repo's house style):
//   - captureReasoning({ model, response })  — silently extracts assistant
//     reasoning_content blocks keyed by the tool_call.id they accompany (and
//     by transcript digest for plain turns) into an LRU.
//   - replayReasoning({ model, messages })   — returns { messages } (an
//     augmented copy) with prior reasoning re-attached where the same
//     tool_call ids reappear. Hard-capped at 20 injected blocks per request.
//
// House rules: fail-open everywhere (a cache miss never blocks a request),
// bounded memory (200 entries, 2h TTL), and a pluggable persist hook for
// later disk storage. No crypto, no network, no I/O by default.

const CAP = 200;
const TTL_MS = 2 * 60 * 60 * 1000; // 2h
const MAX_INJECT = 20;             // hard cap per request
const MAX_BLOCK_CHARS = 16_000;    // per-block clamp

const cache = new Map(); // key → { reasoning, toolCallId, model, at }

function sweep(now) {
  for (const [k, v] of cache) {
    if (now - v.at > TTL_MS) cache.delete(k);
  }
  while (cache.size > CAP) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// Optional persist hook (wire a disk/SQLite store later without touching this
// module again).
let persistHook = null;
export function setReasoningStateStore(fn) {
  persistHook = typeof fn === "function" ? fn : null;
}

function keyOf(model, toolCallId, digest) {
  return `${model || "?"}\u0000${toolCallId || `digest:${digest || ""}`}`;
}

// Transcript digest for plain (non-tool) turns: hash of the last few message
// roles + short content heads. Not cryptographic — just a stable grouping key.
function transcriptDigest(messages) {
  const parts = [];
  for (const m of (messages || []).slice(-4)) {
    const text = typeof m?.content === "string" ? m.content : JSON.stringify(m?.content || "");
    parts.push(`${m?.role}:${text.slice(0, 80)}`);
  }
  let h = 5381;
  for (const ch of parts.join("\u0000")) h = ((h << 5) + h + ch.charCodeAt(0)) | 0;
  return String(h >>> 0);
}

// Extract reasoning + tool_call ids from an assistant message (OpenAI shape;
// Claude thinking blocks are handled via the reasoning_content analog).
function extractFromAssistantMessage(msg) {
  const out = [];
  const reasoning = typeof msg?.reasoning_content === "string"
    ? msg.reasoning_content
    : Array.isArray(msg?.content)
      ? msg.content.filter((c) => c?.type === "reasoning" || c?.type === "thinking").map((c) => c?.thinking || c?.text || "").join("\n")
      : "";
  if (!reasoning) return out;
  const calls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
  if (calls.length > 0) {
    for (const call of calls) {
      const id = call?.id || "";
      if (id) out.push({ toolCallId: id, reasoning });
    }
  } else {
    out.push({ toolCallId: null, reasoning });
  }
  return out;
}

/**
 * Capture reasoning from a completed response. Silent on any error or shape
 * mismatch — capture is an optimization, never a dependency.
 * @param {{ model?: string, response?: object }} params
 */
export function captureReasoning({ model, response } = {}) {
  try {
    const now = Date.now();
    const choices = Array.isArray(response?.choices) ? response.choices : [];
    for (const choice of choices) {
      const msg = choice?.message;
      for (const block of extractFromAssistantMessage(msg)) {
        const key = keyOf(model, block.toolCallId, null);
        cache.set(key, { reasoning: String(block.reasoning).slice(0, MAX_BLOCK_CHARS), model, toolCallId: block.toolCallId, at: now });
      }
      // Plain turns: key by transcript digest of the REQUEST that produced this
      // answer — approximated here by the assistant content digest (the caller
      // can pass the request digest via captureDigest for exactness).
      if (choices.length === 1 && !msg?.tool_calls?.length) {
        const digest = transcriptDigest([{ role: "assistant", content: msg?.content || "" }]);
        cache.set(keyOf(model, null, digest), { reasoning: String(extractFromAssistantMessage(msg)[0]?.reasoning || "").slice(0, MAX_BLOCK_CHARS), model, toolCallId: null, at: now });
      }
    }
    sweep(now);
    if (persistHook) {
      try { persistHook({ type: "capture", size: cache.size }); } catch { /* hook fails open */ }
    }
  } catch { /* fail open */ }
}

/**
 * Replay reasoning into a request's message list. Returns { messages } — the
 * SAME array when nothing matched (no copy, no churn), an augmented copy when
 * blocks were injected. Never exceeds MAX_INJECT blocks.
 * @param {{ model?: string, messages?: Array }} params
 */
export function replayReasoning({ model, messages } = {}) {
  try {
    if (!Array.isArray(messages) || messages.length === 0) return { messages: messages || [] };
    const now = Date.now();
    sweep(now);
    const out = [...messages];
    let injected = 0;
    for (let i = 0; i < out.length && injected < MAX_INJECT; i++) {
      const msg = out[i];
      if (msg?.role !== "tool") continue;
      const toolCallId = msg?.tool_call_id || "";
      if (!toolCallId) continue;
      const hit = cache.get(keyOf(model, toolCallId, null));
      if (!hit || !hit.reasoning) continue;
      // Attach the prior reasoning to the assistant turn that made the call
      // (the message right before the tool result), when it lacks its own.
      for (let j = i - 1; j >= 0; j--) {
        if (out[j]?.role === "assistant") {
          if (out[j]?.reasoning_content) break; // already has reasoning — leave untouched
          out[j] = { ...out[j], reasoning_content: hit.reasoning };
          injected += 1;
          break;
        }
      }
    }
    return { messages: injected > 0 ? out : messages };
  } catch {
    return { messages };
  }
}

/** Stats for the MCP surface and dashboards. */
export function reasoningStats() {
  return { entries: cache.size, cap: CAP, ttlMs: TTL_MS, maxInject: MAX_INJECT };
}

/** Test/dev helper: drop everything. */
export function clearReasoningState() {
  cache.clear();
}
