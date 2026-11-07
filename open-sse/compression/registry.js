// Compression engine registry — the stacked-pipeline concept, native.
//
// The references ran a stack of compression engines (session-dedup, lite,
// relevance, …) ordered by stackPriority, wrapped in gates. v0.6.000 lands
// the registry + gates + the two lossless engines that are safe by
// construction:
//
//   session-dedup — identical consecutive tool_result blocks collapse
//   lite          — trailing-whitespace/format cleanup inside text blocks
//
// Lossy engines (aggressive/ultra/llmlingua) stay with the fusion pack: they
// need eval harnesses before they are trustworthy. The registry accepts them
// the moment a pack registers them — engines are first-class plugins.
//
// House rules: engines are pure message-list → message-list functions,
// fail-open (an engine error leaves the payload untouched), and the gates
// run BETWEEN engines so a bad step is rolled back, not shipped.

// ─── Engine registry ─────────────────────────────────────────────────────────

const engines = new Map(); // id → { id, stackPriority, lossy, apply(messages, ctx) }

export function registerEngine(engine) {
  try {
    if (!engine?.id || typeof engine.apply !== "function") return false;
    engines.set(engine.id, {
      id: engine.id,
      stackPriority: Number(engine.stackPriority) || 50,
      lossy: engine.lossy === true,
      apply: engine.apply,
    });
    return true;
  } catch {
    return false;
  }
}

export function unregisterEngine(id) {
  engines.delete(id);
}

export function listEngines() {
  return [...engines.values()]
    .sort((a, b) => a.stackPriority - b.stackPriority)
    .map(({ id, stackPriority, lossy }) => ({ id, stackPriority, lossy }));
}

// Full engine objects (with apply) for the pipeline runner — listEngines is
// the safe metadata view for dashboards; this is the internal iteration API.
export function iterEngines() {
  return [...engines.values()].sort((a, b) => a.stackPriority - b.stackPriority);
}

// ─── Built-in lossless engines ───────────────────────────────────────────────

function msgText(m) {
  return typeof m?.content === "string" ? m.content : "";
}

// session-dedup: collapse IDENTICAL consecutive tool_result/tool blocks.
// Coding agents re-send unchanged tool outputs on every turn; duplicates
// within a transcript are pure waste and perfectly safe to merge.
const sessionDedup = {
  id: "session-dedup",
  stackPriority: 10,
  lossy: false,
  apply(messages) {
    const out = [];
    for (const m of messages) {
      const prev = out[out.length - 1];
      const isTool = m?.role === "tool" || m?.role === "tool_result";
      const prevIsTool = prev?.role === "tool" || prev?.role === "tool_result";
      if (isTool && prevIsTool && msgText(m) === msgText(prev) && (m.tool_call_id || "") === (prev.tool_call_id || "")) {
        continue; // identical consecutive duplicate
      }
      out.push(m);
    }
    return out;
  },
};

// lite: trailing-whitespace cleanup inside string content. Lossless for chat
// semantics; the model never sees trailing spaces anyway.
const lite = {
  id: "lite",
  stackPriority: 20,
  lossy: false,
  apply(messages) {
    return messages.map((m) => {
      if (typeof m?.content === "string" && /[ \t]+\n/.test(m.content)) {
        return { ...m, content: m.content.replace(/[ \t]+\n/g, "\n") };
      }
      if (Array.isArray(m?.content)) {
        let changed = false;
        const parts = m.content.map((c) => {
          if (typeof c?.text === "string" && /[ \t]+\n/.test(c.text)) {
            changed = true;
            return { ...c, text: c.text.replace(/[ \t]+\n/g, "\n") };
          }
          return c;
        });
        return changed ? { ...m, content: parts } : m;
      }
      return m;
    });
  },
};

registerEngine(sessionDedup);
registerEngine(lite);
