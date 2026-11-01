// Alternate provider routes for a model id.
//
// The client asks for one model; several providers usually serve the same id
// (Antigravity, an Anthropic account, an aggregator, a custom OpenAI-compatible
// node). When every account of the requested provider answers with an error,
// that must not become the client's answer — the router keeps looking. This
// module turns the catalog plus the live connections into that candidate list.

import { AI_MODELS } from "@/shared/constants/config";
import { ALIAS_TO_ID, getProviderAlias } from "@/shared/constants/providers";
import { getProviderConnections, getCustomModels } from "@/lib/localDb";
import { getDisabledModels } from "@/lib/disabledModelsDb";

// Suffixes that describe a route, not a different model. A `:free` seat that
// just hit its free-tier prompt cap should hand over to the paid seat of the
// same model rather than end the request.
const VARIANT_SUFFIX = /(?::|-)(?:free|beta|latest|preview|stable|experimental|thinking|extended)$/i;

function baseModel(model) {
  return String(model || "").replace(VARIANT_SUFFIX, "");
}

function matches(candidate, wanted) {
  const a = String(candidate || "");
  const b = String(wanted || "");
  if (a === b) return true;
  if (a.toLowerCase() === b.toLowerCase()) return true;
  return baseModel(a) === baseModel(b);
}

// Exact matches first, same-family variants last, so a paid seat of the very
// model that was asked for is never outranked by an unrelated variant.
function rank(route) {
  return route.exact ? 0 : 1;
}

/**
 * @param {object} opts
 * @param {string} opts.model - bare model id (no `provider/` prefix)
 * @param {string} opts.providerId - provider already tried (excluded)
 * @param {Set<string>} [opts.excludeProviders] - providers not to try (already walked)
 * @returns {Promise<Array<{route:string, provider:string, providerId:string, model:string, exact:boolean}>>}
 */
export async function findAlternateRoutes({ model, providerId, excludeProviders = new Set() } = {}) {
  if (!model) return [];
  const wantedBase = baseModel(model);

  const [connections, custom, disabled] = await Promise.all([
    getProviderConnections({ isActive: true }),
    getCustomModels(),
    getDisabledModels().catch(() => ({})),
  ]);

  // Only providers with a live connection can actually serve a request.
  const liveProviderIds = new Set(
    connections.map((c) => c.provider).filter(Boolean),
  );

  const routes = [];
  const seen = new Set();
  const add = (providerIdCandidate, modelId, exact) => {
    if (!providerIdCandidate || providerIdCandidate === providerId) return;
    if (excludeProviders.has(providerIdCandidate)) return;
    if (!liveProviderIds.has(providerIdCandidate)) return;
    const alias = getProviderAlias(providerIdCandidate) || providerIdCandidate;
    const key = `${alias}/${modelId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const list = disabled[alias] || disabled[providerIdCandidate] || [];
    if (Array.isArray(list) && list.includes(modelId)) return;
    routes.push({
      route: key,
      provider: alias,
      providerId: providerIdCandidate,
      model: modelId,
      exact,
    });
  };

  // Built-in catalog: same model id on another provider.
  for (const entry of AI_MODELS) {
    if (!matches(entry.model, model) && !matches(entry.model, wantedBase)) continue;
    add(entry.provider, entry.model, entry.model === model);
  }

  // Owner-added models on custom compatible nodes.
  for (const entry of custom || []) {
    const kind = entry?.kind || entry?.type || "llm";
    if (kind !== "llm") continue;
    if (!matches(entry.id, model) && !matches(entry.id, wantedBase)) continue;
    const providerIdCandidate = ALIAS_TO_ID[entry.providerAlias] || entry.providerAlias;
    add(providerIdCandidate, entry.id, entry.id === model);
  }

  return routes.sort((a, b) => rank(a) - rank(b));
}
