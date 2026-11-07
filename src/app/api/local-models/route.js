// /api/local-models — dashboard API for the Local Models page.
//
// Auth: nothing per-route — the central dashboard guard (src/dashboardGuard.js)
// protects /api/* exactly as it does /api/combos and every other dashboard
// route, so this handler starts from an already-authenticated context.
//
// Shape:
//   GET  → { engines: {ollama, lmstudio, llamacpp}, registered: [...], downloads: [...] }
//   POST → { action: "register" | "download" | "cancel" | "remove", ...payload }
//
// The engines probe is a live 127.0.0.1 check and can take up to its 3s
// timeout, so GET is marked force-dynamic and never cached.

import { NextResponse } from "next/server";
import { probeAllEngines } from "@/lib/localModels/engines.js";
import { searchLocal } from "@/lib/localModels/search.js";
import {
  startDownload, cancelDownload, listDownloads, startDownloadSweeper,
} from "@/lib/localModels/downloads.js";
import {
  registerLocalFile, listLocalModels, removeLocalModel,
} from "@/lib/localModels/registry.js";

export const dynamic = "force-dynamic";

// TTL sweeper for finished download jobs — started once per process.
startDownloadSweeper();

// GET /api/local-models — one round trip feeds the whole page: engine dots,
// registered models table and the downloads list. Individual failures fail
// open (empty arrays), because a broken probe must not blank the page.
export async function GET() {
  try {
    const [engines, registered, downloads] = await Promise.all([
      probeAllEngines(),
      listLocalModels().catch(() => []),
      Promise.resolve(listDownloads()),
    ]);
    return NextResponse.json({ engines, registered, downloads });
  } catch (error) {
    console.log("Error reading local models state:", error);
    return NextResponse.json(
      { engines: null, registered: [], downloads: [], error: "Failed to read local models state" },
      { status: 200 } // fail-open: the page renders its empty states
    );
  }
}

// POST /api/local-models — every mutation the page performs, dispatched by
// `action`. Validation errors (bad path, bad id) map to 400 with the message;
// unexpected errors to 500, matching the repo's route error style.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { action } = body;

    switch (action) {
      // "+ Add model file": register an existing weights file in place.
      case "register": {
        try {
          const model = await registerLocalFile({ path: body.path, name: body.name });
          return NextResponse.json(model, { status: 201 });
        } catch (err) {
          return NextResponse.json({ error: err?.message || "Invalid file" }, { status: 400 });
        }
      }

      // Download/Pull button: start an ollama pull or an HF GGUF stream.
      case "download": {
        try {
          const job = startDownload({ source: body.source, id: body.id, destDir: body.destDir, file: body.file });
          return NextResponse.json(job, { status: 202 });
        } catch (err) {
          return NextResponse.json({ error: err?.message || "Invalid download request" }, { status: 400 });
        }
      }

      // Cancel button on a running download.
      case "cancel": {
        const job = cancelDownload(body.id);
        if (!job) return NextResponse.json({ error: "Unknown download id" }, { status: 404 });
        return NextResponse.json(job);
      }

      // Remove button on a registered model row (DB row only — never the file).
      case "remove": {
        const removed = await removeLocalModel(body.id);
        if (!removed) return NextResponse.json({ error: "Unknown model id" }, { status: 404 });
        return NextResponse.json({ ok: true });
      }

      // Search endpoint piggybacks on POST because it carries a query body;
      // GET stays a single atomic snapshot of page state.
      case "search": {
        const out = await searchLocal(body.query, { limit: body.limit });
        return NextResponse.json(out);
      }

      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (error) {
    console.log("Error in local-models action:", error);
    return NextResponse.json({ error: "Failed to perform action" }, { status: 500 });
  }
}
