import { NextResponse } from "next/server";
import { pipelineStatus, runScan, runInstall, installOne } from "@/lib/skillsPipeline/index.js";

// Skills pipeline API — import the owner's code-fusion payloads skills catalog
// into DATA_DIR/skills with CONFLICT.md duplicate-merging.
//
// AUTH: none here, on purpose. /api/skills-pipeline is not in dashboardGuard's
// public path lists, so the central guard covers it exactly like /api/combos
// and every other dashboard API — one auth surface, no per-route exceptions.

export const dynamic = "force-dynamic";

// GET → live pipeline status: the resolved source dir, what a scan/merge would
// do right now (no writes), and the last persisted run. A broken source dir
// degrades to scanError rather than a 500 — the page stays fixable.
export async function GET() {
  try {
    const status = await pipelineStatus();
    return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}

// POST { action: "scan" | "install" | "install-one", name?, sourceDir?, destDir? }
//   scan        → merge report only; NOTHING is written (safe preview)
//   install     → run the merge and copy toInstall into destDir
//   install-one → same machinery, exactly one skill by name
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || "");
    // Optional per-call overrides (tests / power use); normally resolved from
    // settings + DATA_DIR inside the pipeline.
    const opts = {};
    if (typeof body?.sourceDir === "string" && body.sourceDir.trim()) opts.sourceDir = body.sourceDir;
    if (typeof body?.destDir === "string" && body.destDir.trim()) opts.destDir = body.destDir;

    if (action === "scan") {
      const report = await runScan(opts);
      return NextResponse.json(report);
    }
    if (action === "install") {
      const result = await runInstall(opts);
      return NextResponse.json(result);
    }
    if (action === "install-one") {
      if (!String(body?.name || "").trim()) {
        return NextResponse.json({ error: "install-one requires a skill name" }, { status: 400 });
      }
      const result = await installOne(body.name, opts);
      return NextResponse.json(result);
    }
    return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    // Bad source dir etc. → a 400-grade client error with the path in the
    // message; anything genuinely unexpected still answers 500.
    const message = err?.message || String(err);
    const status = /not found/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
