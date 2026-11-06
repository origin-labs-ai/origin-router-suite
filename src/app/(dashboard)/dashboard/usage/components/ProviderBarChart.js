"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import {
  BarChart,
  Bar,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import Card from "@/shared/components/Card";
import { buildProviderNameMap, resolveProviderLabel } from "@/shared/utils/providerLabel";
import { CHART_GEOMETRY, LABEL_FONT_SIZE, layoutValueLabels } from "@/lib/chartLabels";

const COLORS = ["#6366f1", "#14b8a6", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#10b981", "#2B7FFF"];

const { height: CHART_HEIGHT, margin: MARGIN, yAxisWidth: Y_AXIS_WIDTH, barCategoryGap: BAR_CATEGORY_GAP } = CHART_GEOMETRY;

const compact = (n) => {
  const value = Number(n) || 0;
  if (value >= 1000000000) return `${(value / 1000000000).toFixed(1)}B`;
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
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

  const wrapRef = useRef(null);
  const [width, setWidth] = useState(0);
  const [fontFamily, setFontFamily] = useState("");

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

  useLayoutEffect(() => {
    const element = wrapRef.current;
    if (!element) return undefined;
    const update = () => {
      const next = element.clientWidth;
      setWidth((current) => (current === next ? current : next));
      const family = window.getComputedStyle(element).fontFamily;
      setFontFamily((current) => (current === family ? current : family));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
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
    return rows.sort((a, b) => b.value - a.value);
  }, [byProvider, viewMode, nodeNames, connectionByProvider]);

  const maxValue = useMemo(
    () => chartData.reduce((max, row) => Math.max(max, row.value || 0), 0),
    [chartData]
  );

  const labels = useMemo(
    () =>
      layoutValueLabels(
        chartData.map((row, index) => ({ index, value: row.value, label: compact(row.value) })),
        { width, fontFamily, maxValue }
      ),
    [chartData, width, fontFamily, maxValue]
  );

  return (
    <Card className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
      <div className="flex items-center justify-end gap-2">
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
        <div ref={wrapRef} data-testid="provider-bar-chart" className="relative w-full" style={{ height: CHART_HEIGHT }}>
          <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
            <BarChart
              data={chartData}
              margin={MARGIN}
              barCategoryGap={`${BAR_CATEGORY_GAP * 100}%`}
            >
              <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} vertical={false} />
              <YAxis
                domain={[0, (maxValue || 1) * 1.15]}
                tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={compact}
                width={Y_AXIS_WIDTH}
              />
              <Tooltip
                content={<ProviderTooltip />}
                cursor={{ fill: "var(--color-bg-hover)", fillOpacity: 0.25 }}
              />
              <Bar
                dataKey="value"
                radius={[4, 4, 0, 0]}
                isAnimationActive={false}
                // A provider with no usage still gets a sliver on the baseline,
                // so it reads as "connected but idle" rather than "missing".
                minPointSize={3}
              >
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

          {/* The values sit above their own bar; the layout pass above keeps
              them from covering each other. */}
          <div className="pointer-events-none absolute inset-0 select-none" aria-hidden="true">
            {labels.map((label, index) => (
              <span
                key={chartData[index]?.id || index}
                className="absolute whitespace-nowrap tabular-nums"
                style={{
                  left: `${label.x}px`,
                  top: `${label.y}px`,
                  transform: "translate(-50%, -100%)",
                  fontSize: `${LABEL_FONT_SIZE}px`,
                  lineHeight: `${LABEL_FONT_SIZE}px`,
                  color: "currentColor",
                  opacity: 0.7,
                }}
              >
                {label.text}
              </span>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

ProviderBarChart.propTypes = {
  byProvider: PropTypes.object,
};
