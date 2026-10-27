import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";

// Dashboard-authenticated chat entry point used by the Playground.
//
// The dashboard session is the credential here: dashboardGuard denies anonymous
// /api/* calls and only lets a valid JWT (or requireLogin=false on localhost)
// through, so demanding an API key on top would just break the built-in UI.
// `options.internal` tells handleChat to skip that second gate.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

export async function POST(request) {
  await ensureInitialized();
  return handleChat(request, null, { internal: true });
}
