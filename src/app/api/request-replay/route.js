import { NextResponse } from "next/server";
import { getRequestDetailById } from "@/lib/usageDb";
import { buildReplayRequest, summarizeReplay } from "@/lib/requestReplay.js";
import { getApiKeys } from "@/lib/localDb";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CLI_TOKEN_HEADER = "x-9r-cli-token";
const CLI_TOKEN_SALT = "9r-cli-auth";

// How much of the answer comes back to the browser. The full body stays on the
// router; the dialog only needs enough to judge what came back.
const PREVIEW_LIMIT = 2000;
const REPLAY_TIMEOUT_MS = 120000;

// The replay goes to the same router instance the dashboard is talking to: the
// port comes from the request the browser made, so a router listening on a
// non-default port replays into itself and not into whatever else answers on
// the default one.
function resolveLocalBaseUrl(request) {
  const host = request.headers.get("host") || "";
  const port = host.includes(":") ? host.slice(host.lastIndexOf(":") + 1) : "";
  const resolved = /^\d+$/.test(port) ? port : (process.env.PORT || String(UPDATER_CONFIG.appPort));
  return `http://127.0.0.1:${resolved}`;
}

// The router authenticates its own LLM API with one of its API keys, and the
// machine token lets the request past the dashboard guard. Both stay here — the
// response only ever carries the upstream status and body, never the key.
async function buildInternalHeaders() {
  let apiKey = null;
  try {
    const keys = await getApiKeys();
    // Prefer an unrestricted key so a replay is not refused just because the
    // first key happens to be restricted.
    const activeKeys = keys.filter((k) => k.isActive !== false);
    apiKey = (activeKeys.find((k) => !k.access?.restricted) || activeKeys[0])?.key || null;
  } catch {}

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  headers[CLI_TOKEN_HEADER] = await getConsistentMachineId(CLI_TOKEN_SALT);
  return headers;
}

async function loadRecord(id) {
  return await getRequestDetailById(id);
}

/**
 * GET /api/request-replay?id=<id>
 * Returns the stored request as it would be sent again, without sending it.
 * The request log keeps the full conversation body, so this answers for one
 * named record only — the bulk list stays redacted.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    const record = await loadRecord(id);
    if (!record) {
      return NextResponse.json({ error: "No stored request found for that id" }, { status: 404 });
    }

    const replay = buildReplayRequest(record);
    const summary = summarizeReplay(record);

    return NextResponse.json({
      ...summary,
      replayable: replay.replayable === true,
      reason: replay.replayable ? null : replay.reason,
      endpoint: replay.endpoint ?? summary.endpoint,
      method: replay.method ?? summary.method,
      headers: replay.headers ?? null,
      body: replay.body ?? null,
      description: replay.description ?? null,
    });
  } catch (error) {
    console.error("[API] Failed to load the request for replay:", error);
    return NextResponse.json({ error: "Failed to load the request for replay" }, { status: 500 });
  }
}

/**
 * POST /api/request-replay  { id }
 * Sends the stored request to the local router again and reports what came
 * back: the status code of the replayed request and a preview of its body.
 */
export async function POST(request) {
  try {
    const payload = await request.json().catch(() => null);
    const id = payload?.id;
    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    const record = await loadRecord(id);
    if (!record) {
      return NextResponse.json({ error: "No stored request found for that id" }, { status: 404 });
    }

    const replay = buildReplayRequest(record);
    if (!replay.replayable) {
      return NextResponse.json({ error: replay.reason, replayable: false }, { status: 400 });
    }

    const baseUrl = resolveLocalBaseUrl(request);
    const internalHeaders = await buildInternalHeaders();
    const startedAt = Date.now();

    let upstream;
    try {
      upstream = await fetch(`${baseUrl}${replay.endpoint}`, {
        method: replay.method,
        headers: { ...replay.headers, ...internalHeaders },
        body: JSON.stringify(replay.body),
        signal: AbortSignal.timeout(REPLAY_TIMEOUT_MS),
      });
    } catch (error) {
      return NextResponse.json({
        error: `The router did not answer: ${error?.message || "request failed"}`,
        status: null,
        preview: "",
        endpoint: replay.endpoint,
        method: replay.method,
        model: replay.model,
      }, { status: 502 });
    }

    const text = await upstream.text().catch(() => "");

    return NextResponse.json({
      ok: upstream.ok,
      status: upstream.status,
      statusText: upstream.statusText,
      preview: text.slice(0, PREVIEW_LIMIT),
      truncated: text.length > PREVIEW_LIMIT,
      durationMs: Date.now() - startedAt,
      endpoint: replay.endpoint,
      method: replay.method,
      model: replay.model,
      description: replay.description,
    }, { status: upstream.status });
  } catch (error) {
    console.error("[API] Failed to replay the request:", error);
    return NextResponse.json({ error: "Failed to replay the request" }, { status: 500 });
  }
}
