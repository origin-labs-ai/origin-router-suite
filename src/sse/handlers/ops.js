import { extractApiKey, isValidApiKey } from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { getCombos, createCombo, getComboById, deleteCombo } from "@/lib/db/repos/combosRepo.js";
import { getUsageStats } from "@/lib/db/repos/usageRepo.js";
import { listStrategies, normalizeStrategy } from "@/lib/routing/strategies.js";
import { orderSeats, getSeatStatsSnapshot } from "open-sse/services/comboOrderers.js";
import { createAgent, getAgent, listAgents, updateAgent, deleteAgent } from "@/lib/db/repos/agentsRepo.js";

// Operations surface: deterministic routing introspection, combo management,
// quota snapshots and a lightweight agent registry. These are read-mostly
// admin endpoints; they never spend upstream tokens.

const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };
const COMBO_NAME_RE = /^[a-zA-Z0-9_.\-]+$/;

export function preflight() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

function jsonResponse(body, status = 200) {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

async function requireKey(request) {
  const settings = await getSettings();
  if (!settings.requireApiKey) return null;
  const apiKey = extractApiKey(request);
  if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
  const valid = await isValidApiKey(apiKey);
  if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  return null;
}

// ── Routing explain ─────────────────────────────────────────────────────────

/** GET /v1/explain/routing — the strategy registry. */
export async function handleRoutingStrategies(request) {
  const blocked = await requireKey(request);
  if (blocked) return blocked;
  return jsonResponse({ object: "list", data: listStrategies() });
}

/**
 * POST /v1/explain/routing — how a body WOULD route across seats.
 * Body: { seats: string[], strategy?, model?, messages? }
 * Deterministic and side-effect free: no request is sent upstream.
 */
export async function handleExplainRouting(request) {
  const blocked = await requireKey(request);
  if (blocked) return blocked;
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }
  const seats = Array.isArray(body?.seats) ? body.seats.map(String) : [];
  if (!seats.length) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: seats");

  const strategy = normalizeStrategy(body?.strategy || "auto");
  const ordered = orderSeats(seats, strategy, {
    comboName: "__explain__",
    body: { model: body?.model, messages: Array.isArray(body?.messages) ? body.messages : [] },
  });
  return jsonResponse({
    strategy,
    seats,
    ordered,
    seatStats: getSeatStatsSnapshot("__explain__"),
  });
}

// ── Combos ──────────────────────────────────────────────────────────────────

/** GET /v1/combos — list combos; POST /v1/combos — create one. */
export async function handleCombos(request) {
  const blocked = await requireKey(request);
  if (blocked) return blocked;
  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
    }
    if (!body?.name) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: name");
    if (!COMBO_NAME_RE.test(body.name)) {
      return errorResponse(HTTP_STATUS.BAD_REQUEST, "Name can only contain letters, numbers, -, _ and .");
    }
    const combo = await createCombo(body);
    return jsonResponse(combo);
  }
  return jsonResponse({ object: "list", data: await getCombos() });
}

/** GET /v1/combos/{id} — read one; DELETE — remove one. */
export async function handleCombo(request, id) {
  const blocked = await requireKey(request);
  if (blocked) return blocked;
  const combo = await getComboById(id);
  if (!combo) return errorResponse(HTTP_STATUS.NOT_FOUND, `No such combo: ${id}`);
  if (request.method === "DELETE") {
    await deleteCombo(id);
    return jsonResponse({ id, object: "combo", deleted: true });
  }
  return jsonResponse(combo);
}

// ── Quotas ──────────────────────────────────────────────────────────────────

/**
 * GET /v1/quotas/check — the same usage/quota snapshot the dashboard reads.
 * Query: period=24h|7d|30d|all (default 24h).
 */
export async function handleQuotaCheck(request) {
  const blocked = await requireKey(request);
  if (blocked) return blocked;
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") || "24h";
  const stats = await getUsageStats(period);
  return jsonResponse({ period, ...stats });
}

// ── Agents ──────────────────────────────────────────────────────────────────

/** GET /v1/agents — list agents; POST — create one. */
export async function handleAgents(request) {
  const blocked = await requireKey(request);
  if (blocked) return blocked;
  if (request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
    }
    if (!body?.name) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: name");
    return jsonResponse(await createAgent(body));
  }
  return jsonResponse({ object: "list", data: await listAgents() });
}

/** GET /v1/agents/{id} — read one; PATCH — update; DELETE — remove. */
export async function handleAgent(request, id) {
  const blocked = await requireKey(request);
  if (blocked) return blocked;
  const agent = await getAgent(id);
  if (!agent) return errorResponse(HTTP_STATUS.NOT_FOUND, `No such agent: ${id}`);
  if (request.method === "DELETE") {
    return jsonResponse(await deleteAgent(id));
  }
  if (request.method === "PATCH" || request.method === "PUT") {
    let body;
    try {
      body = await request.json();
    } catch {
      return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
    }
    return jsonResponse(await updateAgent(id, body));
  }
  return jsonResponse(agent);
}
