import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/localDb";
import { getUsageHistory } from "@/lib/usageDb";
import { getRequestDetails } from "@/lib/requestDetailsDb";
import { buildProviderHealth, summarizeHealth, isErrorStatus } from "@/lib/providerHealth";
import { AI_PROVIDERS } from "@/shared/constants/providers";

export const dynamic = "force-dynamic";

const WINDOW_MS = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

// The request log keeps the error text of a failed call.
function readDetailError(detail) {
  const response = detail?.response;
  if (!response || typeof response !== "object") return null;
  if (typeof response.error === "string" && response.error.trim()) return response.error.trim();
  if (typeof response.status === "number") return `HTTP ${response.status}`;
  return null;
}

// The request log is the only place that keeps how long a call took.
function readDetailLatency(detail) {
  const total = detail?.latency?.total;
  return typeof total === "number" && total > 0 ? total : null;
}

/**
 * GET /api/provider-health
 * Query parameters: window (24h | 7d)
 *
 * Returns the health of every provider that has a connection or traffic:
 * { providers: [...], summary: {...}, window: "24h" }
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const windowKey = searchParams.get("window") === "7d" ? "7d" : "24h";
    const since = new Date(Date.now() - WINDOW_MS[windowKey]).toISOString();

    const [connections, history, details] = await Promise.all([
      getProviderConnections(),
      getUsageHistory({ startDate: since }),
      getRequestDetails({ startDate: since, pageSize: 200 }).catch(() => null),
    ]);

    const detailRows = details?.details || [];

    // Two sources, one event list:
    //   - the request ledger (usage history) records the calls that produced
    //     tokens, so it is the request count;
    //   - the request log records every call, so it is where failures live.
    // A failed call never reaches the ledger, so the log's failures are added
    // to the event list instead of being counted twice.
    const events = [];
    const latencies = {};

    for (const row of history || []) {
      events.push({
        provider: row.provider || "unknown",
        status: row.status || "ok",
        timestamp: row.timestamp,
      });
    }

    for (const detail of detailRows) {
      const provider = detail?.provider || "unknown";
      const failed = isErrorStatus(detail?.status);
      if (failed) {
        events.push({
          provider,
          status: detail.status,
          timestamp: detail.timestamp,
          error: readDetailError(detail),
        });
        continue;
      }
      // Latency of a successful call only: a failed call's elapsed time is
      // time-to-failure, not response latency.
      const latency = readDetailLatency(detail);
      if (latency === null) continue;
      if (!latencies[provider]) latencies[provider] = [];
      latencies[provider].push(latency);
    }

    const names = {};
    for (const [id, entry] of Object.entries(AI_PROVIDERS || {})) {
      if (entry?.name) names[id] = entry.name;
    }

    const providers = buildProviderHealth(connections || [], events, { latencies, names });
    const summary = summarizeHealth(providers);

    return NextResponse.json({ providers, summary, window: windowKey });
  } catch (error) {
    console.error("[API] Failed to build the provider health report:", error);
    return NextResponse.json(
      { error: "Failed to fetch provider health" },
      { status: 500 }
    );
  }
}
