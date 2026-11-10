import { handleBatchGet, preflight } from "@/sse/handlers/batches.js";

export const OPTIONS = preflight;
/** GET /v1/batches/{id} - batch status */
export async function GET(request, { params }) {
  const { id } = await params;
  return handleBatchGet(request, id);
}
