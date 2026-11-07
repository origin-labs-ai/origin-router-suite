"use client";

// Revolt Fusion — "Choose Your Setup", embedded in Settings.
//
// The standalone page is gone: setup lives where the owner tunes everything
// else. Four tiers, one section:
//   Daily Code  — the featherlight base, nothing extra, nothing fetched.
//   Pro         — hand-pick the heavy categories; each hydrates on demand.
//   MHHRSM      — the full Monster Homelab Hub Rebel Strike Mode pack.
//   Ultra Ultimate Max — every category, every knob, at absolute peak.
//
// Layout rule (the owner's): Ultra Ultimate Max sits EXACTLY below Pro —
// same column — so the tier grid is two columns: Daily/MHHRSM on the left,
// Pro/Ultra on the right.

import { useState, useEffect, useCallback } from "react";
import { Card, Button, Badge } from "@/shared/components";

const TIER_ICONS = {
  daily: "bolt",
  pro: "tune",
  monster: "local_fire_department",
  ultra: "workspace_premium",
};

// Tier order that puts ultra directly under pro in a two-column grid:
// row 1 = daily | pro, row 2 = monster | ultra.
function orderTiersForGrid(tiers) {
  const byId = new Map((tiers || []).map((t) => [t.id, t]));
  return ["daily", "pro", "monster", "ultra"]
    .map((id) => byId.get(id))
    .filter(Boolean)
    .concat((tiers || []).filter((t) => !["daily", "pro", "monster", "ultra"].includes(t.id)));
}

export default function FusionSetupSection() {
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

  const post = useCallback(
    async (payload) => {
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
    },
    [refresh],
  );

  if (!status) {
    return (
      <Card>
        <div className="text-sm text-text-muted">{error || "Loading fusion status…"}</div>
      </Card>
    );
  }

  const tierId = status.tier || "daily";
  const installedPack = Object.values(status.packs || {})[0] || null;

  return (
    <Card>
      <div className="flex items-center justify-between gap-2 px-4 sm:px-6 pt-4 sm:pt-5">
        <h2 className="text-lg sm:text-xl font-semibold">Choose Your Setup</h2>
        {tierId ? (
          <Badge size="sm" variant="default">
            {orderTiersForGrid(status.tiers).find((t) => t.id === tierId)?.label || tierId}
          </Badge>
        ) : null}
      </div>
      <p className="px-4 sm:px-6 mt-1 text-sm text-text-muted">
        The base router stays featherlight. Heavy categories hydrate on demand from the
        extension pack — installed, hash-verified, removable.
      </p>

      {error ? <div className="mx-4 sm:mx-6 mt-3 text-sm text-red-500">{error}</div> : null}

      {/* Tier cards — two columns; Ultra Ultimate Max lands exactly below Pro */}
      <div className="grid gap-3 md:grid-cols-2 px-4 sm:px-6 py-4">
        {orderTiersForGrid(status.tiers).map((tier) => (
          <Card
            key={tier.id}
            padding="md"
            className={`cursor-pointer transition-colors ${tierId === tier.id ? "border-2 border-primary" : ""}`}
          >
            <div
              role="button"
              tabIndex={0}
              onClick={() =>
                post({ action: "apply-setup", tier: tier.id, features: tier.id === "pro" ? handPicked : undefined })
              }
              onKeyDown={(e) =>
                e.key === "Enter" &&
                post({ action: "apply-setup", tier: tier.id, features: tier.id === "pro" ? handPicked : undefined })
              }
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
        <div className="px-4 sm:px-6 pb-4">
          <div className="rounded-lg border border-border p-3">
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
                          const base = Array.isArray(prev)
                            ? prev
                            : (status.categories || []).filter((c) => c.defaultOn).map((c) => c.id);
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
              <Button
                size="sm"
                icon="download"
                loading={busy === "install-pack"}
                onClick={() => post({ action: "install-pack", features: handPicked })}
              >
                Install pack
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon="refresh"
                loading={busy === "apply-setup"}
                onClick={() => post({ action: "apply-setup", tier: "pro", features: handPicked })}
              >
                Save picks
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Pack registry */}
      <div className="px-4 sm:px-6 pb-4 sm:pb-5">
        <div className="rounded-lg border border-border p-3">
          <div className="text-sm font-semibold mb-2">Extension pack</div>
          {!installedPack ? (
            <div className="text-xs text-text-muted">
              No pack installed — the base router is featherlight. Pick a tier above; the pack
              installs only when you ask.
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
                  <Badge key={f} size="sm" variant="default">
                    {f}
                  </Badge>
                ))}
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  icon="science"
                  loading={busy === "test-module"}
                  onClick={() => post({ action: "test-module", packId: installedPack.packId })}
                >
                  Test load
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  icon="delete"
                  loading={busy === "remove-pack"}
                  onClick={() => post({ action: "remove-pack", packId: installedPack.packId })}
                >
                  Remove
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
