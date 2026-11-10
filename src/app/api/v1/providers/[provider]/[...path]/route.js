import { handleProviderEndpoint, preflight } from "@/sse/handlers/providerScoped.js";

export const maxDuration = 300;
export const OPTIONS = preflight;
/** POST /v1/providers/{provider}/{endpoint} - provider-scoped gateway endpoint */
export async function POST(request, { params }) {
  const { provider, path } = await params;
  return handleProviderEndpoint(request, provider, Array.isArray(path) ? path.join("/") : path);
}
