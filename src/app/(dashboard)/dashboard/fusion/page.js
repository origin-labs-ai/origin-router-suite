"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, Badge } from "@/shared/components";

// Revolt Fusion — the "Choose Your Setup" control center.
//
// Three tiers, one page:
//   Daily Code  — the featherlight base, nothing extra, nothing fetched.
//   Pro         — hand-pick the heavy categories; each hydrates on demand.
//   MHHRSM      — the full Monster Homelab Hub Rebel Strike Mode pack.
//
// The page is the single surface for: applying a tier, hand-picking
// categories, installing/removing the pack, and watching pack health
// (verified = every file still matches its manifest hash).

const TIER_ICONS = { daily: "bolt", pro: "tune", monster: "local_fire_department" };

export default function FusionPage() {
  const [status, setStatus] = useState(null);
  const [handPicked, setHandPicked] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/fusion", { cache: "no-store" });
      const data = await res.json();
      setStatus(data);
      setHandPicked((prev) => prev || (data.features?.length ? data.features : null));
    } catch {
      setError("Fusion status unavailable");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]); // eslint-disable-line react-hooks/set-state-in-effect -- initial load is an async fetch, not a sync setState

  const post = useCallback(async (payload) => {
    setBusy(payload.action);
    setError("");
    try {
      const res = await fetch("/api/fusion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "action failed");
      await refresh();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy("");
    }
  }, [refresh]);

  if (!status) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <Card padding="md">
          <div className="text-sm text-text-muted">{error || "Loading fusion status…"}</div>
        </Card>
      </div>
    );
  }

  const tierId = status.tier || "daily";
  const installedPack = Object.values(status.packs || {})[0] || null;

  return (
    <div className="flex flex-col gap-6 p-6 max-w-5xl mx-auto w-full">
      <div>
        <h1 className="text-xl font-semibold">Choose Your Setup</h1>
        <p className="text-sm text-text-muted mt-1">
          The base router stays featherlight. Heavy categories hydrate on demand from the extension pack — installed, hash-verified, removable.
        </p>
      </div>

      {error ? (
        <Card padding="sm"><div className="text-sm text-red-500">{error}</div></Card>
      ) : null}

      {/* Tier cards */}
      <div className="grid gap-3 md:grid-cols-3">
        {(status.tiers || []).map((tier) => (
          <Card
            key={tier.id}
            padding="md"
            className={`cursor-pointer transition-colors ${tierId === tier.id ? "border-2 border-primary" : ""}`}
          >
            <div
              role="button"
              tabIndex={0}
              onClick={() => post({ action: "apply-setup", tier: tier.id, features: tier.id === "pro" ? handPicked : undefined })}
              onKeyDown={(e) => e.key === "Enter" && post({ action: "apply-setup", tier: tier.id, features: tier.id === "pro" ? handPicked : undefined })}
            >
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary">{TIER_ICONS[tier.id] || "bolt"}</span>
                <span className="font-semibold">{tier.label}</span>
                {tierId === tier.id ? <Badge variant="success" size="sm">Active</Badge> : null}
              </div>
              <div className="text-xs font-medium text-text-muted mt-0.5">{tier.tagline}</div>
              <p className="text-xs text-text-muted mt-2 leading-relaxed">{tier.description}</p>
            </div>
          </Card>
        ))}
      </div>

      {/* Category hand-pick (Pro tier) */}
      {tierId === "pro" ? (
        <Card padding="md">
          <div className="text-sm font-semibold mb-2">Pick your categories</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {(status.categories || []).map((cat) => {
              const checked = (handPicked || []).includes(cat.id);
              return (
                <label key={cat.id} className="flex items-start gap-2 text-xs cursor-pointer rounded-lg border border-border p-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={checked}
                    onChange={(e) =>
                      setHandPicked((prev) => {
                        const base = Array.isArray(prev) ? prev : (status.categories || []).filter((c) => c.defaultOn).map((c) => c.id);
                        return e.target.checked ? [...new Set([...base, cat.id])] : base.filter((x) => x !== cat.id);
                      })
                    }
                  />
                  <span>
                    <span className="font-medium">{cat.label}</span>
                    <span className="block text-text-muted mt-0.5">{cat.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
          <div className="mt-3 flex gap-2">
            <Button size="sm" icon="download" loading={busy === "install-pack"} onClick={() => post({ action: "install-pack", features: handPicked })}>
              Install pack
            </Button>
            <Button size="sm" variant="secondary" icon="refresh" loading={busy === "apply-setup"} onClick={() => post({ action: "apply-setup", tier: "pro", features: handPicked })}>
              Save picks
            </Button>
          </div>
        </Card>
      ) : null}

      {/* Pack registry */}
      <Card padding="md">
        <div className="text-sm font-semibold mb-2">Extension pack</div>
        {!installedPack ? (
          <div className="text-xs text-text-muted">
            No pack installed — the base router is featherlight. Pick a tier above; the pack installs only when you ask.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono">{installedPack.packId}</span>
              <Badge size="sm" variant={installedPack.verified ? "success" : "danger"}>
                {installedPack.verified ? "hash-verified" : "damaged"}
              </Badge>
              <span className="text-text-muted">v{installedPack.version}</span>
              <span className="text-text-muted">· {new Date(installedPack.installedAt).toLocaleString()}</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {(installedPack.features || []).map((f) => (
                <Badge key={f} size="sm" variant="default">{f}</Badge>
              ))}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" icon="science" loading={busy === "test-module"} onClick={() => post({ action: "test-module", packId: installedPack.packId })}>
                Test load
              </Button>
              <Button size="sm" variant="danger" icon="delete" loading={busy === "remove-pack"} onClick={() => post({ action: "remove-pack", packId: installedPack.packId })}>
                Remove
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Data & migrations — the DB manager section */}
      <DataMigrationsCard />
    </div>
  );
}

// The DB manager card: table stats by category, the three data presets
// (minimal / standard / full), prune + vacuum. The sane answer to a
// 223-migration schema museum: the user chooses how much data history to keep.
function DataMigrationsCard() {
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "action failed");
      const deleted = data.deleted ? ` (trimmed ${data.deleted.usageHistory || 0} usage + ${data.deleted.requestDetails || 0} detail rows)` : "";
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
    <Card padding="md">
      <div className="text-sm font-semibold mb-1">Data &amp; migrations</div>
      <div className="text-xs text-text-muted mb-3">
        One SQLite, versioned chain, your choice of data retention. No migration museum.
      </div>
      {note ? <div className="text-xs text-primary mb-2">{note}</div> : null}
      <div className="flex flex-wrap gap-2 mb-3">
        {(stats?.presets || []).map((p) => (
          <Button key={p.id} size="sm" variant="secondary" loading={busy === p.id} onClick={() => post({ action: "preset", preset: p.id })}>
            {p.label}
          </Button>
        ))}
        <Button size="sm" variant="secondary" icon="cleaning_services" loading={busy === "vacuum"} onClick={() => post({ action: "vacuum" })}>
          Vacuum
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-3 text-xs">
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
