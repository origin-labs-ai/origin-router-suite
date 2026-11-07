// MCP Hub — federation of external MCP servers over HTTP.
//
// The router's /api/mcp surface merges external MCP servers into the SAME
// tools/list (namespaced `serverId:toolName`) and proxies tools/call to the
// owning server. The references shipped one giant in-process catalog; this
// is the federation answer — no third-party code is vendored or spawned by
// the router. The owner runs any MCP server themselves (npx, docker,
// whatever) and points the hub at its URL.
//
// SECURITY SHAPE (deliberate, scanner-enforced):
//   - The router never spawns a process for the hub. Federation is fetch-only.
//   - Server URLs come from settings, but every request passes assertSafeUrl:
//     http/https only; https for any host, http ONLY for the explicit
//     loopback exception (127.0.0.1 / localhost) because local MCP servers
//     are the entire point — the same posture the local-model engines use.
//   - A dead external server contributes zero tools and one error line; it
//     can never break the router's own surface.
//
// House rules: plain JS ESM, bounded state, fail-open, no credentials here
// (auth headers come from the server's own settings entry if the owner set
// one, passed verbatim as a single header value they configured).

// ─── Config ──────────────────────────────────────────────────────────────────

export const MCP_HUB_DEFAULTS = {
  enabled: false,
  servers: [
    {
      id: "rea",
      name: "REA (Reverse Engineer Anything)",
      // The owner starts REA's HTTP surface themselves, e.g.
      //   npx -y rea-agents@6.4.0 --http --port 7800
      // and the hub merges its 170 tools from http://127.0.0.1:7800.
      url: "http://127.0.0.1:7800",
      enabled: false,
    },
  ],
};

const LIST_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;
const TOOL_CAP_PER_SERVER = 300;

function validServerId(id) {
  return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(id);
}

export function resolveHubConfig(settings) {
  const s = settings?.mcpHub || {};
  const on = Array.isArray(s.enabledServers) ? s.enabledServers.filter((id) => typeof id === "string") : [];
  const configured = Array.isArray(s.servers) ? s.servers : [];
  const servers = MCP_HUB_DEFAULTS.servers
    .map((base) => {
      // A settings-level `servers` entry may override the default URL (the
      // owner can point REA at a different local port); the id/command stay
      // catalog-bound. Anything unknown in settings is ignored.
      const override = configured.find((c) => c && validServerId(c?.id) && c.id === base.id);
      return {
        ...base,
        ...(override?.url && typeof override.url === "string" ? { url: String(override.url).trim() } : {}),
        enabled: on.includes(base.id),
      };
    })
    .filter((srv) => srv.enabled)
    .slice(0, 16); // bounded federation
  return { enabled: s.enabled === true, servers };
}

// ─── URL guard (the scanner-approved shape: fetch-only, validated) ──────────

export function assertSafeUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch {
    throw new Error("invalid mcp server url");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("mcp url must be http/https");
  const host = u.hostname.toLowerCase();
  // Private/reserved ranges beyond loopback are refused first (an MCP server
  // on the LAN is not a supported posture; expose it over https if needed).
  if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host)) {
    throw new Error("private-range mcp servers are refused");
  }
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  if (u.protocol === "http:" && !isLoopback) {
    throw new Error("plain http is only allowed for loopback mcp servers");
  }
  return u;
}

async function hubFetch(url, body, timeoutMs) {
  const u = assertSafeUrl(url);
  const res = await fetch(u, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`mcp server answered ${res.status}`);
  const text = await res.text();
  // Streamable-MCP responses may arrive as SSE; take the first data: payload.
  if (text.startsWith("data:")) {
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        try { return JSON.parse(line.slice(5).trim()); } catch { break; }
      }
    }
    throw new Error("mcp server sent no parseable data payload");
  }
  return JSON.parse(text);
}

function rpcId() {
  return Math.floor(Math.random() * 2_000_000_000) + 1;
}

// ─── Public hub API ──────────────────────────────────────────────────────────

/**
 * List every external tool, namespaced `serverId:toolName`. A dead or
 * unresponsive server contributes zero tools and one error line.
 */
export async function listExternalTools(settings) {
  const cfg = resolveHubConfig(settings);
  const tools = [];
  const errors = [];
  if (!cfg.enabled) return { tools, errors };
  for (const server of cfg.servers) {
    if (!server.enabled) continue;
    try {
      const payload = await hubFetch(
        server.url,
        { jsonrpc: "2.0", id: rpcId(), method: "tools/list", params: {} },
        LIST_TIMEOUT_MS,
      );
      if (payload.error) throw new Error(payload.error.message || "tools/list failed");
      for (const tool of (payload.result?.tools || []).slice(0, TOOL_CAP_PER_SERVER)) {
        tools.push({
          name: `${server.id}:${tool.name}`,
          description: String(tool.description || "").slice(0, 200),
          inputSchema: tool.inputSchema || { type: "object", properties: {} },
          serverId: server.id,
        });
      }
    } catch (err) {
      errors.push(`${server.id}: ${err?.message || String(err)}`);
    }
  }
  return { tools, errors };
}

/** Proxy tools/call to the owning server (name carries `serverId:toolName`). */
export async function callExternalTool(settings, name, args = {}) {
  const cfg = resolveHubConfig(settings);
  if (!cfg.enabled) return { ok: false, error: "mcp hub disabled" };
  const sep = String(name || "").indexOf(":");
  if (sep <= 0) return { ok: false, error: "not an external tool" };
  const serverId = name.slice(0, sep);
  const toolName = name.slice(sep + 1);
  const server = cfg.servers.find((s) => s.id === serverId && s.enabled);
  if (!server) return { ok: false, error: `unknown mcp server: ${serverId}` };
  try {
    const payload = await hubFetch(
      server.url,
      { jsonrpc: "2.0", id: rpcId(), method: "tools/call", params: { name: toolName, arguments: args } },
      CALL_TIMEOUT_MS,
    );
    if (payload.error) return { ok: false, error: payload.error.message || "tools/call failed" };
    return { ok: true, result: payload.result };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/** Hub status for the dashboard / mcp_hub_status tool. */
export function hubStatus(settings) {
  const cfg = resolveHubConfig(settings);
  return {
    enabled: cfg.enabled,
    servers: cfg.servers.map(({ id, name, url, enabled }) => ({ id, name, url, enabled })),
    defaults: MCP_HUB_DEFAULTS.servers.map(({ id, name, url }) => ({ id, name, url })),
  };
}
