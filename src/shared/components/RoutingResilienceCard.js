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
    key: "hopBackoffMs",
    label: "Rest between hops (ms)",
    help: "Base pause before each extra failover hop, jittered per agent. Keeps eight concurrent sessions from hammering the whole fleet in the same millisecond. 0 disables.",
    min: 0,
    max: 60000,
  },
  {
    key: "failoverDeadlineMs",
    label: "Failover budget (ms)",
    help: "Total time the router may spend finding a seat that answers. 7200000 = 2 hours, so a slow answer is still an answer.",
    min: 1000,
    max: 21600000,
  },
  {
    key: "brainTimeoutMs",
    label: "Brain wait (ms)",
    help: "How long the merged brain may take to decide before whatever already answered is used. A router brain must never delay generation.",
    min: 0,
    max: 60000,
  },
  {
    key: "seatFairnessWindowMs",
    label: "Fairness window (ms)",
    help: "How far back a seat counts as recently used. A seat never picked inside this window is the one the fairness pass promotes.",
    min: 1000,
    max: 86400000,
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
  hopBackoffMs: 250,
  failoverDeadlineMs: 7200000,
  degradeCooldownMs: 45000,
  trimOnPromptCap: false,
  midStreamSilent: true,
  lastResort: "respond",
  routerBrain: "merged",
  jevWeight: 0.45,
  pandaWeight: 0.55,
  brainTimeoutMs: 3500,
  seatFairness: 0.3,
  seatFairnessWindowMs: 900000,
  jevTimeoutMs: 8000,
  explicitModelSticky: true,
  panda: {
    enabled: true,
    baseUrl: "http://127.0.0.1:8765",
    mode: "max_utility",
    minPSuccess: 0.5,
    exploreEpsilon: 0.08,
    decideProvider: true,
    pickFromTopK: 3,
    timeoutMs: 1500,
  },
};

const BRAIN_OPTIONS = [
  {
    value: "merged",
    label: "Merged — Jev + Panda",
    help: "Both brains decide in parallel and their scores are blended into one ranking. When they disagree, the loser\u2019s pick sits right behind the winner as the next hop. Best models get used and reliability stays high.",
  },
  {
    value: "panda",
    label: "Panda only — fallback option",
    help: "PandaOrchestrator ranks the combo seats by calibrated P(success) / cost / latency. Jev is never called, so nothing is spent on a second classifier.",
  },
  {
    value: "jev",
    label: "Jev only — System One",
    help: "System One classifies the task and picks the seat. Panda is not consulted, so the fallback tail is your own seat order plus rotation.",
  },
];

