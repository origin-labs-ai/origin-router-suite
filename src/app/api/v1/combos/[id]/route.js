import { handleCombo, preflight } from "@/sse/handlers/ops.js";

export const OPTIONS = preflight;
/** GET/DELETE /v1/combos/{id} */
export async function GET(request, { params }) {
  const { id } = await params;
  return handleCombo(request, id);
}
export async function DELETE(request, { params }) {
  const { id } = await params;
  return handleCombo(request, id);
}
