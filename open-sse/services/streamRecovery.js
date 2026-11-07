// Stream recovery — the FCC ContinuationSeed / DeliveredPrefix concept,
// native.
//
// When an upstream dies MID-STREAM (after HTTP 200), the fallback walk loses
// everything the client already received unless the retry carries it forward.
// The references solved this with two ideas:
//
//   DeliveredPrefix — a snapshot of what the client already received, in the
//   client's own protocol (text, thinking, tool-call fragments), retained up
//   to a bounded size.
//
//   ContinuationSeed — the next seat's request rebuilt so the generation
//   CONTINUES from the delivered suffix instead of starting cold: the
//   delivered assistant text becomes an assistant turn, and the model is
//   instructed to continue seamlessly.
//
// House rules: fail-open (a snapshot failure changes nothing), bounded
// (1 MB retention cap per seed, LRU of 50), and no protocol assumptions
// beyond the three wire shapes this repo already translates.

const SEED_CAP = 50;               // LRU of live seeds
const RETENTION_BYTES = 1024 * 1024; // 1 MB delivered-prefix cap
const MAX_TOOL_FRAGMENTS = 20;

const seeds = new Map(); // seedId → seed

function sweepSeeds(now) {
  for (const [k, s] of seeds) {
    if (now - s.createdAt > 10 * 60 * 1000) seeds.delete(k); // 10 min TTL
  }
  while (seeds.size > SEED_CAP) {
    const oldest = seeds.keys().next().value;
    if (oldest === undefined) break;
    seeds.delete(oldest);
  }
}

export function newSeedId() {
  return `sr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── DeliveredPrefix: accumulate what the client already received ───────────

/**
 * Create a delivery tracker for one request attempt.
 * feed(delta) ingests content deltas; snapshot() reads the state.
 */
export function createDeliveryTracker({ seedId, model } = {}) {
  const state = {
    seedId: seedId || newSeedId(),
    model: model || "",
    text: "",
    thinking: "",
    toolFragments: [], // { id, name, argsSoFar }
    unsafe: false,
    createdAt: Date.now(),
  };
  seeds.set(state.seedId, state);
  sweepSeeds(state.createdAt);

  return {
    get seedId() { return state.seedId; },

    /** Ingest an OpenAI-shaped chat delta. */
    feedDelta(delta) {
      try {
        if (!delta || typeof delta !== "object") return;
        if (typeof delta.content === "string" && delta.content) {
          state.text = clip(state.text + delta.content);
        }
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
          state.thinking = clip(state.thinking + delta.reasoning_content);
        }
        for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          const idx = Number(tc.index ?? 0);
          const frag = state.toolFragments[idx] || (state.toolFragments[idx] = { id: tc.id || "", name: "", args: "" });
          if (tc.id && !frag.id) frag.id = tc.id;
          if (tc.function?.name) frag.name = tc.function.name;
          if (typeof tc.function?.arguments === "string") frag.args = clip(frag.args + tc.function.arguments);
          if (state.toolFragments.length > MAX_TOOL_FRAGMENTS) state.unsafe = true;
        }
      } catch { /* fail-open: a tracker error never breaks the stream */ }
    },

    /** Snapshot for the continuation. */
    snapshot() {
      const hasToolCalls = state.toolFragments.some((f) => f.id);
      const canHandoff = !state.unsafe && (state.text.length > 0 || hasToolCalls);
      return {
        seedId: state.seedId,
        model: state.model,
        text: state.text,
        thinking: state.thinking,
        toolFragments: state.toolFragments.filter((f) => f.id),
        canHandoff,
        bytes: state.text.length + state.thinking.length,
      };
    },

    /** Drop the seed (call when the stream COMMITTED — a success needs no recovery). */
    commit() {
      seeds.delete(state.seedId);
    },
  };
}

function clip(s) {
  const out = String(s || "");
  return out.length > RETENTION_BYTES ? out.slice(out.length - RETENTION_BYTES) : out;
}

// ─── ContinuationSeed: rebuild the next seat's request ──────────────────────

/**
 * Build a continuation request from a delivered-prefix snapshot. The next
 * seat receives the ORIGINAL conversation plus an assistant turn carrying the
 * delivered text (and a continuation instruction), so generation resumes
 * instead of repeating.
 * @returns {{ body: object, applied: boolean } | null}
 */
export function buildContinuation({ body, snapshot } = {}) {
  try {
    if (!snapshot?.canHandoff || !Array.isArray(body?.messages)) return null;
    const messages = [...body.messages];
    const parts = [];
    if (snapshot.thinking) {
      parts.push({ role: "assistant-marker", text: `[Prior seat's reasoning so far]\n${snapshot.thinking}` });
    }
    if (snapshot.text) {
      messages.push({
        role: "assistant",
        content: snapshot.text,
      });
      messages.push({
        role: "user",
        content: "The previous assistant turn above was cut off mid-answer by a provider failure. Continue the answer seamlessly from exactly where it stopped — do not repeat what is already written, do not mention any interruption.",
      });
    } else if (parts.length > 0) {
      messages.push({ role: "user", content: parts[0].text });
    }
    if (!snapshot.text && !parts.length) return null;
    return { body: { ...body, messages }, applied: true };
  } catch {
    return null;
  }
}

/** Read a live seed without a tracker reference (for handlers resuming by id). */
export function getSnapshot(seedId) {
  const s = seeds.get(String(seedId || ""));
  return s ? {
    seedId: s.seedId,
    model: s.model,
    text: s.text,
    thinking: s.thinking,
    toolFragments: s.toolFragments.filter((f) => f.id),
    canHandoff: !s.unsafe && (s.text.length > 0),
    bytes: s.text.length + s.thinking.length,
  } : null;
}

export function seedStats() {
  return { live: seeds.size, cap: SEED_CAP, retentionBytes: RETENTION_BYTES };
}
