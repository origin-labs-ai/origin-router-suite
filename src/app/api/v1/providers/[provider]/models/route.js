import { handleProviderModels, preflight } from "@/sse/handlers/providerScoped.js";

export const OPTIONS = preflight;
/** GET /v1/providers/{provider}/models - provider-scoped model catalog */
export async function GET(request, { params }) {
  const { provider } = await params;
  return handleProviderModels(request, provider);
}
