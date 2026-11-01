// PandaOrchestrator client — the model picker inside OriginRouter.
//
// Panda (https://github.com/aicodeking/PandaOrchestrator) is a local router: a
// 31 MB ONNX task profiler reads the actual task text, then a calibrated success
// head scores each candidate model by P(success), expected cost (failures
// included) and latency, and returns a ranked list plus an escalation ladder.
// The router asks it two questions:
//
//   • which of these models should carry this task (combo / smart selection)
//   • which of these provider seats should serve it next (failover order)
//
// Everything here fails open: Panda down, slow, or unsure of a model name means
// the router falls back to its own order — never a client-visible error.
import { getSettings } from "@/lib/localDb";
import { resolveRoutingPolicy } from "@/lib/routingPolicy";

const POOL_CAP = 50;
const TEXT_CAP = 6000;
const HEALTH_TTL_MS = 30000;

let health = { ok: false, checkedAt: 0, detail: null };

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block?.type === "text") return block.text || "";
      if (block?.type === "input_text" || block?.type === "output_text") return block.text || "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** The task text Panda profiles: the last real user turn. */
export function taskTextFrom(body) {
  const turns = [];
  if (Array.isArray(body?.messages)) {
    for (const message of body.messages) {
      if (["user", "human"].includes(message?.role)) turns.push(textOfContent(message.content));
    }
  }
  if (turns.length === 0 && Array.isArray(body?.input)) {
    for (const item of body.input) {
      if (item?.role === "user") turns.push(textOfContent(item.content ?? item));
    }
  }
  if (turns.length === 0 && Array.isArray(body?.contents)) {
    for (const item of body.contents) {
      if (item?.role === "user") turns.push(textOfContent(item.parts?.map((p) => p?.text).join(" ") || ""));
    }
  }
  const text = (turns.filter(Boolean).pop() || "").trim();
  return text.slice(0, TEXT_CAP);
}

function hasImages(body) {
  const raw = (() => {
    try {
      return JSON.stringify(body?.messages || body?.input || body?.contents || "");
    } catch {
      return "";
    }
  })();
  return /"(type|image_url)"\s*:\s*"(image|base64|image\/)/i.test(raw) || raw.includes("\"type\":\"image\"");
}

function contextFor(body, text) {
  return {
    estimated_input_tokens: Math.round(((text?.length || 0) + JSON.stringify(body || {}).length) / 4) + 500,
    requires_tools: Boolean(body?.tools?.length || body?.functions?.length || body?.tool_choice),
    has_images: hasImages(body),
  };
}

async function call(pathname, payload, policy) {
  const { baseUrl, timeoutMs } = policy.panda;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`${pathname} ${response.status}`);
  return await response.json();
}

export async function pandaHealth(force = false) {
  if (!force && Date.now() - health.checkedAt < HEALTH_TTL_MS) return health;
  const policy = resolveRoutingPolicy(await getSettings());
  if (!policy.panda.enabled) return { ...health, ok: false, detail: "disabled" };
  try {
    const response = await fetch(`${policy.panda.baseUrl}/health`, {
      signal: AbortSignal.timeout(policy.panda.timeoutMs),
      cache: "no-store",
    });
    const data = response.ok ? await response.json() : null;
    health = { ok: Boolean(data?.ok), checkedAt: Date.now(), detail: data };
  } catch (error) {
    health = { ok: false, checkedAt: Date.now(), detail: error?.message || String(error) };
  }
  return health;
}

/**
 * Ask Panda to order candidates.
 * @param {object} params
 * @param {Array<{key:string, route?:string, model?:string}>} params.candidates
 * @param {object} params.body request body (for the task text + context)
 * @param {object} params.policy resolved routing policy
 * @param {object} [params.log]
 * @returns {Promise<{ordered: Array, traceId: string|null, ranked: Array, difficulty: *, category: *}|null>}
 */
