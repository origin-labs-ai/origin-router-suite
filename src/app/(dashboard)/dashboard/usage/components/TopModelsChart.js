"use client";

import { useState, useMemo, useEffect } from "react";
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
import { modelCategoryName } from "@/shared/utils/modelDisplayName";
import { resolveProviderLabel, buildProviderNameMap } from "@/shared/utils/providerLabel";

const COLORS = ["#6366f1", "#14b8a6", "#f59e0b", "#ef4444", "#8b5cf6"];

const fmtTokens = (n) => {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n || 0);
};

const truncate = (s, max = 22) => (s && s.length > max ? s.slice(0, max) + "…" : s || "");

export default function TopModelsChart({ byModel }) {
  const [viewMode, setViewMode] = useState("tokens");
  // "Provided by" needs the same node-name map the provider chart uses: a
  // compatible provider's real name lives on its node, not the id.
  const [nodeNames, setNodeNames] = useState({});

  useEffect(() => {
    let cancelled = false;
    fetch("/api/provider-nodes", { cache: "no-store" })
      .then((res) => (res.ok ? res.json().catch(() => ({})) : {}))
      .then((data) => {
        if (!cancelled) setNodeNames(buildProviderNameMap(data.nodes));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const chartData = useMemo(() => {
    if (!byModel) return [];
    return Object.values(byModel)
      .map((data) => {
        const raw = data.rawModel || data.model || "Unknown";
        const meta = data.meta || {};
        const provider = meta.provider || data.provider || "";
        return {
          // The axis shows the model's category NAME (deployment noise off),
          // never the raw id.
          name: modelCategoryName(raw) || truncate(raw, 44),
          raw,
          provider,
          providerLabel: provider ? resolveProviderLabel(provider, { nodeNames }) : "",
          tokens: (data.promptTokens || 0) + (data.completionTokens || 0),
          requests: data.requests || 0,
        };
      })
      .filter((d) => d[viewMode] > 0)
      .sort((a, b) => b[viewMode] - a[viewMode])
      .slice(0, 5);
  }, [byModel, viewMode, nodeNames]);

  const fmt = viewMode === "tokens" ? fmtTokens : String;
  const label = viewMode === "tokens" ? "Tokens" : "Requests";

  return (
    <Card className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-text-muted uppercase tracking-wide">Top Models</span>
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
        <div className="h-44 flex items-center justify-center text-text-muted text-sm">No model usage yet</div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
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
              width={168}
              tick={(props) => {
                // Recharts won't ellipsize, so cut to the axis width ourselves.
                const { x, y, payload } = props;
                const label = String(payload?.value || "");
                const max = 26;
                const text = label.length > max ? `${label.slice(0, max - 1)}…` : label;
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
              contentStyle={{
                backgroundColor: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                fontSize: "12px",
              }}
              formatter={(value, _name, item) => {
                const row = item?.payload || {};
                const lines = [[fmt(value), label]];
                // Provided by: the provider that actually served this model,
                // under its own name — the same label the provider chart uses.
                if (row.providerLabel) lines.push([row.providerLabel, "Provided by"]);
                else if (row.provider) lines.push([row.provider, "Provided by"]);
                return lines;
              }}
            />
            <Bar dataKey={viewMode} radius={[0, 4, 4, 0]}>
              {chartData.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} fillOpacity={0.85} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

TopModelsChart.propTypes = {
  byModel: PropTypes.object,
};
