"use client";

// Routing resilience panel — the knobs the router reads on every request
// (src/lib/routingPolicy.js). Kept self-contained: it loads and patches
// `settings.routingPolicy` itself, so the big settings page does not have to
// carry this state.

import { useEffect, useState } from "react";
import { Button, Card, Input, Toggle } from "@/shared/components";

const FIELDS = [
  {
    key: "maxAgentsConcurrency",
    label: "Max agents in flight",
    help: "Concurrent upstream requests the router serves. Extra requests queue briefly instead of failing.",
    min: 1,
    max: 64,
  },
  {
    key: "perConnectionConcurrency",
    label: "Requests per credential",
    help: "How many parallel requests one account may carry before the selector moves to the next one.",
    min: 1,
    max: 32,
  },
  {
    key: "degradeCooldownMs",
    label: "Park a failed seat (ms)",
    help: "How long every concurrent request skips a seat that just refused. This is what stops eight agents re-sweeping the same models from the top.",
    min: 0,
    max: 900000,
  },
  {
    key: "hedgeMs",
    label: "Hedge after (ms)",
    help: "Short requests still silent this long are raced against another provider; the first answer wins. 0 disables.",
    min: 0,
    max: 120000,
  },
  {
    key: "maxFailoverRoutes",
    label: "Failover routes",
    help: "How many other providers one request may walk before the last-resort answer.",
    min: 0,
    max: 64,
  },
  {
    key: "failoverDeadlineMs",
    label: "Failover budget (ms)",
    help: "Total time the router may spend finding a seat that answers.",
    min: 1000,
    max: 900000,
  },
];

const DEFAULTS = {
  enabled: true,
  maxAgentsConcurrency: 8,
  perConnectionConcurrency: 2,
  admissionQueueMs: 20000,
  failoverEnabled: true,
  hedgeMs: 12000,
  hedgeMaxBytes: 65536,
  maxFailoverRoutes: 12,
  failoverDeadlineMs: 150000,
  degradeCooldownMs: 45000,
  trimOnPromptCap: false,
  lastResort: "respond",
  panda: {
    enabled: true,
    baseUrl: "http://127.0.0.1:8765",
    mode: "max_utility",
    minPSuccess: 0.5,
    exploreEpsilon: 0.08,
    decideProvider: true,
    timeoutMs: 1500,
  },
};

