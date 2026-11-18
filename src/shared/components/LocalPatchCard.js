"use client";

// Local patch — the dashboard half of `npm run patch:local` / `or patch`.
//
// The repo registers a built bundle; this card shows whether the installed
// bundle is on it, how many requests are in flight, and triggers the swap. The
// request is refused on a remote dashboard (the route is local-only), so the
// card explains that instead of failing silently.

import { useCallback, useEffect, useState } from "react";
import { Button, Card } from "@/shared/components";
import { cn } from "@/shared/utils/cn";

const POLL_BUSY_MS = 4000;
const POLL_PATCH_MS = 1500;

function Badge({ tone, children }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold border",
        tone === "ok" && "bg-green-500/10 text-green-600 border-green-500/30",
        tone === "warn" && "bg-amber-500/10 text-amber-600 border-amber-500/30",
        tone === "busy" && "bg-brand-500/10 text-brand-500 border-brand-500/30",
        tone === "muted" && "bg-surface-2 text-text-muted border-border",
      )}
    >
      {children}
    </span>
  );
}

export default function LocalPatchCard({ className }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [force, setForce] = useState(false);
  const [patching, setPatching] = useState(false);
  const [notice, setNotice] = useState({ tone: "", text: "" });

  const applyState = useCallback((result) => {
    if (!result) return null;
    if (result.status === 403) {
      setState({ localOnly: true, message: result.data.message, targets: [] });
      setError("");
    } else if (result.status !== 200) {
      setError(result.data.message || `Gateway answered ${result.status}`);
    } else {
      setState(result.data);
      setError("");
    }
    setLoading(false);
    return result.data;
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/version/patch", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      return applyState({ status: res.status, data });
    } catch (err) {
      setError(err.message || "Gateway is unreachable");
      setLoading(false);
      return null;
    }
  }, [applyState]);

  // Initial read: state lands in a promise callback, never synchronously in the
  // effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/version/patch", { cache: "no-store" })
      .then(async (res) => ({ status: res.status, data: await res.json().catch(() => ({})) }))
      .then((result) => {
        if (!cancelled) applyState(result);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || "Gateway is unreachable");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyState]);

  // While requests are in flight the count is the interesting number; outside a
  // patch there is no reason to poll faster than that.
  useEffect(() => {
    if (patching || !state?.busy) return undefined;
    const timer = setInterval(load, POLL_BUSY_MS);
    return () => clearInterval(timer);
  }, [patching, state?.busy, load]);

  const waitForRestart = useCallback(async () => {
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_PATCH_MS));
      const data = await load();
      const phase = data?.status?.phase;
      if (phase === "healthy") {
        setPatching(false);
        setNotice({ tone: "ok", text: "Patched. Reload the dashboard to run the new build." });
        return;
      }
      if (phase === "rolled-back" || phase === "failed") {
        setPatching(false);
        setNotice({ tone: "error", text: data.status.message || "The patch was rolled back." });
        return;
      }
    }
    setPatching(false);
    setNotice({ tone: "error", text: "The patch did not report back. Check the console log or ~/.or/patch/patch.log." });
  }, [load]);

  const startPatch = async () => {
    setNotice({ tone: "", text: "" });
    setPatching(true);
    try {
      const res = await fetch("/api/version/patch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        setPatching(false);
        setNotice({ tone: "warn", text: data.message || "Requests are in flight — retry when idle." });
        return;
      }
      if (!res.ok) {
        setPatching(false);
        setNotice({ tone: "error", text: data.message || `Patch refused (${res.status})` });
        return;
      }
      if (data.upToDate) {
        setPatching(false);
        setNotice({ tone: "ok", text: data.message || "Already on the registered build." });
        return;
      }
      setNotice({ tone: "busy", text: "Restarting on the new build…" });
      await waitForRestart();
    } catch {
      // The gateway exits mid-request by design; that is not an error.
      await waitForRestart();
    }
  };

  const targets = state?.targets || [];
  const pending = targets.filter((target) => !target.current);
  const localOnly = state?.localOnly === true;
  const canPatch = state?.canPatch === true;
  const busy = state?.busy === true;
  const disabled = loading || patching || localOnly || !canPatch || (busy && !force);

  return (
    <Card
      title="Local build patch"
      subtitle="Apply a bundle you built in the repo — no installer, no manual copy"
      icon="system_update_alt"
      className={className}
    >
      <div className="flex flex-col gap-4">
        {localOnly ? (
          <p className="text-sm text-text-muted">
            {state.message || "Local patches can only be applied from the machine running the gateway."}
          </p>
        ) : (
          <>
            {loading && <p className="text-sm text-text-muted">Reading patch state…</p>}
            {error && !loading && <p className="text-sm text-red-500">{error}</p>}

            {!loading && !error && !canPatch && (
              <p className="text-sm text-text-muted">
                No bundle registered yet. In the repo run{" "}
                <code className="rounded bg-surface-2 px-1.5 py-0.5 text-[12px]">npm run patch:local -- --no-restart</code>{" "}
                once, then come back here.
              </p>
            )}

            {canPatch && (
              <>
                <div className="rounded-[10px] border border-border bg-bg/60 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-text-main">
                      {state.source.version ? `v${state.source.version}` : "unversioned build"}
                    </span>
                    {state.source.buildId && <Badge tone="muted">build {state.source.buildId.slice(0, 8)}</Badge>}
                    {state.source.commit && <Badge tone="muted">{state.source.commit}</Badge>}
                    {busy ? (
                      <Badge tone="busy">{state.inFlight} in flight</Badge>
                    ) : (
                      <Badge tone="ok">idle</Badge>
                    )}
                  </div>
                  <p className="mt-2 break-all text-[12px] text-text-muted">{state.source.bundle}</p>
                  {state.source.builtAt && (
                    <p className="text-[12px] text-text-muted">
                      built {new Date(state.source.builtAt).toLocaleString()}
                      {state.source.registeredAt ? ` · registered ${new Date(state.source.registeredAt).toLocaleString()}` : ""}
                    </p>
                  )}
                </div>

                {targets.length > 0 && (
                  <ul className="flex flex-col gap-2">
                    {targets.map((target) => (
                      <li key={target.appDir} className="flex flex-wrap items-center gap-2 text-sm">
                        <Badge tone={target.current ? "ok" : "warn"}>{target.current ? "current" : "stale"}</Badge>
                        <span className="font-medium text-text-main">{target.label}</span>
                        <span className="break-all text-[12px] text-text-muted">{target.appDir}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}

            {state?.status?.phase && (
              <p className="text-[12px] text-text-muted">
                last run: <span className="font-semibold">{state.status.phase}</span>
                {state.status.message ? ` — ${state.status.message}` : ""}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="secondary"
                icon="bolt"
                loading={patching}
                disabled={disabled}
                onClick={startPatch}
              >
                {patching ? "Patching…" : pending.length ? `Patch ${pending.length} target${pending.length > 1 ? "s" : ""}` : "Re-apply build"}
              </Button>
              {busy && (
                <label className="flex items-center gap-2 text-sm text-text-muted">
                  <input
                    type="checkbox"
                    checked={force}
                    onChange={(event) => setForce(event.target.checked)}
                    className="h-4 w-4 accent-brand-500"
                  />
                  Patch anyway ({state.inFlight} request{state.inFlight === 1 ? "" : "s"} will be cut)
                </label>
              )}
            </div>

            <p className="text-[12px] text-text-muted">
              The gateway restarts. “Stale” means the target is not on the registered build yet; a patch keeps{" "}
              <code className="rounded bg-surface-2 px-1 py-0.5">.env</code> and never touches your data folder.
            </p>
          </>
        )}

        {notice.text && (
          <p
            className={cn(
              "text-sm",
              notice.tone === "ok" && "text-green-600",
              notice.tone === "warn" && "text-amber-600",
              notice.tone === "error" && "text-red-500",
              notice.tone === "busy" && "text-brand-500",
            )}
          >
            {notice.text}
            {notice.tone === "ok" && (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="ml-2 font-semibold underline underline-offset-2"
              >
                Reload
              </button>
            )}
          </p>
        )}
      </div>
    </Card>
  );
}
