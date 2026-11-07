"use client";

import { useState, useEffect, useCallback } from "react";

// Dashboard hook for the Memory Fabric (src/lib/memoryFabric/). Exposes the
// aggregate view (scopes + stats) and the three mutations the panel needs.
// Read-only consumers can destructure just what they use; every call is
// fail-open — errors land in `error` and never throw into the component.
export function useMemoryFabric() {
  const [scopes, setScopes] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/memory-fabric");
      if (!res.ok) throw new Error(`memory-fabric ${res.status}`);
      const data = await res.json();
      setScopes(Array.isArray(data.scopes) ? data.scopes : []);
      setStats(data.stats || null);
    } catch (e) {
      setError(e?.message || "Failed to load memory fabric");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Store a memory; returns the stored row (with `duplicated` flag) or null.
  const remember = useCallback(async (scope, content, source) => {
    try {
      const res = await fetch("/api/memory-fabric", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, content, source: source || undefined }),
      });
      if (!res.ok) throw new Error(`memory-fabric ${res.status}`);
      await refresh();
      return await res.json();
    } catch (e) {
      setError(e?.message || "Failed to store memory");
      return null;
    }
  }, [refresh]);

  // Delete one memory by id; returns true when the server confirmed.
  const forget = useCallback(async (id) => {
    try {
      const res = await fetch(`/api/memory-fabric?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`memory-fabric ${res.status}`);
      await refresh();
      return true;
    } catch (e) {
      setError(e?.message || "Failed to delete memory");
      return false;
    }
  }, [refresh]);

  // Page through one scope's memories (optional substring query).
  const recall = useCallback(async (scope, { query, limit } = {}) => {
    try {
      const params = new URLSearchParams({ scope });
      if (query) params.set("query", query);
      if (limit) params.set("limit", String(limit));
      const res = await fetch(`/api/memory-fabric?${params.toString()}`);
      if (!res.ok) throw new Error(`memory-fabric ${res.status}`);
      const data = await res.json();
      return Array.isArray(data.memories) ? data.memories : [];
    } catch (e) {
      setError(e?.message || "Failed to recall memories");
      return [];
    }
  }, []);

  return { scopes, stats, loading, error, refresh, remember, forget, recall };
}
