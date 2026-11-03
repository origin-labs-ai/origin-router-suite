import { AI_MODELS } from "@/shared/constants/config";
import { getCustomModels } from "@/models";
import { getProviderAlias } from "@/shared/constants/providers";

// Server-side seat → catalog-name index.
//
// Some providers ship an opaque id with a real name next to it: Qoder's `qd/qfmodel`
// is named "Qwen3.8-Flash", `qd/dfmodel` is "DeepSeek-V4-Flash". Routing decisions,
// tiers and labels all have to know that, and only the catalog rows do — the seat
// string alone would classify `qfmodel` as an unknown, non-flash model and send heavy
// work to it.
//
// Built from the same two sources the dashboard's /api/models uses, refreshed on a
// short TTL because custom rows change while the app is running.
const TTL_MS = 30000;
let cache = { at: 0, map: new Map() };

function indexRows(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const name = typeof row?.name === "string" ? row.name.trim() : "";
    if (!name || !row?.model) continue;
    const alias = row.provider;
    map.set(`${alias}/${row.model}`, name);
    if (row.routedModel) map.set(row.routedModel, name);
    // A bare id helps for seats written without a provider, but never overrides a
    // full `provider/model` hit — the same id under two providers can differ.
    if (!map.has(row.model)) map.set(row.model, name);
  }
  return map;
}

async function build() {
  const rows = [];
  for (const m of AI_MODELS || []) {
    rows.push({
      provider: getProviderAlias(m.provider) || m.provider,
      model: m.model,
      name: m.name || m.model,
    });
  }
  for (const m of await getCustomModels().catch(() => [])) {
    if (!m?.id) continue;
    rows.push({
      provider: m.providerAlias,
      model: m.id,
      name: m.name || m.id,
      routedModel: `${m.providerAlias}/${m.id}`,
    });
  }
  return indexRows(rows);
}

/** The catalog's own name for a seat, or "" when it stores none. */
export async function modelNameFor(seat) {
  if (!seat) return "";
  if (Date.now() - cache.at > TTL_MS || cache.map.size === 0) {
    try {
      cache = { at: Date.now(), map: await build() };
    } catch {
      // A failing catalog read must not break routing: no name, rules fall back
      // to the id itself.
      return "";
    }
  }
  const bare = seat.includes("/") ? seat.slice(seat.indexOf("/") + 1) : seat;
  return cache.map.get(seat) || cache.map.get(bare) || "";
}

/** Force the next lookup to rebuild (custom model added or edited). */
export function invalidateModelNameIndex() {
  cache = { at: 0, map: new Map() };
}
