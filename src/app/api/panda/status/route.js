import { NextResponse } from "next/server";
import { pandaHealth } from "@/sse/services/pandaRouter.js";
import { brainStats } from "@/sse/services/routerBrain.js";
import { resolveRoutingPolicy } from "@/lib/routingPolicy";
import { getSettings } from "@/lib/localDb";
import { getModelInfo } from "@/sse/services/model.js";
import { getProviderCredentials } from "@/sse/services/auth.js";
import { DEFAULT_SYSTEMONE_ROUTER_MODEL } from "open-sse/services/systemoneRouter.js";

// GET /api/panda/status — the state of the routing brains, not just Panda.
// The Settings card uses this to say which brain is live and which one is running
// on borrowed time (a down brain is fine: the router falls back to its own order).
export const dynamic = "force-dynamic";

// Jev (System One) is an ordinary model call, so it is "ready" when the configured
// router model resolves to a provider that has a usable credential.
async function jevStatus(policy) {
  const routerModel = policy.jevRouterModel || DEFAULT_SYSTEMONE_ROUTER_MODEL;
  try {
    const info = await getModelInfo(routerModel);
    if (!info?.provider) return { model: routerModel, ready: false, detail: "router model not found" };
    const credentials = await getProviderCredentials(info.provider, new Set(), info.model);
    if (!credentials) return { model: routerModel, ready: false, detail: "no credentials for the router provider" };
    if (credentials.allRateLimited) return { model: routerModel, ready: false, detail: "router provider rate limited" };
    return { model: routerModel, ready: true, detail: "credential available" };
  } catch (error) {
    return { model: routerModel, ready: false, detail: error?.message || String(error) };
  }
}

export async function GET(request) {
  const force = new URL(request.url).searchParams.get("refresh") === "1";
  const settings = await getSettings();
  const policy = resolveRoutingPolicy(settings);
  const health = await pandaHealth(force);
  const jev = await jevStatus(policy);
  const pandaReady = Boolean(health.ok) && policy.panda.enabled !== false;

  const active = policy.routerBrain;
  const degraded =
    (active === "panda" && !pandaReady) ||
    (active === "jev" && !jev.ready) ||
    (active === "merged" && !pandaReady && !jev.ready);

  return NextResponse.json(
    {
      ok: health.ok,
      detail: health.detail,
      checkedAt: new Date(health.checkedAt).toISOString(),
      brain: active,
      weights: { jev: policy.jevWeight, panda: policy.pandaWeight, tier: policy.tierBias },
      fairness: { seatFairness: policy.seatFairness, windowMs: policy.seatFairnessWindowMs },
      panda: { ready: pandaReady, baseUrl: policy.panda.baseUrl, enabled: policy.panda.enabled !== false },
      jev: { ...jev, enabled: active !== "panda", timeoutMs: policy.jevTimeoutMs },
      // What the brains have actually decided since the gateway started. This is the
      // evidence for "was Jev consulted? was Panda? did any seat sit idle?" instead of
      // a claim about it.
      decisions: brainStats(),
      // Which brain is actually in charge, and what happens if it is not there.
      note: degraded
        ? "Selected brain is unavailable: routing falls back to the other brain, then to your own seat order plus rotation. Requests are never blocked by this."
        : "Selected brain is live.",
      degraded: Boolean(degraded),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
