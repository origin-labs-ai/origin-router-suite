import { handleQuotaCheck } from "@/sse/handlers/ops.js";

export async function OPTIONS() {
  return new Response(null, {
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" },
  });
}
/** GET /v1/quotas/check - usage/quota snapshot */
export const GET = handleQuotaCheck;
