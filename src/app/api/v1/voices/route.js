import { handleVoicesAlias } from "@/sse/handlers/mediaAliases.js";

export async function OPTIONS() {
  return new Response(null, {
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" },
  });
}

/** GET /v1/voices - alias for /v1/audio/voices */
export const GET = handleVoicesAlias;
