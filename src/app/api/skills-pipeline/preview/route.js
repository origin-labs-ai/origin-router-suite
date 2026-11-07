import { NextResponse } from "next/server";
import { githubPreview, localPreview, clampPreviewLimit } from "@/lib/skillsPipeline/catalog.js";

// Preview endpoint for the Skills page cards + Read modal.
//
// GET /api/skills-pipeline/preview?source=github&path=skills/<dir>/SKILL.md[&limit=N]
// GET /api/skills-pipeline/preview?source=local&name=<dirName>[&limit=N]
//   → { source, path|name, preview, truncated }
//
// `preview` is the SKILL.md's own opening text, whitespace-collapsed and cut
// to `limit` chars (default = the card length, hard cap 4000) with "…"
// appended when content was cut — never authored, always quoted (see
// skillsPipeline/preview.js). The Read modal asks with a bigger limit; both
// limits are served from the same 10-minute in-memory cache githubSource
// keeps per file, so scrolling a card grid costs one raw.githubusercontent.com
// fetch per actually-seen skill.
//
// AUTH: none here, on purpose — same rule as the parent /api/skills-pipeline
// route. The dashboardGuard has no public entry for this path, so the central
// guard covers it (it matches /api/ prefixes, nested routes included).

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const source = String(searchParams.get("source") || "").trim().toLowerCase();
    const limit = clampPreviewLimit(searchParams.get("limit"));

    if (source !== "github" && source !== "local") {
      return NextResponse.json({ error: `unknown source: ${source} (use github|local)` }, { status: 400 });
    }

    if (source === "github") {
      const path = String(searchParams.get("path") || "");
      if (!path.trim()) {
        return NextResponse.json({ error: "github preview requires ?path=<repo path to SKILL.md>" }, { status: 400 });
      }
      const { preview, truncated } = await githubPreview({}, path, limit);
      return NextResponse.json({ source, path, preview, truncated }, { headers: { "Cache-Control": "no-store" } });
    }

    // local — keyed by the skill's directory name (never a raw path from the
    // client: localPreview resolves it inside the catalog dir and refuses
    // anything that is not a single safe segment).
    const name = String(searchParams.get("name") || "").trim();
    if (!name) {
      return NextResponse.json({ error: "local preview requires ?name=<skill dir name>" }, { status: 400 });
    }
    const { preview, truncated, path } = await localPreview({}, name, limit);
    return NextResponse.json({ source, name, path, preview, truncated }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const message = err?.message || String(err);
    // Bad params (invalid name/path) and missing files are client-grade
    // errors; upstream github failures (rate limit, timeouts) are 502 so the
    // page can tell "this skill has no preview" from "the source is down".
    const status =
      /invalid|escapes|no SKILL\.md|could not read/i.test(message) ? 400
        : /GitHub/i.test(message) ? 502
          : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
