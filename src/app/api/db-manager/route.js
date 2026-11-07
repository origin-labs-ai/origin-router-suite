import { NextResponse } from "next/server";
import { listMigrations, tableStats, pruneAnalytics, vacuum, applyDataPreset, DATA_PRESETS } from "@/lib/db/migrationManager.js";

// The DB manager API — migrations, table stats, and the data-retention
// presets (minimal / standard / full). Auth via the central dashboard guard.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [migrations, tables] = await Promise.all([listMigrations(), tableStats()]);
    return NextResponse.json({ ...migrations, tables, presets: DATA_PRESETS }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const action = String(body?.action || "");
    if (action === "prune") {
      return NextResponse.json(await pruneAnalytics(body.days));
    }
    if (action === "vacuum") {
      return NextResponse.json(await vacuum());
    }
    if (action === "preset") {
      return NextResponse.json(await applyDataPreset(String(body.preset || "standard")));
    }
    return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}
