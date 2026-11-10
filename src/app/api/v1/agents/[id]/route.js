import { handleAgent, preflight } from "@/sse/handlers/ops.js";

export const OPTIONS = preflight;
/** GET/PATCH/DELETE /v1/agents/{id} */
export async function GET(request, { params }) {
  const { id } = await params;
  return handleAgent(request, id);
}
export async function PATCH(request, { params }) {
  const { id } = await params;
  return handleAgent(request, id);
}
export async function DELETE(request, { params }) {
  const { id } = await params;
  return handleAgent(request, id);
}
