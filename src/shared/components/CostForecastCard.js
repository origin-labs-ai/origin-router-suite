"use client";

import { useEffect, useState } from "react";
import Card from "@/shared/components/Card";
import { buildProviderNameMap, resolveProviderLabel } from "@/shared/utils/providerLabel";

function money(value) {
  const number = Number(value) || 0;
  if (number === 0) return "$0.00";
  if (number < 0.01) return "<$0.01";
  if (number < 100) return `$${number.toFixed(2)}`;
  return `$${number.toFixed(0)}`;
}

function Stat({ label, value, hint }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-bg-subtle px-3 py-2">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">{label}</span>
      <span className="text-lg font-semibold">{value}</span>
      {hint ? <span className="truncate text-[11px] text-text-muted">{hint}</span> : null}
    </div>
  );
}

export default function CostForecastCard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  // The spend breakdown's provider rows must carry the name the user set —
  // a compatible node's real name lives on its node, not the raw id.
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
    fetch("/api/usage/forecast", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("failed"))))
      .then((json) => { if (!cancelled) setData(json); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, []);

  const nameFor = (entry) =>
    resolveProviderLabel(entry.provider || entry.name, {
      nodeNames,
      fallback: entry.name,
    });

  if (error) return null;
  if (!data) {
    return (
      <Card className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
        <span className="text-sm font-semibold uppercase tracking-wide text-text-muted">Cost forecast</span>
        <div className="h-20 animate-pulse rounded-lg bg-bg-subtle" />
      </Card>
    );
  }

  const { totals, forecast, byProvider, coverage } = data;
  const spend = totals.last30.cost;
  const freeShare = coverage.requests ? Math.round((coverage.freeRequests / coverage.requests) * 100) : 0;

  return (
    <Card className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-semibold uppercase tracking-wide text-text-muted">Cost forecast</span>
        <span className="text-[11px] text-text-muted">
          {forecast.daysLeftInMonth} day{forecast.daysLeftInMonth === 1 ? "" : "s"} left in the month
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Today" value={money(totals.today.cost)} hint={`${totals.today.requests} requests`} />
        <Stat label="Last 7 days" value={money(totals.last7.cost)} hint={`${totals.last7.requests} requests`} />
        <Stat label="Last 30 days" value={money(totals.last30.cost)} hint={`${totals.last30.requests} requests`} />
        <Stat label="Month to date" value={money(forecast.monthToDate)} hint="spent so far" />
        <Stat
          label="Projected month end"
          value={money(forecast.projectedMonthEnd)}
          hint={`at ${money(forecast.averageDailyCost)}/day`}
        />
      </div>

      {byProvider.length ? (
        <div className="flex flex-col gap-1.5">
          {byProvider.slice(0, 5).map((entry) => {
            const share = spend > 0 ? Math.round((entry.cost / spend) * 100) : 0;
            const label = nameFor(entry);
            return (
              <div key={entry.name} className="flex items-center gap-2 text-xs">
                <span className="w-32 shrink-0 truncate text-text-muted" title={label}>{label}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-subtle">
                  <span
                    className="block h-full rounded-full bg-primary"
                    style={{ width: `${Math.max(share, 1)}%` }}
                  />
                </span>
                <span className="w-20 shrink-0 text-right tabular-nums">{money(entry.cost)}</span>
                <span className="w-10 shrink-0 text-right tabular-nums text-text-muted">{share}%</span>
              </div>
            );
          })}
        </div>
      ) : null}

      <p className="text-[11px] text-text-muted">
        {coverage.freeRequests} of {coverage.requests} requests ran on free tiers - they used
        tokens, not money. Prices come from the provider catalogue; change them in
        Settings → Pricing if a provider bills differently for you.
      </p>
      {freeShare > 0 ? null : null}
    </Card>
  );
}
