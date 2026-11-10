import { handleProviderInfo, preflight } from "@/sse/handlers/providerScoped.js";

export const OPTIONS = preflight;
/** GET /v1/providers/{provider} - provider metadata */
export async function GET(request, { params }) {
  const { provider } = await params;
  return handleProviderInfo(request, provider);
}