export default function RoutingResilienceCard() {
  const [policy, setPolicy] = useState(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pandaStatus, setPandaStatus] = useState("");
  const [brainStatus, setBrainStatus] = useState("");
  const [message, setMessage] = useState(null);

  const checkPanda = async () => {
    setChecking(true);
    try {
      const res = await fetch("/api/panda/status?refresh=1", { cache: "no-store" });
      const data = await res.json();
      const panda = data.panda?.ready
        ? `Panda online: ${data.detail?.cards ?? "?"} model cards.`
        : `Panda offline (${data.detail || "no response"}).`;
      const jev = data.jev?.ready
        ? `Jev ready via ${data.jev.model}.`
        : `Jev not ready (${data.jev?.detail || "unknown"}).`;
      setBrainStatus(`Active brain: ${data.brain || "?"}. ${panda} ${jev}${data.degraded ? " Running degraded — the router falls back to your seat order plus rotation." : ""}`);
      setPandaStatus(
        data.ok
          ? `Online: ${data.detail?.cards ?? "?"} model cards, ${data.detail?.profiler || ""}.`
          : `Offline (${data.detail || "no response"}) — the router falls back to its own order.`,
      );
    } catch (error) {
      setBrainStatus(`Status unreachable (${error.message})`);
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
            <p className="font-medium text-sm sm:text-base">Close a broken stream silently</p>
            <p className="text-xs sm:text-sm text-text-muted">
              If an answer dies after HTTP 200 (stall or upstream reset), end it with a valid stop frame instead of an error frame.
            </p>
          </div>
          <Toggle
            checked={policy.midStreamSilent !== false}
            onChange={() => patch({ midStreamSilent: !(policy.midStreamSilent !== false) })}
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
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px] text-emerald-500">psychology</span>
            <p className="font-medium text-sm sm:text-base">Router brain</p>
          </div>
          <p className="text-xs sm:text-sm text-text-muted -mt-1">
            Who decides which combo member carries the task. This only ever applies to
            combo targets: a request that names one exact model stays on that model.
          </p>

          <div className="flex flex-col gap-2">
            {BRAIN_OPTIONS.map((option) => {
              const active = (policy.routerBrain || DEFAULTS.routerBrain) === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => patch({ routerBrain: option.value })}
                  disabled={loading || saving}
                  className={`text-left rounded-xl border px-3 py-2.5 transition-colors disabled:opacity-50 ${active
                    ? "border-emerald-500/60 bg-emerald-500/10"
                    : "border-border/60 hover:border-border"}`}
                >
                  <span className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${active ? "bg-emerald-500" : "bg-black/15 dark:bg-white/20"}`} />
                    <span className="text-sm font-medium">{option.label}</span>
                  </span>
                  <span className="block mt-1 ml-[18px] text-xs text-text-muted">{option.help}</span>
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <p className="text-xs font-medium text-text-muted mb-1">Jev weight</p>
              <Input
                type="number"
                step="0.05"
                min="0"
                max="1"
                value={policy.jevWeight ?? DEFAULTS.jevWeight}
                onChange={(e) => patch({ jevWeight: Number(e.target.value) })}
                disabled={loading || saving}
                className="w-full text-center"
              />
            </div>
            <div>
              <p className="text-xs font-medium text-text-muted mb-1">Panda weight</p>
              <Input
                type="number"
                step="0.05"
                min="0"
                max="1"
                value={policy.pandaWeight ?? DEFAULTS.pandaWeight}
                onChange={(e) => patch({ pandaWeight: Number(e.target.value) })}
                disabled={loading || saving}
                className="w-full text-center"
              />
            </div>
            <div>
              <p className="text-xs font-medium text-text-muted mb-1">Seat fairness</p>
              <Input
                type="number"
                step="0.05"
                min="0"
                max="1"
                value={policy.seatFairness ?? DEFAULTS.seatFairness}
                onChange={(e) => patch({ seatFairness: Number(e.target.value) })}
                disabled={loading || saving}
                className="w-full text-center"
              />
            </div>
          </div>
          <p className="text-xs text-text-muted -mt-1">
            Weights are used by &quot;merged&quot; and normalised, so 0.45 / 0.55 and 45 / 55 mean the same.
            Fairness is the share of turns handed to a seat that has not run yet in the window — it is what
            keeps a 66-seat combo from running on three seats while the rest expire unused.
          </p>

          {brainStatus && (
            <p className="text-xs text-text-muted rounded-lg bg-black/[0.03] dark:bg-white/[0.04] px-2.5 py-2">{brainStatus}</p>
          )}

          <Button variant="outline" onClick={checkPanda} loading={checking} disabled={loading}>
            Check brains
          </Button>
        </div>

        <div className="flex items-start sm:items-center justify-between gap-4 pt-3 border-t border-border/50">
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm sm:text-base">An explicit model stays explicit</p>
            <p className="text-xs sm:text-sm text-text-muted">
              Testing one model from the provider page or the playground sends it to that model only
              — no capability adapter swapping it for another model. Combos still route freely.
            </p>
          </div>
          <Toggle
            checked={policy.explicitModelSticky !== false}
            onChange={() => patch({ explicitModelSticky: !(policy.explicitModelSticky !== false) })}
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
