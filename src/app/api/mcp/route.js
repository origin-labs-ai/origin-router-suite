// The OriginRouter MCP server — JSON-RPC 2.0 over the /api/mcp endpoint.
//
// The stdio↔SSE bridge (src/lib/mcp/stdioSseBridge.js) serves the local
// cowork plugins; THIS endpoint is the general MCP surface: any MCP client
// can POST JSON-RPC here and get the router's tools. Tool descriptions stay
// ≤ 200 chars per the MCP convention.
//
// Surface (v0.6.000):
//   list_models      — the publishable model catalog (registry + combos)
//   routing_plan     — how a combo WOULD route a body (strategy + ordered
//                      seats), deterministic and side-effect free
//   memory_stats     — the Memory Fabric stats (fail-open when disabled)
//   strategy_list    — the 24-strategy registry
//   fold_stats       — OriginFold session/block stats
//   harness_list     — the provider adapter harness registry
//
// Auth: the dashboard guard covers this endpoint globally (same as /api/combos);
// non-dashboard callers pass an OriginRouter API key the same way /v1 accepts.

import { NextResponse } from "next/server";
import { PROVIDERS, PROVIDER_MODELS } from "open-sse/providers/index.js";
import { listStrategies, normalizeStrategy } from "@/lib/routing/strategies.js";
import { getFoldStats } from "open-sse/fold/index.js";
import { listAdapters } from "open-sse/harness/index.js";
import { listExternalTools, callExternalTool, hubStatus } from "@/lib/mcp/hub.js";
import { getSettings } from "@/lib/localDb";

export const dynamic = "force-dynamic";

const PROTOCOL_VERSION = "2025-06-18";

// ─── Tool implementations ────────────────────────────────────────────────────

async function toolListModels() {
  const combos = [];
  try {
    const { getCombos } = await import("@/lib/localDb");
    const rows = await getCombos();
    for (const c of rows || []) combos.push(c.name);
  } catch { /* combos table unavailable — registry models still listed */ }
  const models = [];
  for (const [id, cfg] of Object.entries(PROVIDERS)) {
    const count = (PROVIDER_MODELS[id] || []).length;
    models.push({ id, models: count, kind: "provider" });
  }
  for (const name of combos) models.push({ id: name, kind: "combo" });
  return { models, total: models.length };
}

// How a combo WOULD route a body: strategy + ordered seats, no side effects.
// This is the deterministic routing-plan the A2A surface also reuses.
async function toolRoutingPlan(args) {
  const { getComboModelsFromData } = await import("open-sse/services/combo.js");
  const { orderSeats, getSeatStatsSnapshot } = await import("open-sse/services/comboOrderers.js");
  const { normalizeStrategy } = await import("@/lib/routing/strategies.js");
  const { getCombos } = await import("@/lib/localDb");
  const strategy = normalizeStrategy(args?.strategy || "fallback");
  const combos = args?.combo ? (await getCombos()) : null;
  const seats = Array.isArray(args?.seats) && args.seats.length > 0
    ? args.seats.map(String)
    : (getComboModelsFromData(String(args?.combo || ""), combos) || []);
  const ordered = orderSeats(seats, strategy, { comboName: args?.combo || "__mcp__", body: { messages: [{ role: "user", content: String(args?.prompt || "") }] } });
  return {
    strategy,
    seats: ordered,
    health: getSeatStatsSnapshot(args?.combo || "__mcp__"),
  };
}

async function toolMemoryStats() {
  try {
    const { memoryStats } = await import("@/lib/memoryFabric/index.js");
    return await memoryStats();
  } catch {
    return { enabled: false, note: "Memory Fabric not active" };
  }
}

// ─── MCP tool catalog ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "list_models",
    description: "List the publishable model catalog: providers with model counts plus combos.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "routing_plan",
    description: "Show how a combo would route a prompt: strategy, ordered seats, seat health.",
    inputSchema: {
      type: "object",
      properties: {
        combo: { type: "string" },
        strategy: { type: "string" },
        seats: { type: "array", items: { type: "string" } },
        prompt: { type: "string" },
      },
    },
  },
  {
    name: "memory_stats",
    description: "Memory Fabric statistics (entries, scopes, enabled state).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "strategy_list",
    description: "The 24 routing strategies with labels, hints and kinds.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "fold_stats",
    description: "OriginFold session and block statistics.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "harness_list",
    description: "Registered provider adapter harness entries.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mcp_hub_status",
    description: "MCP hub state: federated servers, their catalog entries, enable flags.",
    inputSchema: { type: "object", properties: {} },
  },
];

const DISPATCH = {
  list_models: toolListModels,
  routing_plan: toolRoutingPlan,
  memory_stats: toolMemoryStats,
  strategy_list: async () => ({ strategies: listStrategies() }),
  fold_stats: async () => getFoldStats(),
  harness_list: async () => ({ adapters: listAdapters() }),
  mcp_hub_status: async () => hubStatus(await getSettings()),
};

// ─── JSON-RPC 2.0 dispatch ───────────────────────────────────────────────────

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export async function POST(request) {
  let rpc = null;
  try {
    rpc = await request.json();
  } catch {
    return NextResponse.json(rpcError(null, -32700, "parse error"), { status: 400 });
  }
  const { id, method, params } = rpc || {};

  try {
    if (method === "initialize") {
      return NextResponse.json(rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "origin-router", version: "0.6.000" },
      }));
    }
    if (method === "ping") {
      return NextResponse.json(rpcResult(id, {}));
    }
    if (method === "tools/list") {
      // Merge: the router's own tools + every external MCP server's tools
      // (namespaced serverId:toolName). A dead external server contributes
      // an `externalErrors` note, never a failure of this surface.
      let external = { tools: [], errors: [] };
      try {
        external = await listExternalTools(await getSettings());
      } catch { /* hub misconfiguration — the local tools still answer */ }
      return NextResponse.json(rpcResult(id, {
        tools: [...TOOLS, ...external.tools],
        ...(external.errors.length ? { externalErrors: external.errors } : {}),
      }));
    }
    if (method === "tools/call") {
      const name = String(params?.name || "");
      // Namespaced names (`serverId:toolName`) belong to the hub.
      if (name.includes(":")) {
        const settings = await getSettings();
        const out = await callExternalTool(settings, name, params?.arguments || {});
        if (!out.ok) return NextResponse.json(rpcError(id, -32602, out.error || "external tool failed"));
        return NextResponse.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out.result) }] }));
      }
      const fn = DISPATCH[name];
      if (!fn) return NextResponse.json(rpcError(id, -32602, `unknown tool: ${name}`));
      const result = await fn(params?.arguments || {});
      // MCP wraps tool output in content blocks.
      return NextResponse.json(rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
      }));
    }
    return NextResponse.json(rpcError(id, -32601, `unknown method: ${method}`));
  } catch (err) {
    return NextResponse.json(rpcError(id, -32603, err?.message || String(err)));
  }
}

export async function GET() {
  return NextResponse.json({
    server: "origin-router",
    protocol: "mcp",
    protocolVersion: PROTOCOL_VERSION,
    tools: TOOLS.map((t) => t.name),
  });
}