async function route({ candidates, body, policy, log }) {
  if (!policy.panda?.enabled || candidates.length < 2) return null;
  if (!(await pandaHealth()).ok) return null;

  const text = taskTextFrom(body);
  if (!text) return null;

  // Panda echoes the caller's string as model_id, so every spelling we send is a
  // usable key back. Bare model ids are added too: cards are named after models,
  // not after `provider/model` routes.
  const pool = [];
  const keyOf = new Map();
  for (const candidate of candidates.slice(0, POOL_CAP)) {
    for (const name of [candidate.route, candidate.model]) {
      if (!name || keyOf.has(name)) continue;
      pool.push(name);
      keyOf.set(name, candidate.key);
    }
  }
  if (pool.length < 2) return null;

  const request = {
    task: { text, context: contextFor(body, text) },
    pool,
    preferences: {
      mode: policy.panda.mode,
      min_p_success: policy.panda.minPSuccess,
      explore_epsilon: policy.panda.exploreEpsilon,
    },
    return_top_k: Math.min(POOL_CAP, pool.length),
  };

  try {
    const response = await call("/route", request, policy);
    const seen = new Set();
    const ordered = [];
    for (const entry of [...(response.escalation_ladder || []), ...(response.ranking || [])]) {
      const key = keyOf.get(entry.model_id);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const candidate = candidates.find((item) => item.key === key);
      if (candidate) ordered.push({ ...candidate, panda: entry, cardId: entry.card_id || null });
    }
    // Anything Panda did not recognise (no card for it) keeps its original place
    // at the end rather than being dropped: it is still a seat worth trying.
    const rest = candidates.filter((item) => !seen.has(item.key));
    log?.debug?.("PANDA", `ranked ${ordered.length}/${candidates.length} (difficulty=${response.difficulty?.level ?? "?"}, category=${response.category?.label ?? "?"}, trace=${response.trace_id})`);
    return {
      ordered: [...ordered, ...rest],
      ranked: ordered.map((item) => ({ key: item.key, p: item.panda?.p_success, cost: item.panda?.est_cost_usd })),
      traceId: response.trace_id || null,
      difficulty: response.difficulty || null,
      category: response.category || null,
      request,
      response,
    };
  } catch (error) {
    health = { ok: false, checkedAt: Date.now(), detail: error?.message || String(error) };
    log?.warn?.("PANDA", `route failed, using local order (${error?.message || error})`);
    return null;
  }
}

/** Order a list of plain strings (combo members). */
export async function rankStrings({ items, body, policy, log }) {
  const candidates = items.map((item) => ({ key: item, model: item }));
  const result = await route({ candidates, body, policy, log });
  if (!result) return null;
  return { ...result, items: result.ordered.map((entry) => entry.key) };
}

/** Order provider seats for one model id. */
export async function rankRoutes({ routes, body, policy, log }) {
  const candidates = routes.map((route) => ({
    key: route.route,
    route: route.route,
    model: route.model,
    ref: route,
  }));
  const result = await route({ candidates, body, policy, log });
  if (!result) return null;
  return { ...result, routes: result.ordered.map((entry) => entry.ref) };
}

/**
 * A seat failed on this task: ask Panda for the next one (the failure is
 * evidence the task is harder, so it re-grades difficulty).
 */
export async function escalate({ request, response, failedKey, policy, log }) {
  if (!policy.panda?.enabled || !request || !response || !failedKey) return null;
  if (response.choice?.model_id !== failedKey && !(response.escalation_ladder || []).some((l) => l.model_id === failedKey)) {
    // Panda requires the failed model to be one it picked or laddered.
  }
  try {
    const next = await call("/escalate", { request, response, failed_model_id: failedKey }, policy);
    return next;
  } catch (error) {
    log?.debug?.("PANDA", `escalate skipped (${error?.message || error})`);
    return null;
  }
}

/** Close the loop: report what happened, so a later refit has real data. */
export async function recordOutcome({ traceId, modelId, success, costUsd = 0, latencyMs = 0, tokens = null, policy }) {
  if (!policy?.panda?.enabled || !traceId || !modelId) return;
  try {
    await call("/outcome", {
      trace_id: traceId,
      model_id: modelId,
      success: Boolean(success),
      actual_cost_usd: costUsd || undefined,
      actual_latency_ms: latencyMs || undefined,
      ...(tokens ? { tokens } : {}),
    }, policy);
  } catch {
    // Outcome logging is never worth failing a request over.
  }
}
