import { NextResponse } from "next/server";
import { pandaHealth } from "@/sse/services/pandaRouter.js";

// GET /api/panda/status — is the orchestrator reachable, and what does it know?
export const dynamic = "force-dynamic";

export async function GET(request) {
  const force = new URL(request.url).searchParams.get("refresh") === "1";
  const health = await pandaHealth(force);
  return NextResponse.json(
    {
      ok: health.ok,
      detail: health.detail,
      checkedAt: new Date(health.checkedAt).toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