export default function RoutingResilienceCard() {
  const [policy, setPolicy] = useState(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pandaStatus, setPandaStatus] = useState("");
  const [message, setMessage] = useState(null);

  const checkPanda = async () => {
    setChecking(true);
    try {
      const res = await fetch("/api/panda/status?refresh=1", { cache: "no-store" });
      const data = await res.json();
      setPandaStatus(
        data.ok
          ? `Online: ${data.detail?.cards ?? "?"} model cards, ${data.detail?.profiler || ""}.`
          : `Offline (${data.detail || "no response"}) — the router falls back to its own order.`,
      );
    } catch (error) {
      setPandaStatus(`Unreachable (${error.message})`);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    let alive = true;
    fetch("/api/settings", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!alive) return;
        setPolicy({ ...DEFAULTS, ...(data?.routingPolicy || {}) });
        setLoading(false);
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = async (next) => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routingPolicy: next }),
      });
      if (!res.ok) throw new Error(`saved failed (${res.status})`);
      const data = await res.json();
      setPolicy({ ...DEFAULTS, ...(data.routingPolicy || next) });
      setMessage({ type: "success", text: "Routing policy applied." });
    } catch (error) {
      setMessage({ type: "error", text: error.message || "Could not save routing policy." });
    } finally {
      setSaving(false);
    }
  };

  const patch = (updates) => save({ ...policy, ...updates });
  const num = (value, fallback) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-500 shrink-0">
          <span className="material-symbols-outlined text-[20px]">route</span>
        </div>
        <h3 className="text-base sm:text-lg font-semibold">Routing resilience</h3>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex items-start sm:items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm sm:text-base">Never surface provider errors</p>
            <p className="text-xs sm:text-sm text-text-muted">
              400 / 401 / 429 / 5xx and timeouts stay inside the router: it rotates accounts,
              then other providers, and answers with a completion.
            </p>
          </div>
          <Toggle
            checked={policy.enabled === true}
            onChange={() => patch({ enabled: !(policy.enabled === true) })}
            disabled={loading || saving}
          />
        </div>

        <div className="flex items-start sm:items-center justify-between gap-4 pt-2 border-t border-border/50">
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm sm:text-base">Failover to other providers</p>
            <p className="text-xs sm:text-sm text-text-muted">
              Same model on another provider is tried when every account of the requested one failed.
            </p>
          </div>
          <Toggle
            checked={policy.failoverEnabled !== false}
            onChange={() => patch({ failoverEnabled: policy.failoverEnabled === false })}
            disabled={loading || saving}
          />
        </div>

        <div className="flex items-start sm:items-center justify-between gap-4 pt-2 border-t border-border/50">
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm sm:text-base">Never trim the prompt</p>
            <p className="text-xs sm:text-sm text-text-muted">
              A seat that cannot take the context is replaced, the conversation is not shortened. Trimming stays off.
            </p>
          </div>
          <Toggle
            checked={policy.trimOnPromptCap === true}
            onChange={() => patch({ trimOnPromptCap: !(policy.trimOnPromptCap === true) })}
            disabled={loading || saving}
          />
        </div>

        <div className="flex flex-col gap-3 pt-3 border-t border-border/50">
          <div className="flex items-start sm:items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm sm:text-base">PandaOrchestrator decides models</p>
              <p className="text-xs sm:text-sm text-text-muted">
                Local task profiler: ranks combo members and provider seats by P(success), cost and latency.
                {pandaStatus ? ` ${pandaStatus}` : ""}
              </p>
            </div>
            <Toggle
              checked={policy.panda?.enabled === true}
              onChange={() => patch({ panda: { ...policy.panda, enabled: !(policy.panda?.enabled === true) } })}
              disabled={loading || saving}
            />
          </div>

          <div className="flex items-start sm:items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm sm:text-base">Also pick the provider seat</p>
              <p className="text-xs sm:text-sm text-text-muted">Order the failover seats for the same model too.</p>
            </div>
            <Toggle
              checked={policy.panda?.decideProvider === true}
              onChange={() => patch({ panda: { ...policy.panda, decideProvider: !(policy.panda?.decideProvider === true) } })}
              disabled={loading || saving}
            />
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <Input
              value={policy.panda?.baseUrl || ""}
              onChange={(e) => patch({ panda: { ...policy.panda, baseUrl: e.target.value } })}
              disabled={loading || saving}
              className="flex-1"
              placeholder="http://127.0.0.1:8765"
            />
            <Button variant="outline" onClick={checkPanda} loading={checking} disabled={loading}>
              Check orchestrator
            </Button>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm sm:text-base">Mode</p>
              <p className="text-xs sm:text-sm text-text-muted">max_quality is the safest single pick; cheapest_above_threshold trades accuracy for spend.</p>
            </div>
            <select
              value={policy.panda?.mode || "max_utility"}
              onChange={(e) => patch({ panda: { ...policy.panda, mode: e.target.value } })}
              disabled={loading || saving}
              className="w-full sm:w-56 shrink-0 py-2.5 px-3 text-sm bg-surface-2 border border-transparent rounded-[10px] focus:outline-none focus:ring-2 focus:ring-brand-500/30 disabled:opacity-50"
            >
              <option value="max_utility">max_utility (balanced)</option>
              <option value="max_quality">max_quality (safest pick)</option>
              <option value="cheapest_above_threshold">cheapest_above_threshold (bulk easy work)</option>
            </select>
          </div>

          <div className="flex items-start sm:items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm sm:text-base">Explore (0 = never, 0.5 = often)</p>
              <p className="text-xs sm:text-sm text-text-muted">
                Non-greedy picks, so strong cards like GPT-6.1-Sol-Pro get used occasionally instead of always the cheapest plausible model.
              </p>
            </div>
            <Input
              type="number"
              step="0.01"
              min="0"
              max="0.5"
              value={policy.panda?.exploreEpsilon ?? 0.08}
              onChange={(e) => patch({ panda: { ...policy.panda, exploreEpsilon: Number(e.target.value) } })}
              disabled={loading || saving}
              className="w-24 text-center shrink-0"
            />
          </div>
        </div>

        {FIELDS.map((field) => (
          <div key={field.key} className="flex items-start sm:items-center justify-between gap-4 pt-2 border-t border-border/50">
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm sm:text-base">{field.label}</p>
              <p className="text-xs sm:text-sm text-text-muted">{field.help}</p>
            </div>
            <Input
              type="number"
              min={field.min}
              max={field.max}
              value={policy[field.key]}
              onChange={(e) => patch({ [field.key]: num(e.target.value, DEFAULTS[field.key]) })}
              disabled={loading || saving}
              className="w-24 sm:w-28 text-center shrink-0"
            />
          </div>
        ))}

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-2 border-t border-border/50">
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm sm:text-base">When nothing served it</p>
            <p className="text-xs sm:text-sm text-text-muted">
              Last resort after the whole walk is exhausted.
            </p>
          </div>
          <select
            value={policy.lastResort}
            onChange={(e) => patch({ lastResort: e.target.value })}
            disabled={loading || saving}
            className="w-full sm:w-44 shrink-0 py-2.5 px-3 text-sm bg-surface-2 border border-transparent rounded-[10px] focus:outline-none focus:ring-2 focus:ring-brand-500/30 disabled:opacity-50"
          >
            <option value="respond">Answer with a valid completion</option>
            <option value="passthrough">Return the upstream error</option>
          </select>
        </div>

        {message && (
          <p className={`text-xs sm:text-sm pt-2 border-t border-border/50 ${message.type === "error" ? "text-red-500" : "text-green-500"}`}>
            {message.text}
          </p>
        )}

        <Button variant="outline" onClick={() => save(policy)} loading={saving} disabled={loading}>
          Reapply policy
        </Button>
      </div>
    </Card>
  );
}
