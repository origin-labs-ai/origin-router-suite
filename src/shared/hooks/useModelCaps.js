"use client";

import { useState, useEffect, useCallback } from "react";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { ALIAS_TO_ID } from "@/shared/constants/providers";
import { withMaxContextWindow } from "@/lib/contextLimits";

// Module cache: one /api/models fetch shared by every useModelCaps instance.
let cache = null; // { byFull, byId, names } | null
let inflight = null;

function buildMaps(models) {
  const byFull = {};
  const byId = {};
  // A provider catalog often stores the model's real name next to an opaque id:
  // `qd/qfmodel` is named "Qwen3.8-Flash". Without that name the label and the
  // category can only be guessed from the id, which is how a perfectly good model
  // becomes unfindable in a picker. Same fetch, kept beside the caps.
  const names = { byFull: {}, byId: {} };
  for (const m of models || []) {
    const label = typeof m?.name === "string" ? m.name.trim() : "";
    if (label) {
      if (m.fullModel) names.byFull[m.fullModel] = label;
      if (m.routedModel) names.byFull[m.routedModel] = label;
      if (m.model) names.byId[m.model] = label;
    }
    if (!m.caps) continue;
    const caps = withMaxContextWindow(m.caps);
    if (m.fullModel) byFull[m.fullModel] = caps;
    if (m.routedModel) byFull[m.routedModel] = caps;
    if (m.model) byId[m.model] = caps;
  }
  return { byFull, byId, names };
}

/** The catalog's own name for a seat, when the provider gave one. */
export function resolveModelName(names, key) {
  if (!key || !names) return "";
  if (names.byFull[key]) return names.byFull[key];
  const bare = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
  return names.byId[bare] || "";
}

function loadModelCaps() {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = fetch("/api/models")
    .then(async (res) => {
      if (!res.ok) throw new Error(`models ${res.status}`);
      const data = await res.json();
      cache = buildMaps(data.models);
      return cache;
    })
    .catch(() => {
      // Keep null so a later mount can retry
      return { byFull: {}, byId: {}, names: { byFull: {}, byId: {} } };
    })
    .finally(() => { inflight = null; });
  return inflight;
}

// Resolve caps from a "provider/model" string or a bare model id.
// The seat prefix is a UI alias (ocg, cmc, …); the capability tables are keyed
// by provider id (opencode-go, commandcode, …), so map it before the lookup —
// an unmapped alias falls through to the generic patterns and under-reports
// (e.g. any *claude*haiku* id reads as 200k regardless of the provider entry).
export function resolveCaps(byFull, byId, key) {
  if (!key) return null;
  if (byFull[key]) return byFull[key];
  const bare = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
  if (byId[bare]) return byId[bare];
  const alias = key.includes("/") ? key.slice(0, key.indexOf("/")) : null;
  const provider = alias ? (ALIAS_TO_ID[alias] || alias) : null;
  const c = getCapabilitiesForModel(provider, bare);
  const normalized = withMaxContextWindow(c);
  return {
    ...normalized,
    // A model the API does not know keeps its feature flags from the pattern
    // table, but its context window stays null: the capability table's 200K is a
    // runtime floor, and showing it as a limit is what made undeclared seats look
    // capped.
    contextWindow: normalized.contextWindow,
    contextDeclared: normalized.contextDeclared === true,
  };
}

export function useModelCaps() {
  const [byFull, setByFull] = useState(() => cache?.byFull || {});
  const [byId, setById] = useState(() => cache?.byId || {});
  const [names, setNames] = useState(() => cache?.names || { byFull: {}, byId: {} });

  useEffect(() => {
    let alive = true;
    const sync = (maps) => {
      if (!alive) return;
      setByFull(maps.byFull); setById(maps.byId);
      setNames(maps.names || { byFull: {}, byId: {} });
    };
    if (cache) {
      sync(cache);
    } else {
      loadModelCaps().then(sync);
    }
    // Custom models change at runtime — drop the shared cache and refetch
    const invalidate = () => {
      cache = null;
      loadModelCaps().then(sync);
    };
    window.addEventListener("customModelChanged", invalidate);
    return () => {
      alive = false;
      window.removeEventListener("customModelChanged", invalidate);
    };
  }, []);

  const getCaps = useCallback(
    (key) => resolveCaps(byFull, byId, key),
    [byFull, byId],
  );
  const getModelName = useCallback(
    (key) => resolveModelName(names, key),
    [names],
  );

  return { getCaps, getModelName };
}
