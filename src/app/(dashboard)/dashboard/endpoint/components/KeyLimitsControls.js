"use client";

// The budget of one API key.
//
// Every key can have its own requests per minute, tokens per minute, tokens
// per day and how many requests may run at the same time. Zero means "no
// limit" - a key without a budget is never slowed down.

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";

const FIELDS = [
  { key: "rpm", label: "Requests / min", hint: "How many requests the key may start in a minute." },
  { key: "tpm", label: "Tokens / min", hint: "How many tokens the key may spend in a minute." },
  { key: "dailyTokens", label: "Tokens / day", hint: "How many tokens the key may spend in a day." },
  { key: "maxConcurrent", label: "At the same time", hint: "How many requests of this key may run at once." },
];

const emptyLimits = { rpm: 0, tpm: 0, dailyTokens: 0, maxConcurrent: 0 };

function describe(limits) {
  const parts = [];
  if (limits.rpm) parts.push(`${limits.rpm} rpm`);
  if (limits.tpm) parts.push(`${limits.tpm.toLocaleString()} tpm`);
  if (limits.dailyTokens) parts.push(`${limits.dailyTokens.toLocaleString()} / day`);
  if (limits.maxConcurrent) parts.push(`${limits.maxConcurrent} at once`);
  return parts.length ? parts.join(" - ") : "no limit";
}

export default function KeyLimitsControls({ apiKey, onChanged }) {
  const [expanded, setExpanded] = useState(false);
  const [limits, setLimits] = useState(emptyLimits);
  const [usage, setUsage] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/key-rate-limits", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const entry = (data.keys || []).find((item) => item.id === apiKey.id);
      if (!entry) return;
      setLimits(entry.usage?.limits || emptyLimits);
      setUsage(entry.usage || null);
    } catch {
      // The card simply stays empty.
    }
  }, [apiKey.id]);

  useEffect(() => {
    if (!expanded) return;
    load();
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, [expanded, load]);

  const save = useCallback(async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/key-rate-limits", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyId: apiKey.id, limits }),
      });
      const data = await res.json();
      if (!res.ok || data?.error) {
        setError(data?.error || "The limits could not be saved.");
        return;
      }
      await load();
      if (onChanged) onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }, [apiKey.id, limits, load, onChanged]);

  const update = (field, value) => {
    const number = Number(value);
    setLimits((current) => ({ ...current, [field]: Number.isFinite(number) && number > 0 ? Math.floor(number) : 0 }));
  };

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex items-center gap-2 text-xs text-text-muted hover:text-primary transition-colors"
      >
        <span className="material-symbols-outlined text-[14px]">speed</span>
        <span>Limits:</span>
        <span className="font-mono text-text-main">{describe(limits)}</span>
        <span className="material-symbols-outlined text-[14px]">
          {expanded ? "expand_less" : "expand_more"}
        </span>
      </button>

      {expanded ? (
        <div className="mt-2 rounded-lg border border-border bg-bg-subtle p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {FIELDS.map((field) => (
              <label key={field.key} className="flex flex-col gap-1 text-xs font-medium text-text-muted">
                {field.label}
                <input
                  type="number"
                  min={0}
                  value={limits[field.key] || 0}
                  onChange={(event) => update(field.key, event.target.value)}
                  title={field.hint}
                  className="rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-text-main outline-none focus:border-primary"
                />
              </label>
            ))}
          </div>

          {usage ? (
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-muted">
              <span>this minute: {usage.requestsThisMinute} requests</span>
              <span>{Number(usage.tokensThisMinute || 0).toLocaleString()} tokens</span>
              <span>today: {Number(usage.tokensToday || 0).toLocaleString()} tokens</span>
              <span>running: {usage.inFlight}</span>
            </div>
          ) : null}

          {error ? <p className="mt-2 text-[11px] text-primary">{error}</p> : null}

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save limits"}
            </button>
            <button
              type="button"
              onClick={() => setLimits(emptyLimits)}
              className="text-xs text-text-muted underline-offset-2 hover:text-text hover:underline"
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

KeyLimitsControls.propTypes = {
  apiKey: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
  }).isRequired,
  onChanged: PropTypes.func,
};
