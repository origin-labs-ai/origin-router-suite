import { NextResponse } from "next/server";
import { fusionStatus, applySetup, installPack, removePack, loadPackModule } from "@/lib/fusion/loader.js";
import { SETUP_TIERS, CATEGORIES } from "@/lib/fusion/catalog.js";

// GET /api/fusion — setup tier, resolved features, installed pack registry.
// Auth is enforced by the dashboard guard (the same global middleware that
// covers /api/combos and every other dashboard API).
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const status = await fusionStatus();
    return NextResponse.json({ ...status, tiers: SETUP_TIERS, categories: CATEGORIES }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const action = String(body?.action || "");
    if (action === "apply-setup") {
      const result = await applySetup({ tier: body.tier, handPicked: body.features, source: body.source });
      return NextResponse.json(result);
    }
    if (action === "install-pack") {
      const result = await installPack({ features: body.features, source: body.source });
      return NextResponse.json(result);
    }
    if (action === "remove-pack") {
      const result = await removePack(String(body.packId || ""));
      return NextResponse.json(result);
    }
    if (action === "test-module") {
      const mod = await loadPackModule(String(body.packId || "revolt-fusion"));
      return NextResponse.json({ ok: Boolean(mod), exports: mod ? Object.keys(mod) : [] });
    }
    return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}
