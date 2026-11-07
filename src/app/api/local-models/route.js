// /api/local-models — dashboard API for the Local Models page.
//
// Auth: nothing per-route — the central dashboard guard (src/dashboardGuard.js)
// protects /api/* exactly as it does /api/combos and every other dashboard
// route, so this handler starts from an already-authenticated context.
//
// Shape:
//   GET  → { engines: {ollama, lmstudio, llamacpp}, registered: [...], downloads: [...], llamaServers: [...] }
//   POST → { action: "register" | "download" | "cancel" | "remove"
//            | "serve" | "serve-stop" | "servers" | "serve-chat" | "search", ...payload }
//
// The engines probe is a live 127.0.0.1 check and can take up to its 3s
// timeout, so GET is marked force-dynamic and never cached.

import { NextResponse } from "next/server";
import {
  probeAllEngines, detectInstalledEngines,
} from "@/lib/localModels/engines.js";
import { searchLocal } from "@/lib/localModels/search.js";
import {
  startDownload, cancelDownload, listDownloads, startDownloadSweeper,
} from "@/lib/localModels/downloads.js";
import {
  registerLocalFile, listLocalModels, removeLocalModel,
} from "@/lib/localModels/registry.js";
import {
  startLlamaServer, stopLlamaServer, listLlamaServers, chatWithLlamaServer,
} from "@/lib/localModels/llamaServer.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";

export const dynamic = "force-dynamic";

// TTL sweeper for finished download jobs — started once per process.
startDownloadSweeper();

// listLlamaServers is synchronous; wrap so a registry hiccup degrades to an
// empty list instead of failing the whole page snapshot (fail-open, like the
// other sections).
function listLlamaServersSafe() {
  try {
    return listLlamaServers();
  } catch {
    return [];
  }
}

// GET /api/local-models — one round trip feeds the whole page: engine dots,
// registered models table, downloads list and the managed llama.cpp servers.
// Individual failures fail open (empty arrays), because a broken probe must
// not blank the page.
export async function GET() {
  try {
    const [engines, installed, registered, downloads, llamaServers, settings] = await Promise.all([
      probeAllEngines(),
      Promise.resolve(detectInstalledEngines().catch(() => ({ ollama: false, lmstudio: false, llamacpp: false }))),
      listLocalModels().catch(() => []),
      Promise.resolve(listDownloads()),
      Promise.resolve(listLlamaServersSafe()),
      getSettings().catch(() => ({})),
    ]);
    // An engine that answered nothing reads differently depending on whether
    // it is installed: "not running" (start it) vs "not installed" (get it).
    for (const key of ["ollama", "lmstudio", "llamacpp"]) {
      const status = engines?.[key];
      if (status && !status.ok) {
        status.error = installed[key]
          ? "Installed but not running - start the engine to see its models."
          : "Not installed on this machine.";
      }
    }
    return NextResponse.json({
      engines,
      installed,
      registered,
      downloads,
      llamaServers,
      modelsDir: settings?.localModels?.dir || "",
    });
  } catch (error) {
    console.log("Error reading local models state:", error);
    return NextResponse.json(
      { engines: null, registered: [], downloads: [], llamaServers: [], error: "Failed to read local models state" },
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
      // destDir default comes from the owner's saved location (the wizard's
      // Local Models step), falling back to <data>/models.
      case "download": {
        try {
          let destDir = body.destDir;
          if (!destDir) {
            const settings = await getSettings().catch(() => ({}));
            destDir = settings?.localModels?.dir || undefined;
          }
          const job = startDownload({ source: body.source, id: body.id, destDir, file: body.file });
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

      // Serve button on a registered .gguf row: launch a managed llama-server
      // for that file. startLlamaServer registers the server as "starting"
      // immediately and health-polls in the background, so this returns 202
      // right away and the page poll flips the row to "running" when the model
      // has loaded. Every failure is a { ok:false, error } result — surfaced
      // as 400 with the human message (missing binary, bad path, busy port).
      case "serve": {
        startLlamaServer({
          modelPath: body.modelPath,
          port: body.port,
          ctxSize: body.ctxSize,
          name: body.name,
          // host is intentionally NOT forwarded: the launcher is hard-bound to
          // 127.0.0.1 and request input must never be able to change that.
        }).then((result) => {
          if (!result.ok) console.log(`llama-server start failed: ${result.error}`);
        });
        return NextResponse.json({ ok: true, status: "starting" }, { status: 202 });
      }

      // Stop button on a serving row. Waits for the process to be gone so the
      // response doubles as confirmation.
      case "serve-stop": {
        const result = await stopLlamaServer(body.id);
        if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 });
        return NextResponse.json(result.server);
      }

      // Listing for the poll loop (GET also carries llamaServers; this POST
      // shape exists so callers can refresh just the server list).
      case "servers": {
        return NextResponse.json({ servers: listLlamaServersSafe() });
      }

      // "Chat test" quick action: proxy ONE non-streaming chat completion to
      // the managed server's OpenAI-compatible endpoint. This is the same
      // deliberate 127.0.0.1 exception as the engine probes — chatWithLlamaServer
      // re-verifies the loopback origin before any bytes leave the process.
      case "serve-chat": {
        const result = await chatWithLlamaServer({ id: body.id, message: body.message, maxTokens: body.maxTokens });
        if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
        return NextResponse.json(result);
      }

      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (error) {
    console.log("Error in local-models action:", error);
    return NextResponse.json({ error: "Failed to perform action" }, { status: 500 });
  }
}
