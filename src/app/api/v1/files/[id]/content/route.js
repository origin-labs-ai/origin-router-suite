import { handleFileContent } from "@/sse/handlers/files.js";

export async function OPTIONS() {
  return new Response(null, {
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" },
  });
}
/** GET /v1/files/{id}/content - raw file bytes */
export async function GET(request, { params }) {
  const { id } = await params;
  return handleFileContent(request, id);
}
