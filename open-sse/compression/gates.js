// Compression gates — fidelity, risk and exclusions, around the engine
// registry (open-sse/compression/registry.js).
//
//   fidelityGate — after an engine step, the payload must still carry every
//                  structural marker it had: the same role sequence (no
//                  message dropped unless it was an exact duplicate),
//                  tool_call ids intact, non-empty content. A violation rolls
//                  the step back.
//   riskGate     — spans that look like credentials (sk-…, AKIA…, bearer
//                  tokens) are shielded from lossy engines; for the built-in
//                  lossless engines it only records what it would have
//                  shielded, so the stats stay honest.
//   exclusions   — per-provider/model glob-ish skip list; a model excluded
//                  from an engine never gets that engine applied.

import { iterEngines } from "./registry.js";

// ─── Fidelity gate ───────────────────────────────────────────────────────────

function roleSeq(messages) {
  return (messages || []).map((m) => String(m?.role || "?"));
}

function toolCallIds(messages) {
  const ids = [];
  for (const m of messages || []) {
    for (const tc of Array.isArray(m?.tool_calls) ? m.tool_calls : []) {
      if (tc?.id) ids.push(tc.id);
    }
  }
  return ids;
}

// Structural fidelity check: roles must be a subsequence of the original,
// every original tool_call id must survive, and no surviving message may
// have lost non-empty string content.
export function fidelityOk(before, after) {
  try {
    if (!Array.isArray(after) || after.length === 0) return Array.isArray(before) ? before.length === 0 : false;
    const aRoles = roleSeq(after);
    const bRoles = roleSeq(before);
    // Subsequence check (dedup engines legitimately remove messages).
    let bi = 0;
    for (const role of aRoles) {
      while (bi < bRoles.length && bRoles[bi] !== role) bi += 1;
      if (bi >= bRoles.length) return false;
      bi += 1;
    }
    const aIds = new Set(toolCallIds(after));
    for (const id of toolCallIds(before)) {
      if (!aIds.has(id)) return false;
    }
    for (const m of after) {
      if (m?.role !== "assistant" && typeof m?.content === "string" && m.content.length === 0) return false;
    }
    return true;
  } catch {
    return false; // can't verify → refuse the step
  }
}

// ─── Risk gate ───────────────────────────────────────────────────────────────

// Spans that look like live credentials. Lossy engines must not see them;
// the shield masks them for the engine pass and unmasks after.
const RISK_PATTERNS = [
  /sk-[A-Za-z0-9]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /Bearer\s+[A-Za-z0-9._\-]{20,}/g,
  /ghp_[A-Za-z0-9]{30,}/g,
];

function shieldSpans(text) {
  const vault = [];
  let masked = String(text || "");
  // Apply each pattern in turn — String.replace accepts one pattern, not an
  // array of them.
  for (const pattern of RISK_PATTERNS) {
    masked = masked.replace(pattern, (m) => {
      vault.push(m);
      return `\u0000RISK${vault.length - 1}\u0000`;
    });
  }
  return { masked, vault };
}

function unshieldSpans(text, vault) {
  return String(text || "").replace(/\u0000RISK(\d+)\u0000/g, (_, i) => vault[Number(i)] ?? "");
}

export function applyRiskShield(messages) {
  const shielded = [];
  const out = (messages || []).map((m) => {
    if (typeof m?.content !== "string") return m;
    const { masked, vault } = shieldSpans(m.content);
    if (vault.length === 0) return m;
    shielded.push(vault.length);
    return { ...m, content: masked, __riskVault: vault };
  });
  return { messages: out, shielded: shielded.reduce((a, b) => a + b, 0) };
}

export function removeRiskShield(messages) {
  return (messages || []).map((m) => {
    if (!m?.__riskVault) return m;
    const { __riskVault, ...rest } = m;
    return { ...rest, content: unshieldSpans(rest.content, __riskVault) };
  });
}

// ─── Exclusions ──────────────────────────────────────────────────────────────

// provider/model exclusion list (glob-ish: * wildcards). Ships empty; the
// dashboard/settings can populate it later via settings.compressionExclusions.
let exclusions = [];

export function setCompressionExclusions(list) {
  exclusions = Array.isArray(list) ? list.map(String) : [];
}

export function getCompressionExclusions() {
  return [...exclusions];
}

function globMatch(pattern, value) {
  const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");
  return re.test(String(value || ""));
}

export function isExcluded(provider, model, engineId) {
  const target = `${provider}/${model}`;
  return exclusions.some((e) => {
    const [who, engine] = String(e).split("::");
    if (engine && engine !== "*" && engine !== engineId) return false;
    return globMatch(who, target) || globMatch(who, provider) || globMatch(who, model);
  });
}

// ─── The pipeline runner ─────────────────────────────────────────────────────

/**
 * Run the compression pipeline over a message list.
 * @returns {{ messages, applied: string[], savedBytes: number }}
 */
export function runCompressionPipeline({ messages, provider, model } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: messages || [], applied: [], savedBytes: 0 };
  }
  const before = JSON.stringify(messages).length;
  let current = messages;
  const applied = [];
  for (const engine of iterEngines()) {
    try {
      if (isExcluded(provider, model, engine.id)) continue;
      const candidate = engine.apply(current, { provider, model });
      if (!fidelityOk(current, candidate)) continue; // gate refusal = skip step
      current = candidate;
      applied.push(engine.id);
    } catch { /* engine error = skip step */ }
  }
  const after = JSON.stringify(current).length;
  return { messages: current, applied, savedBytes: Math.max(0, before - after) };
}
