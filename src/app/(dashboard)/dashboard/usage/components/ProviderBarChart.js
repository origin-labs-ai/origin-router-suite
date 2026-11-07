"use client";

import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import Card from "@/shared/components/Card";
import { buildProviderNameMap, resolveProviderLabel } from "@/shared/utils/providerLabel";

const COLORS = ["#6366f1", "#14b8a6", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#10b981", "#2B7FFF"];

const compact = (n) => {
  const value = Number(n) || 0;
  if (value >= 1000000000) return `${(value / 1000000000).toFixed(1)}B`;
  if (value >= 1000000) return `${(value / 1000000000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
};

// Hovering a bar tells the user which provider it is and what it cost.
function ProviderTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div
      className="rounded-lg border border-border px-3 py-2 text-xs shadow-lg"
      style={{ backgroundColor: "var(--color-bg)" }}
    >
      <div className="font-semibold">{row.name}</div>
      <div className="mt-1 flex items-center gap-3 text-text-muted">
        <span>
          Tokens{" "}
          <span className="tabular-nums text-text">{Number(row.tokens || 0).toLocaleString()}</span>
        </span>
        <span>
          Requests{" "}
          <span className="tabular-nums text-text">{Number(row.requests || 0).toLocaleString()}</span>
        </span>
      </div>
    </div>
  );
}

ProviderTooltip.propTypes = {
  active: PropTypes.bool,
  payload: PropTypes.array,
};

export default function ProviderBarChart({ byProvider }) {
  const [viewMode, setViewMode] = useState("tokens");
  // Custom compatible providers are keyed by a generated id; only the node /
  // connection carries the name the user typed.
  const [nodeNames, setNodeNames] = useState({});
  const [connectionByProvider, setConnectionByProvider] = useState({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [nodesRes, providersRes] = await Promise.all([
          fetch("/api/provider-nodes", { cache: "no-store" }),
          fetch("/api/providers", { cache: "no-store" }),
        ]);
        const nodesData = nodesRes.ok ? await nodesRes.json().catch(() => ({})) : {};
        const providersData = providersRes.ok ? await providersRes.json().catch(() => ({})) : {};
        if (cancelled) return;
        const byProviderMap = {};
        for (const connection of providersData.connections || []) {
          if (connection?.provider && !byProviderMap[connection.provider]) {
            byProviderMap[connection.provider] = connection;
          }
        }
        setNodeNames(buildProviderNameMap(nodesData.nodes));
        setConnectionByProvider(byProviderMap);
      } catch {
        // Labels fall back to the id — usage still renders.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const chartData = useMemo(() => {
    if (!byProvider) return [];
    const rows = Object.entries(byProvider).map(([id, data]) => {
      const tokens = (data.promptTokens || 0) + (data.completionTokens || 0);
      const requests = data.requests || 0;
      return {
        id,
        name: resolveProviderLabel(id, {
          nodeNames,
          connection: connectionByProvider[id],
        }),
        tokens,
        requests,
        value: viewMode === "tokens" ? tokens : requests,
      };
    });
    return rows.sort((a, b) => b.value - a.value).slice(0, 8);
  }, [byProvider, viewMode, nodeNames, connectionByProvider]);

  const fmt = viewMode === "tokens" ? compact : String;
  const label = viewMode === "tokens" ? "Tokens" : "Requests";

  return (
    <Card className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
      {/* The title its sibling chart always had — the two cards read as a pair. */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-text-muted uppercase tracking-wide">By Providers</span>
        <div className="grid grid-cols-2 items-center gap-1 rounded-lg border border-border bg-bg-subtle p-1">
          <button
            onClick={() => setViewMode("tokens")}
            className={`px-2.5 py-0.5 rounded-md text-xs font-medium transition-colors ${viewMode === "tokens" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
          >
            Tokens
          </button>
          <button
            onClick={() => setViewMode("requests")}
            className={`px-2.5 py-0.5 rounded-md text-xs font-medium transition-colors ${viewMode === "requests" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
          >
            Requests
          </button>
        </div>
      </div>

      {!chartData.length ? (
        <div className="h-44 flex items-center justify-center text-text-muted text-sm">No provider usage yet</div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          {/* Horizontal bars with the provider's own name on the left — the
              same shape as Top Models, so the pair reads as one system.
              Vertical anonymous columns made the chart unreadable. */}
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 4, right: 28, left: 4, bottom: 4 }}
          >
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} horizontal={false} />
            <XAxis
              type="number"
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={fmt}
            />
            <YAxis
              type="category"
              dataKey="name"
              tickLine={false}
              axisLine={false}
              interval={0}
              width={150}
              tick={(props) => {
                // Recharts won't ellipsize, so cut to the axis width ourselves.
                const { x, y, payload } = props;
                const text0 = String(payload?.value || "");
                const max = 20;
                const text = text0.length > max ? `${text0.slice(0, max - 1)}…` : text0;
                return (
                  <text
                    x={x - 6}
                    y={y}
                    dy={3}
                    textAnchor="end"
                    fontSize={10}
                    fill="currentColor"
                    fillOpacity={0.75}
                  >
                    {text}
                  </text>
                );
              }}
            />
            <Tooltip
              content={<ProviderTooltip />}
              cursor={{ fill: "var(--color-bg-hover)", fillOpacity: 0.25 }}
            />
            <Bar dataKey={viewMode} radius={[0, 4, 4, 0]} minPointSize={3}>
              {chartData.map((row, i) => (
                <Cell
                  key={row.id || i}
                  fill={COLORS[i % COLORS.length]}
                  fillOpacity={0.85}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

ProviderBarChart.propTypes = {
  byProvider: PropTypes.object,
};
