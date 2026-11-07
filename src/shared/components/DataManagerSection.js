"use client";

// Data & migrations — the DB manager, embedded in Settings.
//
// One SQLite, versioned chain, the owner's choice of data retention: table
// stats by category, the three presets (minimal / standard / full), prune and
// vacuum. Moved here when Fusion Setup left its standalone page — the DB
// manager card lived there and must not disappear with it.

import { useState, useEffect, useCallback } from "react";
import { Card, Button } from "@/shared/components";

export default function DataManagerSection() {
  const [stats, setStats] = useState(null);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/db-manager", { cache: "no-store" });
      setStats(await res.json());
    } catch {
      setNote("DB manager unavailable");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]); // eslint-disable-line react-hooks/set-state-in-effect -- initial async load

  const post = useCallback(async (payload) => {
    setBusy(payload.action || payload.preset);
    setNote("");
    try {
      const res = await fetch("/api/db-manager", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "action failed");
      const deleted = data.deleted
        ? ` (trimmed ${data.deleted.usageHistory || 0} usage + ${data.deleted.requestDetails || 0} detail rows)`
        : "";
      setNote(`Done${deleted}`);
      await refresh();
    } catch (err) {
      setNote(err?.message || String(err));
    } finally {
      setBusy("");
    }
  }, [refresh]);

  const byCategory = { core: [], features: [], analytics: [] };
  for (const t of stats?.tables || []) byCategory[t.category]?.push(t);

  return (
    <Card>
      <div className="px-4 sm:px-6 pt-4 sm:pt-5">
        <h2 className="text-lg sm:text-xl font-semibold">Data &amp; migrations</h2>
        <p className="mt-1 text-sm text-text-muted">
          One SQLite, versioned chain, your choice of data retention. No migration museum.
        </p>
      </div>
      {note ? <div className="mx-4 sm:mx-6 mt-3 text-xs text-primary">{note}</div> : null}
      <div className="flex flex-wrap gap-2 px-4 sm:px-6 py-4">
        {(stats?.presets || []).map((p) => (
          <Button
            key={p.id}
            size="sm"
            variant="secondary"
            loading={busy === p.id}
            onClick={() => post({ action: "preset", preset: p.id })}
          >
            {p.label}
          </Button>
        ))}
        <Button
          size="sm"
          variant="secondary"
          icon="cleaning_services"
          loading={busy === "vacuum"}
          onClick={() => post({ action: "vacuum" })}
        >
          Vacuum
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-3 px-4 sm:px-6 pb-4 sm:pb-5 text-xs">
        {["core", "features", "analytics"].map((cat) => (
          <div key={cat} className="rounded-lg border border-border p-2">
            <div className="font-medium capitalize mb-1">{cat}</div>
            {(byCategory[cat] || []).map((t) => (
              <div key={t.name} className="flex justify-between text-text-muted">
                <span className="font-mono truncate">{t.name}</span>
                <span>{t.rows.toLocaleString()}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Card>
  );
}
