import { handleFileGet, handleFileDelete, preflight } from "@/sse/handlers/files.js";

export const OPTIONS = preflight;
/** GET /v1/files/{id} - metadata; DELETE /v1/files/{id} - remove */
export async function GET(request, { params }) {
  const { id } = await params;
  return handleFileGet(request, id);
}
export async function DELETE(request, { params }) {
  const { id } = await params;
  return handleFileDelete(request, id);
}
