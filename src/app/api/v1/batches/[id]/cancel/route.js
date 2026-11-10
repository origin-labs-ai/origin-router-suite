import { handleBatchCancel, preflight } from "@/sse/handlers/batches.js";

export const OPTIONS = preflight;
/** POST /v1/batches/{id}/cancel - cancel an active batch */
export async function POST(request, { params }) {
  const { id } = await params;
  return handleBatchCancel(request, id);
}
