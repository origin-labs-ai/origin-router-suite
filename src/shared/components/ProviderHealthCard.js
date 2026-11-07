"use client";

// Provider health - which providers are healthy, degraded or down right now,
// with the latency and the error rate behind that verdict.
//
// The card owns its data: it reads /api/provider-health and lets the reader
// pick the window (24h / 7d) or refresh it by hand.
//
// Naming rule (the owner's): every row carries the name the user actually
// set — a Hand Picked compatible node shows "OrcaRouter", never
// "openai-compatible-chat-…". The icon is the same letter glyph + accent
// color the Providers page uses, so a provider looks like itself everywhere.
//
// Balance rule: the card shows a FIXED number of rows (the worst-offending
// seats first), so Provider Health and Cost Forecast stand side by side at
// the same visual weight. The count is a product default, not a knob.

import { useEffect, useState } from "react";
import Button from "@/shared/components/Button";
import Card from "@/shared/components/Card";
import SegmentedControl from "@/shared/components/SegmentedControl";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { PROVIDER_DISPLAY } from "@/shared/constants/providersDisplay";
import { providerGlyph, providerAccentColor } from "@/shared/utils/providerGlyph";
import { buildProviderNameMap, resolveProviderLabel } from "@/shared/utils/providerLabel";

// Fixed row budget — deliberately not configurable: the card's job is a
// balanced glance next to Cost Forecast, not an exhaustive audit (the
// Providers page and the request log carry the full detail).
const VISIBLE_ROWS = 8;

const WINDOWS = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
];

const DOT_CLASS = {
  healthy: "bg-success",
  degraded: "bg-warning",
  down: "bg-danger",
  idle: "bg-surface-3",
  unknown: "bg-border",
};

const STATUS_LABEL = {
  healthy: "Healthy",
  degraded: "Degraded",
  down: "Down",
  idle: "Idle",
  unknown: "Unknown",
};

const STATUS_RANK = { down: 0, degraded: 1, healthy: 2, idle: 3, unknown: 4 };

const SUMMARY_ORDER = ["healthy", "degraded", "down", "idle", "unknown"];

