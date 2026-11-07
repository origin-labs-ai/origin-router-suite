import { NextResponse } from "next/server";
import { pipelineStatus, runScan, runInstall, installOne } from "@/lib/skillsPipeline/index.js";
import { githubCatalog, localCatalog, pageSlice } from "@/lib/skillsPipeline/catalog.js";
import { CARD_PREVIEW_CHARS } from "@/lib/skillsPipeline/preview.js";
import { resolveSkillsSource } from "@/lib/skillsPipeline/githubSource.js";

// Skills pipeline API — import the owner's code-fusion payloads skills catalog
// into DATA_DIR/skills with CONFLICT.md duplicate-merging, and serve the
// skills CATALOG the dashboard Skills page browses.
//
// AUTH: none here, on purpose. /api/skills-pipeline is not in dashboardGuard's
// public path lists, so the central guard covers it exactly like /api/combos
// and every other dashboard API — one auth surface, no per-route exceptions.
//
// ─── GET contract ────────────────────────────────────────────────────────────
// Two modes, keyed on the `source` query param:
//
// 1. LEGACY (no ?source): the pipeline status object — resolved source dir,
//    what a scan/merge would do right now, the last persisted run. Unchanged
//    shape; the dashboard import flow and existing tests read this. A broken
//    source dir degrades to scanError rather than a 500 — the page stays
//    fixable.
//
// 2. CATALOG (?source=github|local): the skill list the redesigned page's
//    card grid renders.
//      ?source=github  → catalog from the settings-configured GitHub repo
//                        (DEFAULT: origin-labs-ai/revolt-fusion@main, skills/),
//                        one api.github.com tree call, 10-min in-memory cache.
//                        On ANY github failure the response falls back to the
//                        local catalog with fallback:true + a notes[] entry —
//                        a dead repo must never blank the page.
//      ?source=local   → catalog from the local payloads dir (the pipeline's
//                        own source). Previews are included inline for local
//                        (cheap filesystem reads).
//      ?page=N&pageSize=M → optional server-side slice (1-based page,
//                        pageSize default 50, cap 200). The page itself loads
//                        the FULL list in one call and renders incrementally
//                        client-side (IntersectionObserver batches) — one
//                        roundtrip, instant client-side search — so it does
//                        NOT send page/pageSize. The params exist for callers
//                        that want true server paging; see catalog.pageSlice.
//    github list entries carry preview:"" — card previews come from
//    /api/skills-pipeline/preview as cards mount (fetching 950 files in this
//    response would hammer raw.githubusercontent.com and stall the load).

export const dynamic = "force-dynamic";

// GET → live pipeline status (legacy) or the browsable catalog (with ?source).
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const source = String(searchParams.get("source") || "").trim().toLowerCase();

    // ── Catalog mode ───────────────────────────────────────────────────────
    if (source) {
      if (source !== "github" && source !== "local") {
        return NextResponse.json({ error: `unknown source: ${source} (use github|local)` }, { status: 400 });
      }
      const notes = [];
      let effective = source; // the source the list actually came from
      let list;
      let sourceConfig = null;

      if (source === "github") {
        try {
          list = await githubCatalog();
          sourceConfig = await resolveSkillsSource();
        } catch (err) {
          // Fail-open: fall back to the local catalog and SAY so. A rate
          // limit, a renamed repo or an offline network shows the local
          // catalog with a note instead of an error wall.
          notes.push(`GitHub catalog unavailable (${err?.message || String(err)}) — showing the local catalog.`);
          effective = "local";
          list = await localCatalog();
          list.fallback = true;
        }
      } else {
        list = await localCatalog();
      }

      const allNotes = [...notes, ...(list?.notes || [])];
      const paged = pageSlice(list?.skills || [], searchParams.get("page"), searchParams.get("pageSize"));
      return NextResponse.json(
        {
          source: effective,
          requestedSource: effective === source ? undefined : source,
          fallback: !!list.fallback,
          notes: allNotes,
          sourceConfig,
          ...paged, // { skills, total, page, pageSize, hasMore }
          previewChars: CARD_PREVIEW_CHARS, // the card preview length the client may assume
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    // ── Legacy pipeline status (no ?source) — unchanged contract ──────────
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
