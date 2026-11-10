import { handleVoices } from "@/sse/handlers/voices.js";

export async function OPTIONS() {
  return new Response(null, {
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" },
  });
}

/** GET /v1/audio/voices - OpenAI-style voice list for a TTS provider */
export async function GET(request) {
  return handleVoices(request);
}