function formatLatency(ms) {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function formatErrorRate(rate) {
  if (!rate) return "0%";
  const percent = rate * 100;
  if (percent < 1) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

function formatLastUsed(timestamp) {
  if (!timestamp) return "never";
  const time = new Date(timestamp).getTime();
  if (Number.isNaN(time)) return "never";
  const diff = Date.now() - time;
  if (diff < 60000) return "just now";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function ProviderHealthCard() {
  const [window, setWindow] = useState("24h");
  const [reloadKey, setReloadKey] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Node names: a compatible node's user-set name lives here, not in the id.
  const [nodeNames, setNodeNames] = useState({});

  useEffect(() => {
    let cancelled = false;
    fetch("/api/provider-nodes", { cache: "no-store" })
      .then((res) => (res.ok ? res.json().catch(() => ({})) : {}))
      .then((json) => {
        if (!cancelled) setNodeNames(buildProviderNameMap(json.nodes));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/provider-health?window=${window}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("failed"))))
      .then((json) => {
        if (cancelled) return;
        setData(json);
        setError(false);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => { cancelled = true; };
  }, [window, reloadKey]);

  // The spinner is set by the click that starts the load, not by the effect.
  const handleWindowChange = (value) => {
    setWindow(value);
    setRefreshing(true);
  };

  const handleRefresh = () => {
    setReloadKey((key) => key + 1);
    setRefreshing(true);
  };

  const nameFor = (entry) =>
    resolveProviderLabel(entry.provider, {
      nodeNames,
      fallback: entry.name || entry.provider,
    });

  if (!data) {
    if (error) {
      return (
        <Card className="flex min-w-0 flex-col gap-2 p-3 sm:p-4">
          <span className="text-sm font-semibold uppercase tracking-wide text-text-muted">Provider health</span>
          <p className="text-xs text-text-muted">The health report could not be loaded.</p>
        </Card>
      );
    }
    return (
      <Card className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
        <span className="text-sm font-semibold uppercase tracking-wide text-text-muted">Provider health</span>
        <div className="h-20 animate-pulse rounded-lg bg-surface-2" />
      </Card>
    );
  }

  const allProviders = data.providers || [];
  // Worst first: down, then degraded, then by request volume. Idle seats sink.
  const providers = [...allProviders]
    .sort((a, b) => {
      const rankDiff = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
      if (rankDiff !== 0) return rankDiff;
      return (b.requests || 0) - (a.requests || 0);
    })
    .slice(0, VISIBLE_ROWS);
  const hiddenCount = Math.max(0, allProviders.length - VISIBLE_ROWS);
  const summary = data.summary || {};

  return (
    <Card className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold uppercase tracking-wide text-text-muted">Provider health</span>
        <div className="flex items-center gap-2">
          <SegmentedControl
            options={WINDOWS}
            value={window}
            onChange={handleWindowChange}
            size="sm"
          />
          <Button
            variant="ghost"
            size="xs"
            icon="refresh"
            onClick={handleRefresh}
            loading={refreshing}
            aria-label="Refresh provider health"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {SUMMARY_ORDER.map((status) => (
          <span
            key={status}
            className="flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface-2 px-2.5 py-1 text-[11px]"
          >
            <span className={`h-1.5 w-1.5 rounded-full ${DOT_CLASS[status]}`} />
            <span className="text-text-muted">{STATUS_LABEL[status]}</span>
            <span className="font-semibold tabular-nums text-text-main">{summary[status] || 0}</span>
          </span>
        ))}
      </div>

      {providers.length === 0 ? (
        <p className="text-xs text-text-muted">
          No provider traffic in this window. Connect a provider and send a request - it shows up here.
        </p>
      ) : (
        <div className="flex min-w-0 flex-col gap-1.5">
          {providers.map((entry) => {
            const name = nameFor(entry);
            return (
              <div
                key={entry.provider}
                className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border-subtle bg-bg px-3 py-2"
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[entry.status] || DOT_CLASS.unknown}`}
                  title={STATUS_LABEL[entry.status] || entry.status}
                />
                {/* The glyph + accent the Providers page uses — an icon-less
                    provider renders as its own letter, never a foreign logo
                    or a two-letter id chip. */}
                <ProviderIcon
                  alt={name}
                  size={18}
                  className="h-[18px] w-[18px] shrink-0 rounded object-contain"
                  fallbackText={providerGlyph(name)}
                  fallbackColor={providerAccentColor(entry.provider)}
                />
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate text-sm font-medium text-text-main" title={name}>
                    {name}
                  </span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-text-muted">
                    {STATUS_LABEL[entry.status] || entry.status}
                  </span>
                </span>

                <span className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] tabular-nums text-text-muted">
                  <span title="Requests in this window">{entry.requests} req</span>
                  <span title="Error rate" className={entry.errors ? "text-danger" : undefined}>
                    {formatErrorRate(entry.errorRate)} err
                  </span>
                  <span title="Average latency">avg {formatLatency(entry.avgLatencyMs)}</span>
                  <span title="95th percentile latency">p95 {formatLatency(entry.p95LatencyMs)}</span>
                  <span title="Last used">{formatLastUsed(entry.lastUsedAt)}</span>
                </span>

                {entry.lastError ? (
                  <span className="w-full truncate text-[11px] text-danger" title={entry.lastError}>
                    {entry.lastError}
                  </span>
                ) : null}
              </div>
            );
          })}
          {hiddenCount > 0 ? (
            <p className="text-[11px] text-text-muted">
              +{hiddenCount} more provider{hiddenCount === 1 ? "" : "s"} in this window — the full list lives on the Providers page.
            </p>
          ) : null}
        </div>
      )}

      <p className="text-[11px] text-text-muted">
        Latency comes from the request log, so it is only there when request logging is on.
      </p>
    </Card>
  );
}
